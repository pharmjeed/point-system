import type { CustomerHandoverCode, CustomerVisitRequestResult } from '@point/shared/customer';
import type { CustomerActorContext } from '../core/actor-context/customer-actor.js';
import { audit } from '../core/audit/audit-writer.js';
import { customerAudit } from '../core/audit/customer-audit.js';
import { decrypt, type EncryptionKey } from '../core/crypto/crypto.js';
import type { Database } from '../core/db/database.js';
import { lockPools, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  customerVisitDetail,
  findAccountVisit,
  type VisitDetailDeps,
} from '../modules/customer-accounts/index.js';
import type { ClientInfo } from '../modules/identity-access/application/auth-service.js';
import type { TicketRow } from '../modules/tickets-custody/index.js';
import { applyCustomerRequest } from './request-retrieval.js';

const REQUEST_OP = 'POST /v1/customer/visits/{ticketId}/request';

/**
 * `POST /v1/customer/visits/{ticketId}/request` (C-12 «اطلب السيارة», V2-015, DEC-516): the customer's request of
 * 10 §7.2/§7.3 — the same command as the WhatsApp «طلب السيارة» (`applyCustomerRequest`, TT-06a/TT-07), with the
 * account's session as the proof of the customer (instead of the action token and the sender) and `app` as the
 * source. Checks, on the server: the visit is the account's (another account's, a voided ticket, an unknown id →
 * RESOURCE_NOT_FOUND), L1 the ticket's pool then L5 the ticket (canon §14ب), the state under the lock: `parked`
 * without a cycle → a cycle (`requested_at` = now) and its queued task with an immediate pass; `received`/`parking`/
 * `reparking` without a request → the early request of DEC-13 (converted when the car is parked, keeping this time);
 * an open cycle or a pending early request → RETRIEVAL_ALREADY_ACTIVE; delivered → TICKET_CLOSED. The
 * `Idempotency-Key` replays the first answer (customer_idempotency_keys); `uq_retrieval_cycles_open` stays the
 * backstop of concurrent requests. Audit: the operator's `audit_log` (the customer as actor) and the account's trail.
 */
export async function requestVisitFromApp(
  tx: Tx,
  deps: VisitDetailDeps,
  actor: CustomerActorContext,
  ticketId: string,
  client: ClientInfo,
): Promise<CustomerVisitRequestResult> {
  const pre = await findAccountVisit(tx, actor.accountId, ticketId);
  const pool = await tx.one<{ dispatch_pool_id: string }>(
    `SELECT dispatch_pool_id FROM tickets WHERE id = $1 AND org_id = $2`,
    [pre.ticket_id, pre.org_id],
  );
  await lockPools(tx, [pool.dispatch_pool_id]); // L1
  const [locked] = (await lockTickets(tx, [pre.ticket_id])) as TicketRow[]; // L5
  // under the lock: still the account's ticket (an app draft whose channel the driver changed is no longer theirs)
  const visit = await findAccountVisit(tx, actor.accountId, ticketId);
  const t = locked!;
  const r = await applyCustomerRequest(tx, t, { customerId: t.customer_id, source: 'app' });
  if (r.kind === 'closed') throw new AppError('TICKET_CLOSED', { ticket_status: r.ticketStatus });
  if (r.kind === 'already_pending')
    throw new AppError('RETRIEVAL_ALREADY_ACTIVE', {
      ticket_status: r.ticketStatus,
      pending_retrieval_at: r.pendingRetrievalAt,
    });
  if (r.kind === 'already_active')
    throw new AppError('RETRIEVAL_ALREADY_ACTIVE', { ticket_status: r.ticketStatus });

  const outcome = r.kind === 'created' ? 'requested' : 'requested_early';
  await audit(tx, {
    orgId: t.org_id,
    actor: { type: 'customer', id: t.customer_id },
    action: 'retrieval.request',
    entityType: 'ticket',
    entityId: t.id,
    venueId: t.venue_id,
    requestId: client.requestId,
    before: { status: t.status },
    after:
      r.kind === 'created'
        ? { status: r.ticketStatus, cycle_id: r.cycleId, task_id: r.taskId }
        : { status: r.ticketStatus, pending_retrieval_at: r.pendingRetrievalAt },
    metadata: { operation: REQUEST_OP, source: 'app', outcome },
  });
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.visit.requested',
    entityType: 'ticket',
    entityId: t.id,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: { org_id: t.org_id, venue_id: t.venue_id, outcome },
  });
  const after = await findAccountVisit(tx, actor.accountId, visit.ticket_id);
  return { outcome, visit: await customerVisitDetail(tx, deps, after) };
}

