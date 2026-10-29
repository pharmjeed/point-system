import { raiseAlert } from '../../../core/alerts/alerts.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { lockOffers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { orgSettings } from '../../../core/settings/settings-service.js';
import { emitTaskEvent } from '../application/events.js';
import { HEARTBEAT_SWEEP_KEY, sweepHeartbeats } from '../application/heartbeat.js';
import {
  ensureDispatchSweep,
  expireSingleRound,
  remindRound,
  SWEEP_INTERVAL_MS,
} from '../application/offers.js';
import { runDispatchPass, type PassReason } from '../application/pass.js';
import { registerDispatchRealtime } from '../application/realtime.js';
import { addMs, dispatchSettings } from '../application/settings.js';
import { ensurePoolLocked, loadTicketCtx } from '../infra/dispatch-repo.js';
import type { OfferRow, TaskRow } from '../infra/rows.js';

function requireTx(tx: Tx | undefined): Tx {
  if (!tx) throw new Error('dispatch jobs run in mode tx');
  return tx;
}

// `point_timer_lag_seconds{job}` (10 §12.2) is observed by the worker for every job.* row (apps/worker)
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * `job.offer_expire` (10 §8.3): lock the pool, then the task and the round (canon §14ب); a stale timer (round
 * no longer active or its version changed) is a no-op; a timer that fires early is rescheduled.
 */
export const offerExpireHandler: JobHandler = {
  type: 'job.offer_expire',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const offerId = row.aggregate_id;
    if (!offerId) return;
    const pre = await tx.maybeOne<
      Pick<OfferRow, 'id' | 'task_id' | 'dispatch_pool_id' | 'status' | 'version'>
    >(`SELECT id, task_id, dispatch_pool_id, status, version FROM task_offers WHERE id = $1`, [offerId]);
    if (!pre || pre.status !== 'active') return; // accepted, revoked or already expired
    if (row.aggregate_version != null && pre.version !== row.aggregate_version) return; // stale
    const pool = await ensurePoolLocked(tx, pre.dispatch_pool_id); // L1
    await lockTasks(tx, [pre.task_id]); // L4
    const [offer] = (await lockOffers(tx, [pre.id])) as OfferRow[]; // L7
    if (!offer || offer.status !== 'active') return;
    if (row.aggregate_version != null && offer.version !== row.aggregate_version) return;
    const cfg = await dispatchSettings(tx, pool.venue_id);
    const due = addMs(new Date(offer.expires_at!), cfg.acceptGraceMs);
    if (due.getTime() > tx.now.getTime()) {
      // fired early (clock skew between processes): come back at the real deadline
      await schedule(tx, 'job.offer_expire', due, {
        orgId: offer.org_id,
        venueId: pool.venue_id,
        dedupeKey: `offer_expire:${offer.id}`,
        aggregate: { type: 'task_offer', id: offer.id, version: offer.version },
        payload: row.payload,
      });
      return;
    }
    if (!(await expireSingleRound(tx, offer, pool.venue_id, cfg, offer.version))) return; // counted there
    await runDispatchPass(tx, pool.id, 'offer_expired');
    await audit(tx, {
      orgId: offer.org_id,
      actor: { type: 'system', id: null },
      action: 'job.offer_expire',
      entityType: 'task_offer',
      entityId: offer.id,
      venueId: pool.venue_id,
      metadata: { task_id: offer.task_id },
    });
  },
};

/**
 * `job.offer_remind` / `job.broadcast_remind` (10 §8.2): still applies while the round is active and not yet
 * reminded (a single round also keeps its version); an early timer comes back at `reminder_at`. One reminder per
 * round, to the recipients who can act on it now (`offer.reminded` → ws `offer.reminder`).
 */
function remindHandler(
  type: 'job.offer_remind' | 'job.broadcast_remind',
  mode: 'single' | 'broadcast',
): JobHandler {
  return {
    type,
    mode: 'tx',
    async handle({ row, tx: maybeTx }) {
      const tx = requireTx(maybeTx);
      const offerId = row.aggregate_id ?? (row.payload?.offer_id as string | undefined);
      if (!offerId) return;
      const applies = (o: Pick<OfferRow, 'status' | 'mode' | 'reminded_at' | 'version'> | null | undefined) =>
        !!o &&
        o.status === 'active' &&
        o.mode === mode &&
        o.reminded_at == null &&
        (mode === 'broadcast' || row.aggregate_version == null || o.version === row.aggregate_version);
      const pre = await tx.maybeOne<OfferRow>(`SELECT * FROM task_offers WHERE id = $1`, [offerId]);
      if (!applies(pre)) return; // claimed, expired, revoked, converted or already reminded
      const pool = await ensurePoolLocked(tx, pre!.dispatch_pool_id); // L1
      await lockTasks(tx, [pre!.task_id]); // L4
      const [offer] = (await lockOffers(tx, [pre!.id])) as OfferRow[]; // L7
      if (!applies(offer)) return;
      if (offer!.reminder_at && new Date(offer!.reminder_at).getTime() > tx.now.getTime()) {
        await schedule(tx, type, new Date(offer!.reminder_at), {
          orgId: offer!.org_id,
          venueId: pool.venue_id,
          dedupeKey: `${mode === 'single' ? 'offer_remind' : 'broadcast_remind'}:${offer!.id}`,
          aggregate: { type: 'task_offer', id: offer!.id, version: offer!.version },
          payload: row.payload,
        });
        return;
      }
      await remindRound(tx, offer!, pool.venue_id);
    },
  };
}

