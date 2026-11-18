import { rooms } from '@point/shared';
import { newId } from '../../../core/crypto/ids.js';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { registerTxPlanner, unregisterTxPlanner, type TxPlanner } from '../../../core/db/tx-planners.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { custodyRepublishesTaskCard, loadTaskCard, loadTaskView } from '../../tickets-custody/index.js';
import { loadDriverLives, loadOfferCards } from './cards.js';

type Env = EventEnvelope<Record<string, any>>;
type Aggregate = { type: string; id: string; version: number | null } | null;

/** A message to plan at the end of the transaction, built from the final state (11 §1.6: fresh read). */
type Intent =
  | {
      kind: 'offer_card';
      event: 'task.offered' | 'task.broadcast';
      offerId: string;
      userIds: string[];
      env: Env;
    }
  | { kind: 'task_card'; taskId: string; userId: string; env: Env }
  /** RT-2: the TaskCard of the open task's current assignee (resolved at flush) + the Task to the supervisors */
  | { kind: 'assignee_card'; taskId: string | null; ticketId: string; env: Env }
  | { kind: 'task_view'; taskId: string; rooms: string[]; hideAssignee: boolean; env: Env }
  | {
      kind: 'plain';
      event: string;
      rooms: string[];
      data: Record<string, unknown>;
      aggregate: Aggregate;
      env: Env;
    };

type PlannedIntent = Exclude<Intent, { kind: 'assignee_card' }>;

interface DriverChange {
  rooms: Set<string>;
  env: Env;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x : str(x?.user_id))).filter((x): x is string => !!x)
    : [];

/** The event types this planner turns into messages (07 §4.3, 11 §8.3–§8.6, §9.2). */
const HANDLED: ReadonlySet<string> = new Set([
  'task.created',
  'task.offered',
  'task.broadcast_opened',
  'task.broadcast_extended',
  'task.claimed',
  'task.promoted',
  'task.key_picked_up',
  'task.started',
  'task.completed',
  'task.canceled',
  'task.withdrawn',
  'task.reassigned',
  'offer.reminded',
  'offer.expired',
  'offer.revoked',
  'driver.duty_started',
  'driver.break_started',
  'driver.break_ended',
  'driver.duty_ended',
  'driver.availability_changed',
  'driver.connection_changed',
  'driver.transfer_requested',
  'driver.transfer_blocked',
  'driver.transferred',
  'driver.disabled',
  'driver.enabled',
  'custody.changed',
  'ticket.reparking',
  'payment.waived',
  'payment.reversed',
  // V2-022 (DEC-522): paid in the app, or that payment refunded in full before the handover
  'payment.online_paid',
  'payment.online_refunded',
]);

class Plan {
  private readonly intents: Intent[] = [];
  private readonly keys = new Map<string, number>();
  private readonly drivers = new Map<string, DriverChange>();
  private readonly syncs = new Map<string, { env: Env; reason: string }>();
  /** users whose sessions this transaction revokes (transfer, disable): session.revoked replaces their own messages */
  private readonly revoked = new Set<string>();

  constructor(private readonly tx: Tx) {}

  /** Same key in one transaction → one message with the latest cause, at the position of the first. */
  private add(key: string | null, intent: Intent) {
    if (key) {
      const i = this.keys.get(key);
      if (i !== undefined) {
        this.intents[i] = intent;
        return;
      }
      this.keys.set(key, this.intents.length);
    }
    this.intents.push(intent);
  }

  private supervisors(env: Env, venueId?: string | null): string[] {
    const v = venueId ?? env.venue_id;
    return v ? [rooms.venueSupervisors(v)] : [];
  }

  private taskCard(env: Env, taskId: string | null, userId: string | null) {
    if (taskId && userId) this.add(`card:${taskId}:${userId}`, { kind: 'task_card', taskId, userId, env });
  }

  private taskView(env: Env, taskId: string | null, to: string[], hideAssignee = false, keyRoom?: string) {
    if (!taskId || !to.length) return;
    this.add(`view:${taskId}:${keyRoom ?? to.join(',')}`, {
      kind: 'task_view',
      taskId,
      rooms: to,
      hideAssignee,
      env,
    });
  }

  private driver(userId: string | null, env: Env, to: string[]) {
    if (!userId) return;
    const d = this.drivers.get(userId) ?? { rooms: new Set<string>(), env };
    for (const r of to) d.rooms.add(r);
    d.env = env;
    this.drivers.set(userId, d);
  }