interface CodeRow {
  id: string;
  code_ciphertext: string | null;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  consumed_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/**
 * `GET /v1/customer/visits/{ticketId}/handover-code` (C-12, V2-015, DEC-517; DEC-38): the code of an app ticket's
 * ready car, decrypted in memory from its single copy `claim_codes.code_ciphertext` for the account's own session —
 * the customer says it to the driver (D-11 verifies it as for W-05). Not ready → HANDOVER_NOT_READY; ready but nothing
 * to show here → HANDOVER_CODE_UNAVAILABLE with the reason: `whatsapp` (a WhatsApp ticket gets W-05), `staff` (no code
 * for the visit: the paper stub or the supervisor's identity exception), `locked` (too many wrong attempts — the
 * supervisor), `expired` (the driver issues a new one: D-11 «إعادة الإرسال»), `none`. The code is never written to a
 * log, an event, the audit or a cache (`Cache-Control: no-store`); the account's trail records that it was shown.
 */
export async function visitHandoverCode(
  db: Database,
  keys: EncryptionKey[],
  actor: CustomerActorContext,
  ticketId: string,
  client: ClientInfo,
): Promise<CustomerHandoverCode> {
  return db.transaction(async (tx) => {
    const visit = await findAccountVisit(tx, actor.accountId, ticketId);
    if (visit.status !== 'ready') throw new AppError('HANDOVER_NOT_READY', { ticket_status: visit.status });
    if (visit.channel !== 'app')
      throw new AppError('HANDOVER_CODE_UNAVAILABLE', {
        reason: visit.channel === 'whatsapp' ? 'whatsapp' : 'staff',
      });
    const c = await tx.maybeOne<CodeRow>(
      `SELECT k.id, k.code_ciphertext, k.expires_at, k.attempts, k.max_attempts, k.locked_at, k.consumed_at,
              k.revoked_at, k.revoke_reason
         FROM tickets t JOIN claim_codes k ON k.cycle_id = t.active_cycle_id AND k.org_id = t.org_id
        WHERE t.id = $1 AND t.org_id = $2
        ORDER BY k.issued_at DESC, k.resend_no DESC, k.id DESC LIMIT 1`,
      [visit.ticket_id, visit.org_id],
    );
    const unavailable = (reason: string) => new AppError('HANDOVER_CODE_UNAVAILABLE', { reason });
    if (!c) throw unavailable('staff');
    if (c.locked_at) throw unavailable('locked');
    if (c.revoke_reason === 'expired_cleanup') throw unavailable('expired');
    if (c.consumed_at || c.revoked_at || !c.code_ciphertext) throw unavailable('none');
    if (new Date(c.expires_at).getTime() <= tx.now.getTime()) throw unavailable('expired');
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      action: 'customer.visit.handover_code_shown',
      entityType: 'ticket',
      entityId: visit.ticket_id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: { org_id: visit.org_id, claim_code_id: c.id },
    });
    return {
      ticket_id: visit.ticket_id,
      code: decrypt(c.code_ciphertext, keys),
      expires_at: new Date(c.expires_at).toISOString(),
      attempts_left: Math.max(0, c.max_attempts - c.attempts),
    };
  });
}