export const offerRemindHandler = remindHandler('job.offer_remind', 'single');
export const broadcastRemindHandler = remindHandler('job.broadcast_remind', 'broadcast');

/**
 * `job.escalate_unaccepted` (PNT-057; 10 §7.2, §8.2): the episode still waits (task queued/offered/broadcast with
 * the same `queued_at`, not escalated yet) → `tasks.escalated_at` (descriptive), `task.escalated` and the critical
 * alert `request_unaccepted:{task_id}` for the venue supervisors. The request never leaves the queue, and this
 * works with no client connected (server timers).
 */
export const escalateUnacceptedHandler: JobHandler = {
  type: 'job.escalate_unaccepted',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const taskId = (row.payload?.task_id as string | undefined) ?? row.aggregate_id;
    const mark = row.payload?.queued_at as string | undefined;
    if (!taskId || !mark) return;
    const waiting = (t: Pick<TaskRow, 'status' | 'queued_at' | 'escalated_at'> | null | undefined) =>
      !!t &&
      (t.status === 'queued' || t.status === 'offered' || t.status === 'broadcast') &&
      iso(t.queued_at) === new Date(mark).toISOString() &&
      t.escalated_at == null;
    const pre = await tx.maybeOne<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (!waiting(pre)) return; // claimed, canceled, requeued (new episode) or already escalated
    const pool = await ensurePoolLocked(tx, pre!.dispatch_pool_id); // L1
    const [task] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    if (!waiting(task)) return;
    await tx.query(`UPDATE tasks SET escalated_at = $2 WHERE id = $1`, [task!.id, tx.now]); // 10 §2.7: no version bump
    const counts = await tx.one<{ on_duty: number; available: number }>(
      `SELECT count(*) FILTER (WHERE duty_status = 'on_duty')::int AS on_duty,
              count(*) FILTER (WHERE driver_state = 'available')::int AS available
         FROM v_driver_state WHERE dispatch_pool_id = $1`,
      [pool.id],
    );
    const live = await tx.maybeOne<{ mode: string }>(
      `SELECT mode FROM task_offers WHERE task_id = $1 AND status = 'active'`,
      [task!.id],
    );
    const waitedS = Math.max(0, Math.round((tx.now.getTime() - new Date(task!.queued_at!).getTime()) / 1000));
    const ticket = await loadTicketCtx(tx, task!.ticket_id);
    await emitTaskEvent(
      tx,
      task!,
      'task.escalated',
      { type: 'system', id: null },
      {
        task_id: task!.id,
        ticket_id: task!.ticket_id,
        cycle_id: task!.cycle_id,
        queued_at: iso(task!.queued_at),
        waited_s: waitedS,
        on_duty_count: counts.on_duty,
        available_count: counts.available,
        mode_at_escalation: live?.mode ?? 'none',
      },
      ticket,
    );
    await raiseAlert(tx, {
      orgId: task!.org_id,
      venueId: task!.venue_id,
      type: 'request_unaccepted',
      dedupeKey: `request_unaccepted:${task!.id}`,
      poolId: pool.id,
      eventId: task!.event_id,
      ticketId: task!.ticket_id,
      taskId: task!.id,
      details: {
        display_number: ticket.display_number,
        queued_at: iso(task!.queued_at),
        waited_s: waitedS,
        on_duty_count: counts.on_duty,
        available_count: counts.available,
        mode: live?.mode ?? 'none',
      },
    });
    metrics.dispatchEscalations.inc();
  },
};

/**
 * `job.next_task_wait_check` (PNT-057; 10 §5.3, §8.2): the reservation still waits with the same
 * `assigned_waiting_at` → `next_task_waiting_long` (warning). Never reassigns (EC-30): the supervisor decides.
 */
export const nextTaskWaitCheckHandler: JobHandler = {
  type: 'job.next_task_wait_check',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const taskId = (row.payload?.task_id as string | undefined) ?? row.aggregate_id;
    const mark = row.payload?.assigned_waiting_at as string | undefined;
    if (!taskId || !mark) return;
    const waiting = (t: Pick<TaskRow, 'status' | 'assigned_waiting_at'> | null | undefined) =>
      !!t && t.status === 'assigned_waiting' && iso(t.assigned_waiting_at) === new Date(mark).toISOString();
    const pre = await tx.maybeOne<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (!waiting(pre)) return;
    const pool = await ensurePoolLocked(tx, pre!.dispatch_pool_id); // L1
    const [task] = (await lockTasks(tx, [taskId])) as TaskRow[]; // L4
    if (!waiting(task)) return;
    const ticket = await loadTicketCtx(tx, task!.ticket_id);
    await raiseAlert(tx, {
      orgId: task!.org_id,
      venueId: task!.venue_id,
      type: 'next_task_waiting_long',
      dedupeKey: `next_task_waiting_long:${task!.id}`,
      poolId: pool.id,
      eventId: task!.event_id,
      ticketId: task!.ticket_id,
      taskId: task!.id,
      userId: task!.assignee_id,
      details: {
        display_number: ticket.display_number,
        reserved_by: task!.assignee_id,
        waiting_since: iso(task!.assigned_waiting_at),
        waited_s: Math.max(
          0,
          Math.round((tx.now.getTime() - new Date(task!.assigned_waiting_at!).getTime()) / 1000),
        ),
      },
    });
  },
};