  handle(ev: Env): void {
    const p = ev.payload ?? {};
    const taskId = str(p.task_id);
    const sup = this.supervisors(ev);
    switch (ev.type) {
      case 'task.created':
        this.taskView(ev, taskId, sup);
        return;
      case 'task.offered': {
        const offerId = str(p.offer_id);
        const to = str(p.recipient_id);
        if (offerId && to)
          this.add(`offer:${offerId}:${to}`, {
            kind: 'offer_card',
            event: 'task.offered',
            offerId,
            userIds: [to],
            env: ev,
          });
        this.taskView(ev, taskId, sup);
        return;
      }
      case 'task.broadcast_opened':
      case 'task.broadcast_extended': {
        const offerId = str(p.offer_id);
        const to = strs(ev.type === 'task.broadcast_opened' ? p.recipients : p.added);
        if (offerId && to.length)
          this.add(`broadcast:${offerId}:${to.join(',')}`, {
            kind: 'offer_card',
            event: 'task.broadcast',
            offerId,
            userIds: to,
            env: ev,
          });
        this.taskView(ev, taskId, sup);
        return;
      }
      case 'task.claimed': {
        // the winner's card first: his client then ignores task.claimed (same task version, 07 §4.5)
        this.taskCard(ev, taskId, str(p.claimed_by));
        const pool = ev.dispatch_pool_id;
        this.add(null, {
          kind: 'plain',
          event: 'task.claimed',
          rooms: [...(pool ? [rooms.poolDrivers(pool)] : []), ...sup],
          data: {
            cause: 'task.claimed',
            task_id: taskId,
            offer_ids: [str(p.offer_id)].filter(Boolean),
            result: p.result,
            claimed_by: { id: str(p.claimed_by) },
          },
          aggregate: ev.aggregate,
          env: ev,
        });
        return;
      }
      case 'task.promoted':
      case 'task.key_picked_up':
      case 'task.started':
      case 'task.completed':
      case 'task.canceled':
        this.taskCard(ev, taskId, str(p.assignee_id));
        this.taskView(ev, taskId, sup);
        return;
      case 'task.withdrawn': {
        const from = str(p.from_assignee_id);
        if (from) this.taskView(ev, taskId, [rooms.user(from)], true);
        this.taskView(ev, taskId, sup);
        return;
      }
      case 'task.reassigned': {
        const from = str(p.from_assignee_id);
        const to = str(p.to_assignee_id);
        if (from && from !== to) this.taskView(ev, taskId, [rooms.user(from)], true);
        this.taskCard(ev, taskId, to);
        this.taskView(ev, taskId, sup);
        return;
      }
      case 'offer.reminded': {
        const to = strs(p.recipient_ids);
        if (to.length)
          this.add(null, {
            kind: 'plain',
            event: 'offer.reminder',
            rooms: to.map((u) => rooms.user(u)),
            data: { cause: 'offer.reminded', offer_id: p.offer_id, task_id: p.task_id },
            aggregate: null, // descriptive (10 §2.7): never compared with the round's version
            env: ev,
          });
        return;
      }
      case 'offer.expired':
      case 'offer.revoked': {
        const to = ev.type === 'offer.expired' ? strs([p.recipient_id]) : strs(p.recipient_ids);
        if (to.length)
          this.add(null, {
            kind: 'plain',
            event: 'offer.closed',
            rooms: to.map((u) => rooms.user(u)),
            data: {
              cause: ev.type,
              offer_id: p.offer_id,
              task_id: p.task_id,
              close_reason: ev.type === 'offer.expired' ? 'expired' : p.close_reason,
            },
            aggregate: ev.aggregate,
            env: ev,
          });
        return;
      }
      case 'driver.duty_started':
      case 'driver.break_started':
      case 'driver.break_ended':
      case 'driver.availability_changed': {
        const u = str(p.user_id);
        this.driver(u, ev, [...(u ? [rooms.user(u)] : []), ...sup]);
        return;
      }
      case 'driver.duty_ended': {
        const u = str(p.user_id);
        const reason = str(p.end_reason);
        // transfer / disabled: the sessions are revoked in the same transaction (session.revoked)
        if (u && (reason === 'transfer' || reason === 'disabled')) this.revoked.add(u);
        this.driver(u, ev, [...(u ? [rooms.user(u)] : []), ...sup]);
        if (u && (reason === 'forced' || reason === 'self'))
          this.syncs.set(u, { env: ev, reason: reason === 'forced' ? 'duty_force_ended' : 'duty_ended' });
        return;
      }
      case 'driver.connection_changed':
      case 'driver.enabled':
        this.driver(str(p.user_id), ev, sup);
        return;
      case 'driver.disabled': {
        const u = str(p.user_id);
        if (u) this.revoked.add(u);
        this.driver(u, ev, sup);
        return;
      }
      case 'driver.transfer_requested':
      case 'driver.transfer_blocked':
      case 'driver.transferred': {
        if (ev.type === 'driver.transferred' && str(p.driver_id)) this.revoked.add(str(p.driver_id)!);
        const venues = [str(p.from_venue_id), str(p.to_venue_id), ev.venue_id].filter(
          (v): v is string => !!v,
        );
        this.driver(
          str(p.driver_id),
          ev,
          [...new Set(venues)].map((v) => rooms.venueSupervisors(v)),
        );
        return;
      }
      case 'custody.changed':
        // release-custody (10 §9.2): the key is back in its slot, the task stays the driver's
        if (p.reason === 'withdrawal_release' && taskId) {
          this.add(`release:${taskId}`, {
            kind: 'task_card',
            taskId,
            userId: str(p.from?.id) ?? '',
            env: ev,
          });
          this.taskView(ev, taskId, sup);
        } else if (
          p.reason === 'official_transfer' &&
          taskId &&
          (p.subject === 'key' || p.subject === 'vehicle') &&
          custodyRepublishesTaskCard(p.subject, p.from?.type, p.to?.type)
        ) {
          // an official spot / slot transfer: the task (bumped) stays with its driver, his card shows the new place;
          // the key leaving or reaching a driver may set or reset the assignee's pickup (`key_picked_up_at`, bumped
          // without a task event when reset). A card the transaction already plans (key pickup, reassignment) is
          // not repeated (resolveAssigneeCards); one that did not change is the same version and ignored (07 §4.5).
          const ticketId = str(p.ticket_id);
          if (ticketId) this.add(`assignee:${taskId}`, { kind: 'assignee_card', taskId, ticketId, env: ev });
        }
        return;
      case 'payment.waived':
      case 'payment.online_paid':
      case 'payment.online_refunded':
      case 'payment.reversed': {
        // payment_due on the open task's card (a reversal with a replacement leaves it `collected`)
        const ticketId = str(p.ticket_id);
        if (ticketId && !(ev.type === 'payment.reversed' && p.with_replacement))
          this.add(`assignee:ticket:${ticketId}`, { kind: 'assignee_card', taskId: null, ticketId, env: ev });
        return;
      }
      case 'ticket.reparking':
        // the holder's repark task (next_due on the client)
        this.taskCard(ev, str(p.repark_task_id), str(p.assignee_id));
        return;
    }
  }

