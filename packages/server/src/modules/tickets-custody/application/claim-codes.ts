import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import {
  encrypt,
  hmacHex,
  randomDigits,
  safeEqual,
  type EncryptionKey,
} from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { STALE_TIMER, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { venueSettingsFor } from '../../venues-events/index.js';
import type { CycleRow, TicketRow } from '../infra/rows.js';
import { emitForTicket, type EventActor } from './events.js';
import { requestCustodyTicketUpdate } from './ticket-update-seam.js';
import type { Queryable } from './views.js';

/**
 * ClaimCodeService (04 §4.2 tickets-custody: `issue / verify / resend / revoke`; 11 §5.1; DEC-15, DEC-38).
 * The handover code is 6 secure random digits; the table keeps `HMAC-SHA256(CODE_PEPPER, cycle_id:code)` and
 * the ONLY encrypted copy (AES-GCM, `code_ciphertext`) that the W-05 sender reads once and purges after the
 * provider accepted the message (or at expiry). The code itself is never returned, logged, audited, written
 * to an event or shown to staff. All functions run in the caller's transaction after its canon locks
 * (claim_codes is L9).
 */

export const CLAIM_CODE_DIGITS = 6;

export interface ClaimCodeRow {
  id: string;
  org_id: string;
  ticket_id: string;
  cycle_id: string;
  code_hash: string;
  code_ciphertext: string | null;
  issued_at: Date;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  consumed_at: Date | null;
  consumed_by: string | null;
  revoked_at: Date | null;
  revoke_reason: 'resend' | 'reparked' | 'canceled' | 'exception_handover' | 'expired_cleanup' | null;
  resend_no: number;
  sent_message_id: string | null;
}

/** CODE_PEPPER (HMAC key) and DATA_ENCRYPTION_KEY (the W-05 copy) — from the environment, never stored. */
export interface ClaimCodeSecrets {
  pepper: string;
  key: EncryptionKey;
}

export const claimCodeHash = (pepper: string, cycleId: string, code: string): string =>
  hmacHex(pepper, `${cycleId}:${code}`);

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const lockedDedupe = (cycleId: string) => `handover_code_locked:${cycleId}`;

/** The unconsumed, unrevoked code of the cycle (`uq_claim_codes_live`: at most one), locked (L9). */
export async function lockLiveClaimCode(tx: Tx, cycleId: string): Promise<ClaimCodeRow | null> {
  return tx.maybeOne<ClaimCodeRow>(
    `SELECT * FROM claim_codes WHERE cycle_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL FOR NO KEY UPDATE`,
    [cycleId],
  );
}

/** The cycle's most recent code, whatever its state. */
export async function latestClaimCode(q: Queryable, cycleId: string): Promise<ClaimCodeRow | null> {
  const r = await q.query<ClaimCodeRow>(
    `SELECT * FROM claim_codes WHERE cycle_id = $1 ORDER BY issued_at DESC, resend_no DESC, id DESC LIMIT 1`,
    [cycleId],
  );
  return r.rows[0] ?? null;
}

async function openLockAlertId(
  tx: Tx,
  t: Pick<TicketRow, 'venue_id'>,
  cycleId: string,
): Promise<string | null> {
  const a = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM alerts WHERE venue_id = $1 AND dedupe_key = $2 AND status <> 'resolved'`,
    [t.venue_id, lockedDedupe(cycleId)],
  );
  return a?.id ?? null;
}

/**
 * Issue (TT-17, resend): a new live code for the cycle with `handover.code_ttl_min` / `handover.max_attempts`,
 * its expiry timer (`job.claim_code_expire`, dedupe `claim_code_expire:<id>`, 04 §6.5) and
 * `handover.code_issued` — which the NotificationPlanner turns into W-05 (key `wa:W-05:<claim_code_id>`).
 */
export async function issueClaimCode(
  tx: Tx,
  ticket: TicketRow,
  cycle: Pick<CycleRow, 'id'>,
  m: { secrets: ClaimCodeSecrets; actor: EventActor; resendNo?: number },
): Promise<ClaimCodeRow> {
  const s = (await venueSettingsFor(tx, ticket.venue_id)).handover;
  const code = randomDigits(CLAIM_CODE_DIGITS);
  const row = await tx.one<ClaimCodeRow>(
    `INSERT INTO claim_codes (org_id, ticket_id, cycle_id, code_hash, code_ciphertext, issued_at, expires_at, max_attempts, resend_no)
     VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + make_interval(mins => $7), $8, $9) RETURNING *`,
    [
      ticket.org_id,
      ticket.id,
      cycle.id,
      claimCodeHash(m.secrets.pepper, cycle.id, code),
      encrypt(code, m.secrets.key),
      tx.now,
      s.code_ttl_min,
      s.max_attempts,
      m.resendNo ?? 0,
    ],
  );
  await schedule(tx, 'job.claim_code_expire', new Date(row.expires_at), {
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    dedupeKey: `claim_code_expire:${row.id}`,
    aggregate: { type: 'claim_code', id: row.id, version: null },
    payload: { claim_code_id: row.id },
  });
  await emitForTicket(tx, ticket, {
    type: 'handover.code_issued',
    actor: m.actor,
    payload: {
      ticket_id: ticket.id,
      cycle_id: cycle.id,
      claim_code_id: row.id,
      expires_at: iso(row.expires_at),
      resend_no: row.resend_no,
    },
  });
  return row;
}

/**
 * Verify at handover (TT-18, 11 §5.1 rule 2): a constant-time comparison of the HMAC. A wrong code counts an
 * attempt that COMMITS with the error (keepEffects: the saved idempotent response, so a replay never costs a
 * second attempt); the attempt that reaches `max_attempts` locks the code, raises `handover_code_locked` and
 * answers HANDOVER_CODE_LOCKED. Locked → LOCKED (even the right code), expired → EXPIRED, consumed →
 * CONSUMED; no code for the cycle (paper ticket, link not established at ready) → not applicable. The right
 * code is consumed (`consumed_at/by`) and its encrypted copy purged.
 */
export async function verifyClaimCode(
  tx: Tx,
  ticket: TicketRow,
  cycle: Pick<CycleRow, 'id'>,
  code: string,
  m: { pepper: string; actor: EventActor; userId: string; taskId?: string | null },
): Promise<ClaimCodeRow> {
  const live = await lockLiveClaimCode(tx, cycle.id);
  if (!live) {
    const last = await latestClaimCode(tx, cycle.id);
    if (last?.consumed_at) throw new AppError('HANDOVER_CODE_CONSUMED');
    if (last?.locked_at)
      throw new AppError('HANDOVER_CODE_LOCKED', {
        locked_at: iso(last.locked_at),
        alert_id: await openLockAlertId(tx, ticket, cycle.id),
      });
    if (last?.revoke_reason === 'expired_cleanup')
      throw new AppError('HANDOVER_CODE_EXPIRED', { expired_at: iso(last.expires_at) });
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'verification.method', issue: 'not_applicable' }],
    });
  }
  if (live.locked_at)
    throw new AppError('HANDOVER_CODE_LOCKED', {
      locked_at: iso(live.locked_at),
      alert_id: await openLockAlertId(tx, ticket, cycle.id),
    });
  if (new Date(live.expires_at).getTime() <= tx.now.getTime())
    throw new AppError('HANDOVER_CODE_EXPIRED', { expired_at: iso(live.expires_at) });

  if (!safeEqual(claimCodeHash(m.pepper, cycle.id, code), live.code_hash)) {
    const attempts = live.attempts + 1;
    const left = Math.max(0, live.max_attempts - attempts);
    const lock = attempts >= live.max_attempts;
    await tx.query(
      `UPDATE claim_codes SET attempts = $2, locked_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE locked_at END
        WHERE id = $1`,
      [live.id, attempts, lock, tx.now],
    );
    await emitForTicket(tx, ticket, {
      type: 'handover.code_attempt_failed',
      actor: m.actor,
      payload: {
        ticket_id: ticket.id,
        claim_code_id: live.id,
        cycle_id: cycle.id,
        method: 'code',
        attempts,
        attempts_left: left,
      },
    });
    if (lock) {
      await emitForTicket(tx, ticket, {
        type: 'handover.code_locked',
        actor: m.actor,
        payload: { ticket_id: ticket.id, claim_code_id: live.id, cycle_id: cycle.id, method: 'code' },
      });
      const { alert } = await raiseAlert(tx, {
        orgId: ticket.org_id,
        venueId: ticket.venue_id,
        type: 'handover_code_locked',
        dedupeKey: lockedDedupe(cycle.id),
        poolId: ticket.dispatch_pool_id,
        eventId: ticket.event_id,
        ticketId: ticket.id,
        taskId: m.taskId ?? null,
        userId: m.userId,
        details: { display_number: ticket.display_number, attempts, method: 'code' },
      });
      throw new AppError(
        'HANDOVER_CODE_LOCKED',
        { locked_at: tx.now.toISOString(), alert_id: alert.id },
        { keepEffects: true },
      );
    }
    throw new AppError('HANDOVER_CODE_INVALID', { attempts_left: left }, { keepEffects: true });
  }
  return tx.one<ClaimCodeRow>(
    `UPDATE claim_codes SET consumed_at = $2, consumed_by = $3, code_ciphertext = NULL WHERE id = $1 RETURNING *`,
    [live.id, tx.now, m.userId],
  );
}

/**
 * Resend (11 §5.1 rule 4, `POST /v1/tickets/{ticketId}/handover-code/resend`): while `resend_no <
 * handover.max_resends` the live code is revoked (`resend`, copy purged) and a new one issued with
 * `resend_no + 1` and fresh attempts — W-05 again through `handover.code_issued`. A locked code (also after
 * its expiry cleanup) is reissued by a supervisor only; the reissue lifts `handover_code_locked`. A cycle
 * without any code yet (linked after `ready`) gets its first one.
 */
export async function resendClaimCode(
  tx: Tx,
  ticket: TicketRow,
  cycle: Pick<CycleRow, 'id'>,
  m: { secrets: ClaimCodeSecrets; actor: EventActor; supervisor: boolean },
): Promise<{ issued: ClaimCodeRow; replaced: ClaimCodeRow | null }> {
  const max = (await venueSettingsFor(tx, ticket.venue_id)).handover.max_resends;
  const live = await lockLiveClaimCode(tx, cycle.id);
  const last = live ?? (await latestClaimCode(tx, cycle.id));
  if (last?.locked_at && !last.consumed_at && !m.supervisor)
    throw new AppError('HANDOVER_CODE_LOCKED', {
      locked_at: iso(last.locked_at),
      alert_id: await openLockAlertId(tx, ticket, cycle.id),
    });
  if (last && last.resend_no >= max) throw new AppError('RESEND_LIMIT_REACHED', { max_resends: max });
  if (live)
    await tx.query(
      `UPDATE claim_codes SET revoked_at = $2, revoke_reason = 'resend', code_ciphertext = NULL WHERE id = $1`,
      [live.id, tx.now],
    );
  const issued = await issueClaimCode(tx, ticket, cycle, {
    secrets: m.secrets,
    actor: m.actor,
    resendNo: last ? last.resend_no + 1 : 0,
  });
  if (last?.locked_at)
    await autoResolveAlerts(tx, {
      orgId: ticket.org_id,
      venueId: ticket.venue_id,
      dedupeKeys: [lockedDedupe(cycle.id)],
      note: 'code_reissued',
    });
  return { issued, replaced: live };
}

/**
 * Revoke the cycle's live code (11 §5.1 rule 5: `reparked`, `canceled`, `exception_handover`; locked codes
 * included) and purge its copy. Returns the revoked ids. Seam for the S4/S6 commands (repark, cancel after
 * the movement, manual reconcile) as well.
 */
export async function revokeClaimCodes(
  tx: Tx,
  cycleId: string,
  reason: 'reparked' | 'canceled' | 'exception_handover',
): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `UPDATE claim_codes SET revoked_at = $2, revoke_reason = $3, code_ciphertext = NULL
      WHERE cycle_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [cycleId, tx.now, reason],
  );
  return r.rows.map((x) => x.id);
}

