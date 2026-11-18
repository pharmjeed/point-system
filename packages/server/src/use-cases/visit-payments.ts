import type { Tx } from '../core/db/tx.js';
import {
  issueSystemRefund,
  registerVisitPaymentHook,
  type OnlinePaymentRow,
  type VisitPaymentHook,
} from '../modules/payments-online/index.js';
import {
  bumpTaskCardVersion,
  emitForTicket,
  systemActor,
  type TicketRow,
} from '../modules/tickets-custody/index.js';

/**
 * V2-022 (docs/v2/04 §2, O-03; DEC-522, DEC-523): what an online visit payment does to its ticket, in the
 * transaction of the payment's own move (the worker after the gateway's record was read, or the answer to our own
 * creation call). The payment row is locked by the caller; the open retrieval task (L4) and the ticket (L5) are
 * locked here in canon order — as the V1 collection takes them (13 §5.5) — so a cash/POS collection and an online
 * payment of one ticket are serialized: whichever commits first collects, the other sees it.
 *
 * - The first time a payment counts (`paid`, or `partially_refunded` read at once) and the ticket still owes its fee
 *   (`payment_status = due`): the ticket is `collected` with `entitlement = app_paid`, `payment.online_paid` goes to the
 *   timeline and the outbox (realtime to staff: D-10/D-11 «مدفوع في التطبيق», no cash asked), the task card version
 *   moves.
 * - The ticket does not owe it any more (a cash/POS payment recorded first, waived, voided, included): the payment
 *   is recorded as the gateway says and refunded in full at once (`double_payment` / `not_due`, DEC-523).
 * - Another online payment already counts for the ticket: this one is held (not applied — the unique index of one
 *   counting payment per ticket stays) and refunded in full.
 * - A counting payment refunded in full before the handover: the ticket owes its fee again (`due`, entitlement
 *   `none`, `payment.online_refunded`), like a reversal without replacement (13 §7.1). After the handover a
 *   platform refund changes nothing of the operator's ticket.
 *
 * Locks are taken with plain `FOR NO KEY UPDATE` statements (L4 then L5), not the transaction's lock tracker: the
 * daily reconciliation applies several payments in one transaction, payment by payment, each in canon order.
 */

async function lockVisitTicket(tx: Tx, ticketId: string): Promise<TicketRow | null> {
  await tx.query(
    `SELECT id FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status IN ('accepted','in_progress')
      ORDER BY id FOR NO KEY UPDATE`,
    [ticketId],
  );
  return tx.maybeOne<TicketRow>(`SELECT * FROM tickets WHERE id = $1 FOR NO KEY UPDATE`, [ticketId]);
}

async function openRetrieveTask(tx: Tx, ticketId: string): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tasks WHERE ticket_id = $1 AND type = 'retrieve' AND status IN ('accepted','in_progress')`,
    [ticketId],
  );
  return r?.id ?? null;
}

async function hasRecordedPayment(tx: Tx, ticketId: string): Promise<boolean> {
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM payments WHERE ticket_id = $1 AND status = 'recorded'`,
    [ticketId],
  );
  return !!r;
}

async function otherCountingPayment(tx: Tx, p: OnlinePaymentRow): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM online_payments
      WHERE ticket_id = $1 AND purpose = 'visit' AND status IN ('paid','partially_refunded') AND id <> $2`,
    [p.ticket_id, p.id],
  );
  return r?.id ?? null;
}

const owesFee = (t: TicketRow) =>
  t.status !== 'voided' &&
  t.payment_status === 'due' &&
  t.entitlement !== 'event_included' &&
  t.entitlement !== 'subscription';

export const visitPaymentEffects: VisitPaymentHook = {
  async beforePaid(tx, p) {
    if (!p.ticket_id) return 'apply';
    await lockVisitTicket(tx, p.ticket_id);
    const other = await otherCountingPayment(tx, p);
    if (!other) return 'apply';
    await issueSystemRefund(tx, p, 'double_payment', { other_online_payment_id: other });
    return 'hold';
  },

  async afterPaid(tx, p) {
    if (!p.ticket_id) return;
    const t = await lockVisitTicket(tx, p.ticket_id);
    if (!t) return;
    if (!owesFee(t)) {
      const recorded = await hasRecordedPayment(tx, t.id);
      await issueSystemRefund(tx, p, recorded ? 'double_payment' : 'not_due', {
        ticket_status: t.status,
        ticket_payment_status: t.payment_status,
        entitlement: t.entitlement,
      });
      return;
    }
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET payment_status = 'collected', entitlement = 'app_paid', version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id],
    );
    const task = await openRetrieveTask(tx, t.id);
    if (task) await bumpTaskCardVersion(tx, task); // RT-2: the D-11 card no longer asks for the fee
    await emitForTicket(tx, updated, {
      type: 'payment.online_paid',
      actor: systemActor,
      payload: { ticket_id: t.id, online_payment_id: p.id, amount_halalas: p.amount_halalas },
    });
  },

  async afterRefunded(tx, p) {
    if (!p.ticket_id) return;
    const t = await lockVisitTicket(tx, p.ticket_id);
    if (!t || t.entitlement !== 'app_paid' || t.payment_status !== 'collected') return;
    if (t.status === 'delivered' || t.status === 'voided') return;
    if ((await otherCountingPayment(tx, p)) || (await hasRecordedPayment(tx, t.id))) return;
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET payment_status = 'due', entitlement = 'none', version = version + 1
        WHERE id = $1 RETURNING *`,
      [t.id],
    );
    const task = await openRetrieveTask(tx, t.id);
    if (task) await bumpTaskCardVersion(tx, task);
    await emitForTicket(tx, updated, {
      type: 'payment.online_refunded',
      actor: systemActor,
      payload: { ticket_id: t.id, online_payment_id: p.id, amount_halalas: p.amount_halalas },
    });
  },
};

// registered when the use-cases are loaded (api and worker both import @point/server)
registerVisitPaymentHook(visitPaymentEffects);