  /**
   * RT-2: an `assignee_card` becomes the open task's TaskCard for its assignee and the Task for the supervisors,
   * unless this transaction already plans them (a reassignment to the new holder, a key pickup).
   */
  private async resolveAssigneeCards(): Promise<PlannedIntent[]> {
    const out: PlannedIntent[] = [];
    for (const it of this.intents) {
      if (it.kind !== 'assignee_card') {
        out.push(it);
        continue;
      }
      const k = await this.tx.maybeOne<{ id: string; assignee_id: string | null }>(
        it.taskId
          ? `SELECT id, assignee_id FROM tasks WHERE id = $1 AND status NOT IN ('completed','canceled')`
          : `SELECT id, assignee_id FROM tasks WHERE ticket_id = $1 AND status NOT IN ('completed','canceled')`,
        [it.taskId ?? it.ticketId],
      );
      if (!k?.assignee_id) continue;
      if (!this.keys.has(`card:${k.id}:${k.assignee_id}`))
        out.push({ kind: 'task_card', taskId: k.id, userId: k.assignee_id, env: it.env });
      const sup = this.supervisors(it.env);
      if (sup.length && !this.keys.has(`view:${k.id}:${sup.join(',')}`))
        out.push({ kind: 'task_view', taskId: k.id, rooms: sup, hideAssignee: false, env: it.env });
    }
    return out;
  }

