import type { Tx } from '../../../core/db/tx.js';
import {
  registerSubscriptionPaymentHook,
  type OnlinePaymentRow,
  type SubscriptionPaymentHook,
} from '../../payments-online/index.js';
import { renewalGivenId } from '../domain/jobs.js';
import { endPatch, onSubscriptionPaid, recordRenewalFailure, transition } from './machine.js';
import { SUBSCRIPTION_COLUMNS, type SubscriptionRow } from './rows.js';

async function lockOf(tx: Tx, p: OnlinePaymentRow): Promise<SubscriptionRow | null> {
  if (!p.subscription_id) return null;
  return tx.maybeOne<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s WHERE s.id = $1 FOR NO KEY UPDATE`,
    [p.subscription_id],
  );
}

/**
 * What a subscription payment's moves do to its subscription (V2-031; DEC-532, DEC-533), in the payment's own
 * transaction (the payment row locked first, then the subscription):
 * - paid: the period it pays starts (onSubscriptionPaid), or the money goes back;
 * - failed: a renewal attempt of the job (its given_id is the current attempt's) moves the grace on; a customer's own
 *   payment that fails (C-10 / C-14 «ادفع») changes nothing — the app answers PAYMENT_FAILED and the customer tries
 *   another card;
 * - refunded in full by the platform (P-06 / P-08, a manual refund) while it pays the current period: the
 *   subscription ends (`refunded`, 04 §1 «استرداد كامل»); the platform's own refunds (double payment, prorated) are
 *   handled where they are issued.
 */
export const subscriptionPaymentEffects: SubscriptionPaymentHook = {
  async afterPaid(tx, p) {
    await onSubscriptionPaid(tx, p);
  },

  async afterFailed(tx, p) {
    const sub = await lockOf(tx, p);
    if (!sub || p.subscription_period_seq !== sub.periods_paid + 1) return;
    if (p.given_id !== renewalGivenId(sub.id, p.subscription_period_seq, sub.renewal_attempts)) return;
    await recordRenewalFailure(tx, sub, {
      attempt: sub.renewal_attempts,
      reason: p.failure_code ?? 'declined',
      paymentId: p.id,
    });
  },

  async afterRefunded(tx, p) {
    const sub = await lockOf(tx, p);
    if (!sub || p.subscription_period_seq !== sub.periods_paid) return;
    if (sub.status !== 'active' && sub.status !== 'frozen') return;
    const system = await tx.maybeOne(`SELECT 1 FROM refunds WHERE online_payment_id = $1 AND kind = 'system'`, [
      p.id,
    ]);
    if (system) return;
    await transition(
      tx,
      sub,
      'refunded',
      endPatch(tx, sub, 'refunded'),
      { type: 'system', name: 'payments' },
      {
        online_payment_id: p.id,
        refunded_halalas: p.refunded_halalas,
      },
    );
  },
};

registerSubscriptionPaymentHook(subscriptionPaymentEffects);