/**
 * `job.dispatch_pass` for a pool a command could not lock itself (11 §8.11: payload `{dispatch_pool_id, reason}`,
 * dedupe `dispatch_pass:<pool_id>`, guard «the pool is active»). Every command of V1 holds the L1 lock of the
 * pools it changes and runs the pass inline (10 §4.1, DEC-08), so no command produces it today: the handler is
 * the path 10 §8.2 keeps for one that cannot (`requestDispatchPass`).
 */
export const dispatchPassHandler: JobHandler = {
  type: 'job.dispatch_pass',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const poolId =
      (row.payload?.dispatch_pool_id as string | undefined) ??
      (row.payload?.pool_id as string | undefined) ?? // rows written before 11 §8.11's name
      row.aggregate_id;
    if (!poolId) return;
    const active = await tx.maybeOne(`SELECT 1 FROM dispatch_pools WHERE id = $1 AND status = 'active'`, [
      poolId,
    ]);
    if (!active) return;
    await ensurePoolLocked(tx, poolId);
    await runDispatchPass(
      tx,
      poolId,
      ((row.payload?.reason as PassReason | undefined) ?? 'sweep') as PassReason,
    );
  },
};

const POOLS_TO_SWEEP = `SELECT p.id FROM dispatch_pools p
  WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.dispatch_pool_id = p.id
                  AND ((t.type = 'retrieve' AND t.status IN ('queued','offered','broadcast')) OR t.status = 'assigned_waiting'))
     OR EXISTS (SELECT 1 FROM task_offers o WHERE o.dispatch_pool_id = p.id AND o.status = 'active')
  ORDER BY p.id`;

/**
 * `job.dispatch_sweep` (10 §8.2): every 5 s a pass for each pool with an open request, a live round or a
 * reserved next task — each pool in its own transaction. It always schedules its successor in the handler's
 * transaction (the row is already `done` there), so the chain seeded by `ensureDispatchSweep` never breaks.
 */
export const dispatchSweepHandler: JobHandler = {
  type: 'job.dispatch_sweep',
  mode: 'tx',
  async handle({ row, tx: maybeTx, db, logger }) {
    const tx = requireTx(maybeTx);
    const pools = await db.rows<{ id: string }>(POOLS_TO_SWEEP);
    for (const p of pools) {
      try {
        await db.transaction(async (ptx) => {
          await ensurePoolLocked(ptx, p.id);
          await runDispatchPass(ptx, p.id, 'sweep', { logger });
        });
      } catch (e) {
        logger.warn(
          { pool_id: p.id, err: e instanceof Error ? e.message : String(e) },
          'dispatch sweep pass failed',
        );
      }
    }
    await schedule(tx, 'job.dispatch_sweep', addMs(tx.now, SWEEP_INTERVAL_MS), {
      orgId: row.org_id,
      dedupeKey: 'dispatch_sweep',
      payload: {},
    });
  },
};

/**
 * `job.heartbeat_sweep` (PNT-062; 10 §8.2): every `heartbeat.interval_s` the connection state of the open duty
 * sessions from their last heartbeat, each session in its own short transaction; the successor is scheduled in
 * the handler's transaction (dedupe `heartbeat_sweep`), like the dispatch sweep.
 */
export const heartbeatSweepHandler: JobHandler = {
  type: 'job.heartbeat_sweep',
  mode: 'tx',
  async handle({ row, tx: maybeTx, db, logger }) {
    const tx = requireTx(maybeTx);
    await sweepHeartbeats(db, tx.now, logger);
    const s = await orgSettings(tx, row.org_id);
    await schedule(tx, 'job.heartbeat_sweep', addMs(tx.now, s.heartbeat.interval_s * 1000), {
      orgId: row.org_id,
      dedupeKey: HEARTBEAT_SWEEP_KEY,
      payload: {},
    });
  },
};

/**
 * Handlers registered by apps/worker (handlers.ts). Registers the dispatch realtime planner too: worker
 * transactions (timers, sweeps) publish their messages like the api's (DEC-48).
 */
export function dispatchJobs(): JobHandler[] {
  registerDispatchRealtime();
  return [
    offerExpireHandler,
    offerRemindHandler,
    broadcastRemindHandler,
    escalateUnacceptedHandler,
    nextTaskWaitCheckHandler,
    dispatchPassHandler,
    dispatchSweepHandler,
    heartbeatSweepHandler,
  ];
}

export { ensureDispatchSweep };