  async flush(): Promise<void> {
    const tx = this.tx;
    const now = tx.now;
    const views = new Map<string, Awaited<ReturnType<typeof loadTaskView>>>();
    const view = async (id: string) => {
      if (!views.has(id)) views.set(id, await loadTaskView(tx, id));
      return views.get(id) ?? null;
    };
    const gone = new Set<string>([...this.revoked].map((u) => rooms.user(u)));
    for (const raw of await this.resolveAssigneeCards()) {
      const it: PlannedIntent =
        raw.kind === 'plain' || raw.kind === 'task_view'
          ? { ...raw, rooms: raw.rooms.filter((r) => !gone.has(r)) }
          : raw.kind === 'offer_card'
            ? { ...raw, userIds: raw.userIds.filter((u) => !this.revoked.has(u)) }
            : raw;
      if (it.kind === 'task_card' && this.revoked.has(it.userId)) continue;
      if ((it.kind === 'plain' || it.kind === 'task_view') && !it.rooms.length) continue;
      if (it.kind === 'offer_card' && !it.userIds.length) continue;
      const env = it.env;
      const base = {
        venue_id: env.venue_id,
        dispatch_pool_id: env.dispatch_pool_id,
        event_id: env.event_id,
        actor: env.actor,
      };
      if (it.kind === 'plain') {
        let data = it.data;
        if (it.event === 'task.claimed') {
          const by = (data.claimed_by as { id: string | null }).id;
          const u = by
            ? await tx.maybeOne<{ id: string; full_name: string }>(
                `SELECT id, full_name FROM users WHERE id = $1`,
                [by],
              )
            : null;
          data = { ...data, claimed_by: u ? { id: u.id, full_name: u.full_name } : null };
        }
        await publishRealtime(tx, env.org_id, it.rooms, {
          event: it.event,
          id: newId(),
          ...(it.aggregate ? { aggregate: it.aggregate } : {}),
          data,
          ...base,
        });
      } else if (it.kind === 'offer_card') {
        const status = await tx.maybeOne<{ status: string; version: number }>(
          `SELECT status, version FROM task_offers WHERE id = $1`,
          [it.offerId],
        );
        if (!status || status.status !== 'active') continue; // closed in this transaction: offer.closed follows
        const cards = await loadOfferCards(tx, it.offerId, it.userIds, now);
        for (const u of it.userIds) {
          const card = cards.get(u);
          if (!card) continue;
          await publishRealtime(tx, env.org_id, [rooms.user(u)], {
            event: it.event,
            id: newId(),
            aggregate: { type: 'task_offer', id: it.offerId, version: status.version },
            data: { cause: env.type, ...card },
            ...base,
          });
        }
      } else if (it.kind === 'task_card') {
        if (!it.userId) continue;
        const card = await loadTaskCard(tx, it.taskId, { userId: it.userId, role: 'driver' }, now);
        if (!card) continue;
        await publishRealtime(tx, env.org_id, [rooms.user(it.userId)], {
          event: 'task.updated',
          id: newId(),
          aggregate: { type: 'task', id: it.taskId, version: card.task.version },
          data: { cause: env.type, ...card },
          ...base,
        });
      } else {
        const v = await view(it.taskId);
        if (!v) continue;
        const data = it.hideAssignee ? { ...v, assignee: null } : v;
        await publishRealtime(tx, env.org_id, it.rooms, {
          event: 'task.updated',
          id: newId(),
          aggregate: { type: 'task', id: it.taskId, version: v.version },
          data: { cause: env.type, ...data },
          ...base,
        });
      }
    }

    if (this.drivers.size) {
      const lives = await loadDriverLives(tx, [...this.drivers.keys()]);
      for (const [userId, d] of this.drivers) {
        const w = lives.get(userId);
        if (this.revoked.has(userId)) d.rooms.delete(rooms.user(userId));
        if (!w || !d.rooms.size) continue;
        await publishRealtime(tx, d.env.org_id, [...d.rooms], {
          event: 'driver.state_changed',
          id: newId(),
          // DriverLive mixes descriptive fields (connection, 10 §2.7): no version to compare
          aggregate: { type: 'user', id: userId, version: null },
          data: { cause: d.env.type, ...w.live },
          venue_id: w.venue_id ?? d.env.venue_id,
          dispatch_pool_id: w.dispatch_pool_id ?? d.env.dispatch_pool_id,
          actor: d.env.actor,
        });
      }
    }
    for (const [userId, s] of this.syncs)
      await publishRealtime(tx, s.env.org_id, [rooms.user(userId)], {
        event: 'sync.required',
        id: newId(),
        data: { cause: s.env.type, reason: s.reason, scope: 'home' },
        venue_id: s.env.venue_id,
        dispatch_pool_id: s.env.dispatch_pool_id,
        actor: s.env.actor,
      });
  }
}

/**
 * Realtime messages of the dispatch events (DEC-41/DEC-48, 07 §4.3, 11 §9.2): a TxPlanner that publishes with
 * pg_notify inside the producing transaction, so nothing reaches a socket unless the change commits. Targets:
 * the recipients' user rooms for offers, the pool's drivers room + the venue supervisors for task.claimed, the
 * assignee (TaskCard) and the supervisors (Task) for task.updated, the driver + the supervisors for
 * driver.state_changed (DriverLive, one per driver per transaction) and sync.required for a duty ended by force
 * or from another device. Lock-screen pushes are not planned here (DEC-23, the notifications module).
 */
export const dispatchRealtimePlanner: TxPlanner = {
  name: 'dispatch-realtime',
  async plan(tx, events) {
    const relevant = events.filter((e) => HANDLED.has(e.type));
    if (!relevant.length) return;
    const plan = new Plan(tx);
    for (const ev of relevant) plan.handle(ev as Env);
    await plan.flush();
  },
};

/** Registers the dispatch realtime planner (idempotent; api and worker both call it). */
export function registerDispatchRealtime(): void {
  registerTxPlanner(dispatchRealtimePlanner);
}

export function unregisterDispatchRealtime(): void {
  unregisterTxPlanner(dispatchRealtimePlanner.name);
}