/** `ClaimCodeState` (07): the state of the cycle's current code — never the code. */
export interface ClaimCodeState {
  issued_at: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  attempts_left: number;
  locked_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  resend_no: number;
  resends_left: number;
  sent_status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | null;
}

export async function claimCodeState(
  q: Queryable,
  row: ClaimCodeRow,
  maxResends: number,
): Promise<ClaimCodeState> {
  const sent = (
    await q.query<{ status: ClaimCodeState['sent_status']; n_status: string }>(
      `SELECT m.status, n.status AS n_status FROM notifications n
         LEFT JOIN LATERAL (SELECT status FROM whatsapp_messages w WHERE w.notification_id = n.id AND w.direction = 'outbound'
                             ORDER BY w.created_at DESC, w.id DESC LIMIT 1) m ON true
        WHERE n.dedupe_key = $1`,
      [`wa:W-05:${row.id}`],
    )
  ).rows[0];
  const sentStatus: ClaimCodeState['sent_status'] = sent
    ? (sent.status ??
      (sent.n_status === 'failed' ? 'failed' : sent.n_status === 'skipped' ? 'skipped' : 'queued'))
    : null;
  return {
    issued_at: iso(row.issued_at)!,
    expires_at: iso(row.expires_at)!,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    attempts_left: Math.max(0, row.max_attempts - row.attempts),
    locked_at: iso(row.locked_at),
    consumed_at: iso(row.consumed_at),
    revoked_at: iso(row.revoked_at),
    resend_no: row.resend_no,
    resends_left: Math.max(0, maxResends - row.resend_no),
    sent_status: sentStatus,
  };
}

