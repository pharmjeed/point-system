import { audit } from '../../core/audit/audit-writer.js';
import { lockPools, lockTickets } from '../../core/db/locks.js';
import type { Tx } from '../../core/db/tx.js';
import { metrics } from '../../core/metrics/metrics.js';
import type { TicketRow } from '../../modules/tickets-custody/index.js';
import {
  actionTokenState,
  findActionTokenByHash,
  resumeConsentByButton,
  sameCustomer,
  touchActionToken,
  type ButtonPressContext,
  type ButtonPressResult,
  type CustomerRow,
} from '../../modules/whatsapp/index.js';
import { applyCustomerRequest } from '../request-retrieval.js';

/**
 * «طلب السيارة» (PNT-045; 12 §6.5, 11 TT-06(a)/TT-07, 10): the RequestRetrieval use-case for the button,
 * registered as the whatsapp adapter's ButtonPressHandler (the adapter never calls dispatch, 04 §4.3 rule 3).
 * It runs in the inbound message transaction (`job.wa_process_inbound`) after the duplicate check on the
 * wamid (AC-01), so every effect below happens at most once per message:
 *
 * 1. payload hash → action token; unknown → W-10 (no ticket data);
 * 2. the sender must be the token's customer (wa_id, BSUID or phone — AC-02) → else W-10, audit, metric;
 * 3. L1 (the ticket's pool, taken first: the outcome may create a retrieval) → L5 ticket;
 * 4. revoked / expired token, older link_version (phone change, paper conversion), a W-01 of another ticket
 *    as the reply context, a voided ticket → W-09 «غير نشطة» without a request;
 * 5. an opt-out is resumed by the press itself (12 §7.6);
 * 6. parked without a cycle → cycle (`whatsapp`, requested_at = press time) + retrieve task + immediate pass
 *    → W-02; received / parking / reparking without a pending request → `pending_retrieval_at` (DEC-13) +
 *    `ticket.retrieval_requested_early` → W-02 once; anything else (an open cycle, a pending request,
 *    delivered) → W-09 with the current state (throttled by the planner, 14 §10).
 *
 * Concurrent presses of the same ticket serialize on L1/L5: the second one finds the cycle and answers W-09;
 * `uq_retrieval_cycles_open` / `uq_tasks_open_per_ticket` stay the backstop.
 */
export async function handleButtonPress(tx: Tx, ctx: ButtonPressContext): Promise<ButtonPressResult> {
  const token = ctx.payloadHash ? await findActionTokenByHash(tx, ctx.payloadHash) : null;
  if (!token || token.org_id !== ctx.orgId)
    return {
      outcome: 'rejected',
      reject_reason: 'unknown_token',
      ticket_id: null,
      customer_id: ctx.customer.id,
    };

  const owner = await tx.one<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [token.customer_id]);
  if (!sameCustomer(owner, ctx.sender)) {
    metrics.waButtonSenderMismatch.inc();
    await audit(tx, {
      orgId: ctx.orgId,
      actor: { type: 'customer', id: ctx.customer.id },
      action: 'wa.button_sender_mismatch',
      entityType: 'action_token',
      entityId: token.id,
      metadata: {
        action_token_id: token.id,
        ticket_id: token.ticket_id,
        whatsapp_message_id: ctx.inbound.id,
      },
    });
    return {
      outcome: 'rejected',
      reject_reason: 'sender_mismatch',
      ticket_id: null,
      customer_id: ctx.customer.id,
    };
  }

  const pre = await tx.one<{ dispatch_pool_id: string }>(
    `SELECT dispatch_pool_id FROM tickets WHERE id = $1`,
    [token.ticket_id],
  );
  await lockPools(tx, [pre.dispatch_pool_id]); // L1
  const [locked] = await lockTickets(tx, [token.ticket_id]); // L5
  let t = locked as TicketRow;
  const inactive = (reason: 'revoked' | 'expired' | 'stale_link_version'): ButtonPressResult => ({
    outcome: 'rejected',
    reject_reason: reason,
    ticket_id: t.id,
    customer_id: owner.id,
  });

  const state = actionTokenState(token, tx.now, t.link_version);
  if (state === 'revoked' || state === 'expired') return inactive(state);
  if (ctx.inbound.contextWamid) {
    // extra defence (12 §6.5): the button was sent in a W-01 of another ticket
    const ctxMsg = await tx.maybeOne<{ ticket_id: string | null }>(
      `SELECT ticket_id FROM whatsapp_messages WHERE wa_message_id = $1 AND direction = 'outbound' AND purpose = 'W-01'`,
      [ctx.inbound.contextWamid],
    );
    if (ctxMsg?.ticket_id && ctxMsg.ticket_id !== t.id) {
      await audit(tx, {
        orgId: ctx.orgId,
        actor: { type: 'customer', id: owner.id },
        action: 'wa.button_context_mismatch',
        entityType: 'action_token',
        entityId: token.id,
        venueId: t.venue_id,
        metadata: { action_token_id: token.id, ticket_id: t.id, whatsapp_message_id: ctx.inbound.id },
      });
      return inactive('revoked');
    }
  }
  if (state === 'stale_link_version') return inactive('stale_link_version');
  if (t.status === 'voided') return inactive('revoked');

  await touchActionToken(tx, token.id);
  const statusReply: ButtonPressResult = {
    outcome: 'status_reply',
    ticket_id: t.id,
    customer_id: owner.id,
  };
  if (t.status === 'delivered') return statusReply;

  if (owner.wa_opted_out_at || t.wa_link_status === 'opted_out')
    t = await resumeConsentByButton(tx, t, { customerId: owner.id, inboundMessageId: ctx.inbound.id });

  // the press time orders the queue (oldest requested_at first); never a future time (clock skew)
  const pressedAt = new Date(Math.min(ctx.inbound.receivedAt.getTime(), tx.now.getTime()));
  // one request path for the customer (S4 requestRetrievalForCustomer); L1 and L5 are already held here
  const r = await applyCustomerRequest(tx, t, {
    customerId: owner.id,
    requestedAt: pressedAt,
    ingestFrom: ctx.inbound.webhookReceivedAt ?? null,
  });
  if (r.kind === 'created') return { outcome: 'request_created', ticket_id: t.id, customer_id: owner.id };
  if (r.kind === 'pending_early') return { outcome: 'early_request', ticket_id: t.id, customer_id: owner.id };
  return statusReply;
}
