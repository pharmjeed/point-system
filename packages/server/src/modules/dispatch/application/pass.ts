import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import { lockOffers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import type { EventActor } from '../../tickets-custody/index.js';
import { idleCandidates, pickCandidate } from '../domain/driver-state.js';
import { ensurePoolLocked, loadPoolDrivers, loadTriedSet, lockOpenDemand } from '../infra/dispatch-repo.js';
import type { PoolDriverRow, PoolRow, QueueTask } from '../infra/rows.js';
import {
  createSingleRound,
  expireSingleRound,
  extendBroadcast,
  openBroadcast,
  revokeRound,
} from './offers.js';
import { addMs, dispatchSettings, type DispatchSettings } from './settings.js';

export type PassReason =
  | 'request_created'
  | 'requeued'
  | 'driver_available'
  | 'offer_expired'
  | 'offer_accepted'
  | 'task_canceled'
  | 'recipient_unavailable'
  | 'transfer'
  | 'sweep';

export interface PassResult {
  reason: PassReason;
  demand: number;
  onDuty: number;
  offersCreated: number;
  broadcastsOpened: number;
  expired: number;
  /** live rounds closed `claimed_elsewhere` because their task could no longer be offered (sweep only, 11 §3.3) */
  orphansClosed?: number;
  /** the pass gate (test seam) skipped this pass */
  skipped?: boolean;
}

/**
 * What happens to a task that has no untried idle candidate (10 §4.1 step D). The default is the broadcast
 * mode of PNT-053 (10 §4.4, R-3, R-6); a policy returns 'broadcast' when the task's round is (now) a live
 * broadcast, so the drivers who can act are held behind it for the newer tasks.
 */
export interface BroadcastPolicy {
  onNoSingleCandidate(
    tx: Tx,
    ctx: {
      pool: PoolRow;
      task: QueueTask;
      onDuty: PoolDriverRow[];
      blocked: Set<string>;
      cfg: DispatchSettings;
    },
  ): Promise<'broadcast' | 'queued'>;
}

/**
 * PNT-053 / 10 §4.1 step D. A queued task opens a broadcast to every on-duty driver of the pool (break excluded,
 * `busy_with_next` included as `view_only`, R-6), unless every driver who could act on it is held by an older
 * live round (R-3: the priority guard would refuse them anyway, so the request stays queued and invisible until
 * the older round is claimed). When nobody on duty can act at all (all `busy_with_next`) the broadcast still
 * opens view-only, as in the third example of 10 §4.8 (DEC-PROPOSED in docs/progress/notes/s4-dispatch.md).
 * A live broadcast is extended with the drivers who came on duty since it opened.
 */
export const BROADCAST_MODE: BroadcastPolicy = {
  async onNoSingleCandidate(tx, { pool, task, onDuty, blocked, cfg }) {
    if (task.status === 'queued') {
      const canAct = onDuty.filter((d) => d.driver_state !== 'busy_with_next');
      if (canAct.length > 0 && canAct.every((d) => blocked.has(d.user_id))) return 'queued';
      await openBroadcast(tx, pool, task, onDuty, cfg);
      return 'broadcast';
    }
    await extendBroadcast(tx, task, onDuty);
    return 'broadcast';
  },
};

let broadcastPolicy: BroadcastPolicy = BROADCAST_MODE;

/** Replaces the broadcast policy (tests); `null` restores the PNT-053 broadcast mode. */
export function registerBroadcastPolicy(p: BroadcastPolicy | null): void {
  broadcastPolicy = p ?? BROADCAST_MODE;
}

/**
 * Advisory alerts at the end of a pass (10 §4.7). Never reassigns silently: the supervisor decides (§9.1).
 */
export type PassAdvisor = (
  tx: Tx,
  ctx: { pool: PoolRow; idle: PoolDriverRow[]; cfg: DispatchSettings },
) => Promise<void>;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * 10 §4.7: with `dispatch.idle_driver_alert`, an available driver without a live single offer while a task of
 * the pool is reserved as somebody's next task raises `idle_driver_while_next_waiting` (warning) for the oldest
 * reserved task, `{ idle_driver_ids, reserved_by, waiting_since }`. The alert of a task that is no longer the
 * oldest reserved one, or when no idle driver is left, is resolved automatically («اختفاء المتاح», 10 §8.4);
 * promotion and withdrawal resolve it in their own transactions.
 */
export const IDLE_DRIVER_ADVISOR: PassAdvisor = async (tx, { pool, idle, cfg }) => {
  let keep: string | null = null;
  if (cfg.idleDriverAlert && idle.length) {
    const oldest = await tx.maybeOne<{
      id: string;
      ticket_id: string;
      event_id: string;
      assignee_id: string | null;
      assigned_waiting_at: Date | null;
      display_number: number;
    }>(
      `SELECT k.id, k.ticket_id, k.event_id, k.assignee_id, k.assigned_waiting_at, t.display_number
         FROM tasks k JOIN tickets t ON t.id = k.ticket_id
        WHERE k.dispatch_pool_id = $1 AND k.status = 'assigned_waiting'
        ORDER BY k.priority_at, k.seq
        LIMIT 1`,
      [pool.id],
    );
    if (oldest) {
      keep = `idle_driver_while_next_waiting:${oldest.id}`;
      await raiseAlert(tx, {
        orgId: pool.org_id,
        venueId: pool.venue_id,
        type: 'idle_driver_while_next_waiting',
        dedupeKey: keep,
        poolId: pool.id,
        eventId: oldest.event_id,
        ticketId: oldest.ticket_id,
        taskId: oldest.id,
        userId: oldest.assignee_id,
        details: {
          display_number: oldest.display_number,
          idle_driver_ids: idle.map((d) => d.user_id).sort(),
          reserved_by: oldest.assignee_id,
          waiting_since: iso(oldest.assigned_waiting_at),
        },
      });
    }
  }
  const open = await tx.rows<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM alerts
      WHERE venue_id = $1 AND dispatch_pool_id = $2 AND type = 'idle_driver_while_next_waiting'
        AND status <> 'resolved' AND dedupe_key IS NOT NULL`,
    [pool.venue_id, pool.id],
  );
  const stale = open.map((a) => a.dedupe_key).filter((k) => k !== keep);
  if (stale.length)
    await autoResolveAlerts(tx, {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      dedupeKeys: stale,
      note: 'no_idle_driver',
    });
};

let advisor: PassAdvisor = IDLE_DRIVER_ADVISOR;

/** Replaces the end-of-pass advisor (tests); `null` restores the 10 §4.7 idle-driver alert. */
export function registerPassAdvisor(a: PassAdvisor | null): void {
  advisor = a ?? IDLE_DRIVER_ADVISOR;
}

/**
 * Test seam (PNT-062 AC1): a gate that can switch off the in-transaction passes to prove that the safety-net
 * sweep (`job.dispatch_sweep`, reason `sweep`) still dispatches within 5 s. Returns false to skip a pass.
 * Never registered in production code.
 */
export type PassGate = (reason: PassReason, poolId: string) => boolean;
let gate: PassGate | null = null;
export function registerPassGate(g: PassGate | null): void {
  gate = g;
}

const SYSTEM: EventActor = { type: 'system', id: null };

/**
 * The dispatch pass (10 §4.1), run inside the transaction that changed the pool while it holds the pool lock
 * (DEC-08). Takes extra L4–L8 rows of the same pool (canon §14ب exception). `excludeUserIds`: drivers leaving
 * the pool in this transaction (release hook) are not offered anything.
 */
export async function runDispatchPass(
  tx: Tx,
  poolId: string,
  reason: PassReason,
  opts: { excludeUserIds?: readonly string[]; logger?: Logger } = {},
): Promise<PassResult> {
  if (gate && !gate(reason, poolId))
    return { reason, demand: 0, onDuty: 0, offersCreated: 0, broadcastsOpened: 0, expired: 0, skipped: true };
  const started = process.hrtime.bigint();
  const pool = await ensurePoolLocked(tx, poolId);
  const lockWaitMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cfg = await dispatchSettings(tx, pool.venue_id);
  const exclude = new Set(opts.excludeUserIds ?? []);

  // A. defensive expiry (same body as job.offer_expire) — protects against a lagging worker
  const overdue = await tx.rows<{ id: string; task_id: string }>(
    `SELECT id, task_id FROM task_offers
      WHERE dispatch_pool_id = $1 AND status = 'active' AND mode = 'single' AND expires_at <= $2
      ORDER BY task_id`,
    [poolId, addMs(tx.now, -cfg.acceptGraceMs)],
  );
  let expired = 0;
  if (overdue.length) {
    await lockTasks(
      tx,
      overdue.map((o) => o.task_id),
    );
    await lockOffers(
      tx,
      overdue.map((o) => o.id),
    );
    for (const o of overdue) if (await expireSingleRound(tx, o, pool.venue_id, cfg, null)) expired++;
  }
  // A'. the sweep's defensive repair (11 §3.3 `claimed_elsewhere`): a live round whose task can no longer be offered
  // is an inconsistent state no command should leave — closed, and logged as a monitoring error
  const orphansClosed = reason === 'sweep' ? await closeOrphanRounds(tx, pool, opts.logger) : 0;

  // B. snapshot under the lock
  const demand = await lockOpenDemand(tx, poolId);
  const drivers = (await loadPoolDrivers(tx, poolId)).filter((d) => !exclude.has(d.user_id));
  const onDuty = drivers.filter((d) => d.duty_status === 'on_duty');

  // C. nobody can serve this pool: alert, never route to another venue (10 §4.6); a broadcast stays a broadcast
  if (demand.length > 0 && onDuty.length === 0) {
    await raiseAlert(tx, {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      type: 'no_drivers_on_duty',
      dedupeKey: `no_drivers_on_duty:${pool.id}`,
      poolId: pool.id,
      details: {
        reason: drivers.length ? 'all_on_break' : 'none_on_duty',
        open_requests: demand.length,
      },
    });
    return finish(tx, pool, started, lockWaitMs, opts.logger, {
      reason,
      demand: demand.length,
      onDuty: 0,
      offersCreated: 0,
      broadcastsOpened: 0,
      expired,
      orphansClosed,
    });
  }
  if (onDuty.length > 0)
    await autoResolveAlerts(tx, {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      dedupeKeys: [`no_drivers_on_duty:${pool.id}`],
      note: 'driver_on_duty',
    });

  // D. pairing: oldest task ↔ longest idle driver (R-1 … R-6)
  const idle = idleCandidates(onDuty, { offlineLast: cfg.offlineDriversLast });
  const blocked = new Set(onDuty.filter((d) => d.live_single_offer_id).map((d) => d.user_id));
  let offersCreated = 0;
  let broadcastsOpened = 0;
  for (const task of demand) {
    if (task.status === 'offered') continue; // its single recipient is already blocked
    const tried = await loadTriedSet(tx, task.id);
    const cand = pickCandidate(idle, tried, blocked);
    if (cand) {
      if (task.status === 'broadcast' && task.live_offer_id) {
        await lockOffers(tx, [task.live_offer_id]);
        await revokeRound(tx, task.live_offer_id, pool.venue_id, 'converted_to_single', SYSTEM); // 10 §4.5
      }
      await createSingleRound(tx, pool, task, cand, cfg);
      metrics.dispatchOffers.inc({ mode: 'single', outcome: 'created' });
      offersCreated++;
      idle.splice(idle.indexOf(cand), 1);
      blocked.add(cand.user_id);
      continue;
    }
    const before = task.status;
    const outcome = await broadcastPolicy.onNoSingleCandidate(tx, { pool, task, onDuty, blocked, cfg });
    if (outcome === 'broadcast') {
      if (before === 'queued') {
        broadcastsOpened++;
        metrics.dispatchOffers.inc({ mode: 'broadcast', outcome: 'created' });
      }
      for (const d of onDuty) if (d.driver_state !== 'busy_with_next') blocked.add(d.user_id);
    }
  }

  // E. advisory alerts (never reassign silently)
  await advisor(tx, { pool, idle, cfg });
  return finish(tx, pool, started, lockWaitMs, opts.logger, {
    reason,
    demand: demand.length,
    onDuty: onDuty.length,
    offersCreated,
    broadcastsOpened,
    expired,
    orphansClosed,
  });
}

/**
 * 11 §3.3 `claimed_elsewhere`: the live rounds of the pool whose task is no longer `queued`, `offered` or
 * `broadcast` are revoked with that reason (offer.revoked → ws offer.closed) and each logged as an error with the
 * 10 §12.3 fields. The caller holds L1; tasks (L4) and offers (L7) are re-locked here (the L1 exception, canon §14ب).
 */
async function closeOrphanRounds(tx: Tx, pool: PoolRow, logger?: Logger): Promise<number> {
  const orphans = await tx.rows<{ id: string; task_id: string; task_status: string }>(
    `SELECT o.id, o.task_id, k.status AS task_status FROM task_offers o JOIN tasks k ON k.id = o.task_id
      WHERE o.dispatch_pool_id = $1 AND o.status = 'active' AND k.status NOT IN ('queued','offered','broadcast')
      ORDER BY o.task_id`,
    [pool.id],
  );
  if (!orphans.length) return 0;
  await lockTasks(
    tx,
    orphans.map((o) => o.task_id),
  );
  await lockOffers(
    tx,
    orphans.map((o) => o.id),
  );
  let closed = 0;
  for (const o of orphans) {
    const now = await tx.maybeOne<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [o.task_id]);
    if (!now || ['queued', 'offered', 'broadcast'].includes(now.status)) continue;
    const revoked = await revokeRound(tx, o.id, pool.venue_id, 'claimed_elsewhere', SYSTEM);
    if (!revoked) continue;
    closed++;
    logger?.error(
      {
        pool_id: pool.id,
        venue_id: pool.venue_id,
        offer_id: o.id,
        task_id: o.task_id,
        from_status: 'active',
        to_status: 'revoked',
        outcome: 'claimed_elsewhere',
        task_status: now.status,
      },
      'dispatch sweep closed a live round whose task can no longer be offered',
    );
  }
  return closed;
}

async function finish(
  tx: Tx,
  pool: PoolRow,
  started: bigint,
  lockWaitMs: number,
  logger: Logger | undefined,
  r: PassResult,
): Promise<PassResult> {
  // descriptive counters: no version bump (10 §2.7)
  await tx.query(`UPDATE dispatch_pools SET last_pass_at = $2, pass_count = pass_count + 1 WHERE id = $1`, [
    pool.id,
    tx.now,
  ]);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  metrics.dispatchPassDuration.observe({ reason: r.reason }, seconds);
  // 10 §12.3 fields (the passes of the worker's sweep carry a logger; a command's pass is in its command line):
  // `info` when the pass did something — a sweep that pairs, expires or closes repairs a missed timer or pass —
  // `debug` otherwise (05 §7.6: debug locally only; a sweep runs every 5 s per pool)
  const acted = r.offersCreated + r.broadcastsOpened + r.expired + (r.orphansClosed ?? 0) > 0;
  logger?.[acted ? 'info' : 'debug'](
    {
      pool_id: pool.id,
      venue_id: pool.venue_id,
      pass_reason: r.reason,
      offers_created: r.offersCreated,
      broadcasts_opened: r.broadcastsOpened,
      expired: r.expired,
      orphans_closed: r.orphansClosed ?? 0,
      demand: r.demand,
      on_duty: r.onDuty,
      lock_wait_ms: Math.round(lockWaitMs * 10) / 10,
      duration_ms: Math.round(seconds * 10_000) / 10,
    },
    'dispatch pass',
  );
  return r;
}