/** The current code state of a ticket's cycle for TicketDetail (null without any code). */
export async function loadClaimCodeState(
  q: Queryable,
  venueId: string,
  cycleId: string | null,
): Promise<ClaimCodeState | null> {
  if (!cycleId) return null;
  const row = await latestClaimCode(q, cycleId);
  if (!row) return null;
  return claimCodeState(q, row, (await venueSettingsFor(q, venueId)).handover.max_resends);
}

/**
 * `job.claim_code_expire` (11 §8.11): at `expires_at` a code neither consumed nor revoked is revoked
 * (`expired_cleanup`) and its encrypted copy purged, and the ticket is published (`ticket.updated`, cause
 * `job.claim_code_expire`) to the assignee and the venue's supervisors (14 §3.7: D-11 «انتهى الرمز — أعد
 * الإرسال», S-03's ClaimCodeState) without waiting for a refused handover; an early timer reschedules itself, a
 * stale one does nothing. A verify after expiry answers HANDOVER_CODE_EXPIRED either way.
 */
export const claimCodeExpireHandler: JobHandler = {
  type: 'job.claim_code_expire',
  mode: 'tx',
  async handle({ row, tx }) {
    const id = row.payload?.claim_code_id;
    if (typeof id !== 'string' || !tx) return;
    const c = await tx.maybeOne<ClaimCodeRow & { venue_id: string }>(
      `SELECT c.*, t.venue_id FROM claim_codes c JOIN tickets t ON t.id = c.ticket_id WHERE c.id = $1 FOR NO KEY UPDATE OF c`,
      [id],
    );
    if (!c || c.consumed_at || c.revoked_at) return STALE_TIMER; // consumed, revoked or already cleaned up
    if (new Date(c.expires_at).getTime() > tx.now.getTime()) {
      await schedule(tx, 'job.claim_code_expire', new Date(c.expires_at), {
        orgId: c.org_id,
        venueId: c.venue_id,
        dedupeKey: `claim_code_expire:${c.id}`,
        aggregate: { type: 'claim_code', id: c.id, version: null },
        payload: { claim_code_id: c.id },
      });
      return;
    }
    await tx.query(
      `UPDATE claim_codes SET revoked_at = $2, revoke_reason = 'expired_cleanup', code_ciphertext = NULL WHERE id = $1`,
      [c.id, tx.now],
    );
    await requestCustodyTicketUpdate(tx, c.ticket_id, 'job.claim_code_expire');
  },
};
