import type { OfferCloseReason } from '@point/shared';
import { newId } from '../../../core/crypto/ids.js';
import { lockOffers, lockOpenDutyByUsers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
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

/** A pass for a pool whose lock this transaction does not hold (10 §3: `dispatch_pass:<pool_id>`). */
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
    payload: { pool_id: pool.id, reason },
  });
}

/**
 * 10 §4.3: a single round for the longest-idle driver. The caller holds the pool lock and the task row.
 * Schedules `job.offer_expire` at `expires_at + dispatch.accept_grace_ms` (DEC-47).
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
  await schedule(tx, 'job.offer_expire', addMs(new Date(offer.expires_at!), cfg.acceptGraceMs), {
    orgId: pool.org_id,
    venueId: pool.venue_id,
    dedupeKey: `offer_expire:${offer.id}`,
    aggregate: { type: 'task_offer', id: offer.id, version: offer.version },
    payload: { task_id: task.id, pool_id: pool.id },
  });
  // extension point (S4, PNT-053): job.offer_remind at reminder_at — no handler exists yet
  await ensureDispatchSweep(tx, pool.org_id);
  return offer;
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
 * `jobVersion` = the aggregate version stored with the timer (stale timers are no-ops).
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
  return true;
}
