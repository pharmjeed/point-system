import type { OfferCloseReason, OfferEligibility } from '@point/shared';
import { newId } from '../../../core/crypto/ids.js';
import { lockOffers, lockOpenDutyByUsers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import type { EventActor } from '../../tickets-custody/index.js';
import type { OfferRow, PoolDriverRow, PoolRow, QueueTask } from '../infra/rows.js';
import { emitOfferEvent, emitTaskEvent } from './events.js';
import { addMs, type DispatchSettings } from './settings.js';

const SYSTEM: EventActor = { type: 'system', id: null };

/** Safety-net sweep every 5 s (10 §8.2: `job.dispatch_sweep`, dedupe `dispatch_sweep`). */
export const SWEEP_INTERVAL_MS = 5000;

/**
 * Seeds the periodic sweep once: the sweep handler always schedules its successor in its own transaction,
 * so a pending or processing row means the chain is alive. The check is a plain read so a command never
 * waits on the row of a sweep that is running (the INSERT … ON CONFLICT would wait for it).
 */
export async function ensureDispatchSweep(tx: Tx, orgId: string): Promise<void> {
  const alive = await tx.maybeOne(
    `SELECT 1 FROM outbox_events WHERE dedupe_key = 'dispatch_sweep' AND status IN ('pending','processing') LIMIT 1`,
  );
  if (alive) return;
  await schedule(tx, 'job.dispatch_sweep', addMs(tx.now, SWEEP_INTERVAL_MS), {
    orgId,
    dedupeKey: 'dispatch_sweep',
    payload: {},
  });
}

/**
 * A pass for a pool whose lock this transaction does not hold (10 §3, 11 §8.11: `dispatch_pass:<pool_id>`, payload
 * `{dispatch_pool_id, reason}`). No V1 command needs it: each holds the L1 lock of the pools it changes.
 */
export async function requestDispatchPass(
  tx: Tx,
  pool: { id: string; org_id: string; venue_id: string },
  reason: string,
): Promise<void> {
  await schedule(tx, 'job.dispatch_pass', tx.now, {
    orgId: pool.org_id,
    venueId: pool.venue_id,
    dedupeKey: `dispatch_pass:${pool.id}`,
    aggregate: { type: 'dispatch_pool', id: pool.id, version: null },
    payload: { dispatch_pool_id: pool.id, reason },
  });
}

/** `eligible_as` of a broadcast recipient from his derived state (10 §2.2); stored for display only. */
export function eligibilityOf(state: string): OfferEligibility {
  if (state === 'available') return 'accept';
  if (state === 'intake_parking' || state === 'retrieving') return 'reserve_next';
  return 'view_only';
}

/**
 * 10 §4.3: a single round for the longest-idle driver. The caller holds the pool lock and the task row.
 * Schedules `job.offer_remind` at `reminder_at` and `job.offer_expire` at `expires_at + dispatch.accept_grace_ms`
 * (DEC-47); both carry the round's version so a later change makes them no-ops.
 */
export async function createSingleRound(
  tx: Tx,
  pool: PoolRow,
  task: QueueTask,
  driver: PoolDriverRow,
  cfg: DispatchSettings,
): Promise<OfferRow> {
  const offer = await tx.one<OfferRow>(
    `INSERT INTO task_offers (id, org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, reminder_at, expires_at)
     VALUES ($1, $2, $3, $4, 'single', COALESCE((SELECT max(round_no) FROM task_offers WHERE task_id = $3), 0) + 1,
             'active', $5, $6, $7)
     RETURNING *`,
    [
      newId(),
      pool.org_id,
      task.id,
      pool.id,
      tx.now,
      addMs(tx.now, cfg.singleOfferReminderS * 1000),
      addMs(tx.now, cfg.singleOfferTtlS * 1000),
    ],
  );
  await tx.query(
    `INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as) VALUES ($1, $2, $3, 'accept')`,
    [offer.id, driver.user_id, driver.duty_session_id],
  );
  const upd = await tx.query<{ version: number }>(
    `UPDATE tasks SET status = 'offered', first_offered_at = COALESCE(first_offered_at, $3), version = version + 1
      WHERE id = $1 AND status IN ('queued','broadcast') AND version = $2 RETURNING version`,
    [task.id, task.version, tx.now],
  );
  if (upd.rowCount !== 1) throw new InvariantViolation(`task ${task.id} changed under the pool lock`);
  task.version = upd.rows[0]!.version;
  task.status = 'offered';
  task.live_offer_id = offer.id;
  task.live_offer_mode = 'single';
  task.expires_at = offer.expires_at;
  await emitTaskEvent(
    tx,
    { id: task.id, ticket_id: task.ticket_id, version: task.version },
    'task.offered',
    SYSTEM,
    {
      task_id: task.id,
      ticket_id: task.ticket_id,
      offer_id: offer.id,
      round_no: offer.round_no,
      recipient_id: driver.user_id,
      expires_at: new Date(offer.expires_at!).toISOString(),
      reminder_at: offer.reminder_at ? new Date(offer.reminder_at).toISOString() : null,
    },
  );
  const aggregate = { type: 'task_offer', id: offer.id, version: offer.version };
  if (offer.reminder_at)
    await schedule(tx, 'job.offer_remind', new Date(offer.reminder_at), {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      dedupeKey: `offer_remind:${offer.id}`,
      aggregate,
      payload: { offer_id: offer.id, task_id: task.id, pool_id: pool.id },
    });
  await schedule(tx, 'job.offer_expire', addMs(new Date(offer.expires_at!), cfg.acceptGraceMs), {
    orgId: pool.org_id,
    venueId: pool.venue_id,
    dedupeKey: `offer_expire:${offer.id}`,
    aggregate,
    payload: { offer_id: offer.id, task_id: task.id, pool_id: pool.id },
  });
  await ensureDispatchSweep(tx, pool.org_id);
  return offer;
}

/**
 * 10 §4.4: a broadcast round for a queued task — recipients are every on-duty driver of the pool (break
 * excluded, `busy_with_next` included as `view_only`, R-6), `reminder_at` from `dispatch.broadcast_reminder_s`,
 * no `expires_at` (a broadcast ends by acceptance, conversion or cancellation). `task.broadcast_opened` and one
 * `job.broadcast_remind`.
 */
export async function openBroadcast(
  tx: Tx,
  pool: PoolRow,
  task: QueueTask,
  onDuty: readonly PoolDriverRow[],
  cfg: DispatchSettings,
): Promise<OfferRow> {
  const offer = await tx.one<OfferRow>(
    `INSERT INTO task_offers (id, org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, reminder_at, expires_at)
     VALUES ($1, $2, $3, $4, 'broadcast', COALESCE((SELECT max(round_no) FROM task_offers WHERE task_id = $3), 0) + 1,
             'active', $5, $6, NULL)
     RETURNING *`,
    [newId(), pool.org_id, task.id, pool.id, tx.now, addMs(tx.now, cfg.broadcastReminderS * 1000)],
  );
  const recipients = await addBroadcastRecipients(tx, offer.id, onDuty);
  const upd = await tx.query<{ version: number }>(
    `UPDATE tasks SET status = 'broadcast', broadcast_at = COALESCE(broadcast_at, $3), version = version + 1
      WHERE id = $1 AND status = 'queued' AND version = $2 RETURNING version`,
    [task.id, task.version, tx.now],
  );
  if (upd.rowCount !== 1) throw new InvariantViolation(`task ${task.id} changed under the pool lock`);
  task.version = upd.rows[0]!.version;
  task.status = 'broadcast';
  task.live_offer_id = offer.id;
  task.live_offer_mode = 'broadcast';
  task.expires_at = null;
  await emitTaskEvent(
    tx,
    { id: task.id, ticket_id: task.ticket_id, version: task.version },
    'task.broadcast_opened',
    SYSTEM,
    {
      task_id: task.id,
      ticket_id: task.ticket_id,
      offer_id: offer.id,
      round_no: offer.round_no,
      recipients,
      reminder_at: new Date(offer.reminder_at!).toISOString(),
    },
  );
  await schedule(tx, 'job.broadcast_remind', new Date(offer.reminder_at!), {
    orgId: pool.org_id,
    venueId: pool.venue_id,
    dedupeKey: `broadcast_remind:${offer.id}`,
    aggregate: { type: 'task_offer', id: offer.id, version: offer.version },
    payload: { offer_id: offer.id, task_id: task.id, pool_id: pool.id },
  });
  await ensureDispatchSweep(tx, pool.org_id);
  return offer;
}

/**
 * 10 §4.4: drivers who came on duty (or back from a break) since the broadcast opened become recipients;
 * `task.broadcast_extended` lists only the newly added ones. Nobody is ever removed (history, 10 §9.6).
 */
export async function extendBroadcast(
  tx: Tx,
  task: QueueTask,
  onDuty: readonly PoolDriverRow[],
): Promise<{ user_id: string; eligible_as: OfferEligibility }[]> {
  if (!task.live_offer_id) return [];
  const added = await addBroadcastRecipients(tx, task.live_offer_id, onDuty);
  if (added.length)
    await emitTaskEvent(
      tx,
      { id: task.id, ticket_id: task.ticket_id, version: task.version },
      'task.broadcast_extended',
      SYSTEM,
      { task_id: task.id, offer_id: task.live_offer_id, added },
    );
  return added;
}

async function addBroadcastRecipients(
  tx: Tx,
  offerId: string,
  onDuty: readonly PoolDriverRow[],
): Promise<{ user_id: string; eligible_as: OfferEligibility }[]> {
  const eligible = onDuty.filter((d) => d.duty_status === 'on_duty');
  if (!eligible.length) return [];
  const r = await tx.query<{ user_id: string; eligible_as: OfferEligibility }>(
    `INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as)
     SELECT $1, x.user_id, x.duty_session_id, x.eligible_as
       FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS x(user_id, duty_session_id, eligible_as)
     ON CONFLICT (offer_id, user_id) DO NOTHING
     RETURNING user_id, eligible_as`,
    [
      offerId,
      eligible.map((d) => d.user_id),
      eligible.map((d) => d.duty_session_id),
      eligible.map((d) => eligibilityOf(d.driver_state)),
    ],
  );
  return [...r.rows].sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
}

/** Closes a live round for a reason other than acceptance (offer.revoked). Caller holds L4 task + L7 offer. */
export async function revokeRound(
  tx: Tx,
  offerId: string,
  venueId: string,
  reason: Exclude<OfferCloseReason, 'accepted' | 'expired'>,
  actor: EventActor,
): Promise<OfferRow | null> {
  const offer = await tx.maybeOne<OfferRow>(
    `UPDATE task_offers SET status = 'revoked', closed_at = $2, close_reason = $3, version = version + 1
      WHERE id = $1 AND status = 'active' RETURNING *`,
    [offerId, tx.now, reason],
  );
  if (!offer) return null;
  metrics.dispatchOffers.inc({ mode: offer.mode, outcome: 'revoked' }); // 05 §12.2 (`accepted`, `expired`, `revoked`…)
  const recipients = await tx.rows<{ user_id: string }>(
    `SELECT user_id FROM offer_recipients WHERE offer_id = $1 ORDER BY user_id`,
    [offerId],
  );
  await emitOfferEvent(tx, offer, venueId, 'offer.revoked', actor, {
    offer_id: offer.id,
    task_id: offer.task_id,
    mode: offer.mode,
    close_reason: reason,
    recipient_ids: recipients.map((r) => r.user_id),
  });
  return offer;
}

/**
 * Revokes every live single offer of a driver (recipient_unavailable / transfer) and puts each task back to
 * `queued` in the same episode — the driver stays in the tried set (10 §2.5, §5.3, §7.1 step 3).
 */
export async function revokeDriverSingleOffers(
  tx: Tx,
  driverId: string,
  reason: 'recipient_unavailable' | 'transfer',
  actor: EventActor,
): Promise<{ offerId: string; taskId: string }[]> {
  const live = await tx.rows<{ offer_id: string; task_id: string; venue_id: string }>(
    `SELECT o.id AS offer_id, o.task_id, t.venue_id
       FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id JOIN tasks t ON t.id = o.task_id
      WHERE r.user_id = $1 AND o.status = 'active' AND o.mode = 'single'
      ORDER BY o.task_id`,
    [driverId],
  );
  if (!live.length) return [];
  await lockTasks(
    tx,
    live.map((l) => l.task_id),
  ); // L4
  await lockOffers(
    tx,
    live.map((l) => l.offer_id),
  ); // L7
  const out: { offerId: string; taskId: string }[] = [];
  for (const l of live) {
    const revoked = await revokeRound(tx, l.offer_id, l.venue_id, reason, actor);
    if (!revoked) continue;
    await tx.query(
      `UPDATE tasks SET status = 'queued', version = version + 1 WHERE id = $1 AND status = 'offered'`,
      [l.task_id],
    );
    out.push({ offerId: l.offer_id, taskId: l.task_id });
  }
  return out;
}

/**
 * 10 §8.3: the round expires (once `expires_at + grace` has passed), its task goes back to `queued` and the
 * silent recipient is rotated to the back of the idle order (DEC-26). Caller holds L1, L4 (task), L7 (offer).
 * `jobVersion` = the aggregate version stored with the timer (stale timers are no-ops). Every expiry is counted
 * here (`point_dispatch_offers_total{mode="single",outcome="expired"}`, 05 §12.2), whether job.offer_expire or the
 * defensive step A of a dispatch pass closes the round.
 */
export async function expireSingleRound(
  tx: Tx,
  offer: Pick<OfferRow, 'id' | 'task_id'>,
  venueId: string,
  cfg: DispatchSettings,
  jobVersion: number | null,
): Promise<boolean> {
  const expired = await tx.maybeOne<OfferRow>(
    `UPDATE task_offers SET status = 'expired', closed_at = $2, close_reason = 'expired', version = version + 1
      WHERE id = $1 AND status = 'active' AND mode = 'single' AND ($3::int IS NULL OR version = $3)
        AND expires_at <= $4
      RETURNING *`,
    [offer.id, tx.now, jobVersion, addMs(tx.now, -cfg.acceptGraceMs)],
  );
  if (!expired) return false;
  await tx.query(
    `UPDATE tasks SET status = 'queued', version = version + 1 WHERE id = $1 AND status = 'offered'`,
    [expired.task_id],
  );
  const recipient = await tx.maybeOne<{ user_id: string }>(
    `SELECT user_id FROM offer_recipients WHERE offer_id = $1 LIMIT 1`,
    [expired.id],
  );
  if (recipient) {
    const [duty] = await lockOpenDutyByUsers<{ id: string; status: string; available_since: Date | null }>(
      tx,
      [recipient.user_id],
    ); // L8
    if (duty && duty.status === 'on_duty' && duty.available_since) {
      await tx.query(`UPDATE duty_sessions SET available_since = $2, version = version + 1 WHERE id = $1`, [
        duty.id,
        tx.now,
      ]);
    }
  }
  await emitOfferEvent(tx, expired, venueId, 'offer.expired', SYSTEM, {
    offer_id: expired.id,
    task_id: expired.task_id,
    recipient_id: recipient?.user_id ?? null,
  });
  metrics.dispatchOffers.inc({ mode: 'single', outcome: 'expired' });
  return true;
}

/**
 * `job.offer_remind` / `job.broadcast_remind` (10 §8.2): one reminder per round, to the recipients who can act on
 * it now — the single recipient while he is still available, or the broadcast recipients still on duty in the
 * pool whose live state is `accept`/`reserve_next`. `reminded_at` is descriptive (no version bump, 10 §2.7).
 * Caller holds L1, L4 (task) and L7 (round).
 */
export async function remindRound(tx: Tx, offer: OfferRow, venueId: string): Promise<string[]> {
  const recipients = await tx.rows<{ user_id: string; driver_state: string | null }>(
    `SELECT r.user_id, s.driver_state
       FROM offer_recipients r
       LEFT JOIN v_driver_state s ON s.user_id = r.user_id AND s.dispatch_pool_id = $2 AND s.duty_status = 'on_duty'
      WHERE r.offer_id = $1
      ORDER BY r.user_id`,
    [offer.id, offer.dispatch_pool_id],
  );
  const can = recipients
    .filter((r) => {
      if (!r.driver_state) return false;
      const e = eligibilityOf(r.driver_state);
      return offer.mode === 'single' ? e === 'accept' : e !== 'view_only';
    })
    .map((r) => r.user_id);
  await tx.query(`UPDATE task_offers SET reminded_at = $2 WHERE id = $1 AND reminded_at IS NULL`, [
    offer.id,
    tx.now,
  ]);
  await emitOfferEvent(tx, offer, venueId, 'offer.reminded', SYSTEM, {
    offer_id: offer.id,
    task_id: offer.task_id,
    mode: offer.mode,
    recipient_ids: can,
  });
  return can;
}

/**
 * `job.escalate_unaccepted` for the current episode of a queued task (10 §7.2, §8.2): at
 * `queued_at + dispatch.unaccepted_escalation_s`, dedupe `escalate_unaccepted:<task_id>:<queued_at>`.
 */
export async function scheduleEscalation(
  tx: Tx,
  task: { id: string; org_id: string; venue_id: string; cycle_id: string | null; queued_at: Date | null },
  cfg: Pick<DispatchSettings, 'unacceptedEscalationS'>,
): Promise<void> {
  if (!task.queued_at) return;
  const queuedAt = new Date(task.queued_at);
  await schedule(tx, 'job.escalate_unaccepted', addMs(queuedAt, cfg.unacceptedEscalationS * 1000), {
    orgId: task.org_id,
    venueId: task.venue_id,
    dedupeKey: `escalate_unaccepted:${task.id}:${queuedAt.getTime()}`,
    aggregate: { type: 'task', id: task.id, version: null },
    payload: { task_id: task.id, cycle_id: task.cycle_id, queued_at: queuedAt.toISOString() },
  });
}

/**
 * `job.next_task_wait_check` for a reserved next task (10 §5.3, §8.2): at
 * `assigned_waiting_at + dispatch.next_task_wait_alert_s`, dedupe `next_task_wait:<task_id>:<assigned_waiting_at>`.
 */
export async function scheduleNextTaskWaitCheck(
  tx: Tx,
  task: { id: string; org_id: string; venue_id: string; assigned_waiting_at: Date | null },
  cfg: Pick<DispatchSettings, 'nextTaskWaitAlertS'>,
): Promise<void> {
  if (!task.assigned_waiting_at) return;
  const at = new Date(task.assigned_waiting_at);
  await schedule(tx, 'job.next_task_wait_check', addMs(at, cfg.nextTaskWaitAlertS * 1000), {
    orgId: task.org_id,
    venueId: task.venue_id,
    dedupeKey: `next_task_wait:${task.id}:${at.getTime()}`,
    aggregate: { type: 'task', id: task.id, version: null },
    payload: { task_id: task.id, assigned_waiting_at: at.toISOString() },
  });
}
