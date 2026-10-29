import { AppError } from '../core/errors/app-error.js';
import {
  alreadyRecorded,
  assertCollectable,
  loadMoneyEventRow,
  loadPaymentViews,
  recordCollection,
} from '../modules/payments-reports/index.js';
import { registerInlinePaymentHook, type InlinePaymentHook } from './hooks.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/handover';

/**
 * PNT-080: the collection inside the handover (13 §5.3, §5.5; 11 TT-18), through the S2 seam. `check` runs at the
 * payment gate — after the custody checks, before the code or the stub is verified — without any effect:
 *   `due` without `payment` → PAYMENT_PENDING {amount_halalas, allowed_methods};
 *   `due` with `payment` → 13 §5.2 (VALIDATION_FAILED `payment.pos_reference`, PAYMENT_METHOD_NOT_ALLOWED,
 *   PAYMENT_AMOUNT_MISMATCH);
 *   `collected` with `payment` → PAYMENT_ALREADY_RECORDED; `not_required` / `waived` with `payment` →
 *   VALIDATION_FAILED (`payment`, `not_applicable`).
 * `collect` writes the payment in the handover transaction once the verification passed (`source = handover`,
 * collected by the assignee). The handover holds L2 (event FOR SHARE) → L4 → L5 → L6 when money is involved.
 */
export const handoverPaymentHook: InlinePaymentHook = {
  async check(tx, { ticket, payment }) {
    if (ticket.payment_status === 'due') {
      const ev = await loadMoneyEventRow(tx, ticket.event_id);
      if (!payment)
        throw new AppError('PAYMENT_PENDING', {
          amount_halalas: Number(ticket.fee_halalas),
          allowed_methods: ev.allowed_payment_methods,
        });
      await assertCollectable(tx, {
        ticket,
        event: ev,
        input: payment,
        command: OPERATION,
        prefix: 'payment.',
      });
      return;
    }
    if (!payment) return;
    if (ticket.payment_status === 'collected') throw await alreadyRecorded(tx, ticket.id);
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'payment', issue: 'not_applicable' }] });
  },

  async collect(
    tx,
    { ticket, cycle, payment, actor, requestId, collectedBy, source, operation, deferAudit },
  ) {
    const { payment: row, writeAudit } = await recordCollection(tx, {
      ticket,
      cycleId: cycle.id,
      input: payment,
      collectedBy: collectedBy ?? actor.userId,
      actor,
      requestId: requestId ?? '',
      source: source ?? 'handover',
      operation: operation ?? OPERATION,
      deferAudit: !!deferAudit,
    });
    if (deferAudit && writeAudit) deferAudit(writeAudit);
    const [view] = await loadPaymentViews(tx, [row]);
    return view!;
  },
};

// registered when the use-cases are loaded (api and worker both import @point/server)
registerInlinePaymentHook(handoverPaymentHook);
