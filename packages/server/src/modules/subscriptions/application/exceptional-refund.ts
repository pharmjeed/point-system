import { PLATFORM_REASON_MIN, SERVICE_DAY_RULES, type PlatformExceptionalRefundBody } from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { paymentById, RefundsService } from '../../payments-online/index.js';
import { endPatch, periodOf, transition, unusedShareHalalas, type SubActor } from './machine.js';
import { policyOf, subscriptionById, type SubscriptionRow } from './rows.js';
import { refundableDays, termOf } from './terms.js';

const DAY_MS = 86_400_000;

const notRefundable = (sub: SubscriptionRow) =>
  new AppError('INVALID_STATE_TRANSITION', {
    entity_type: 'subscription',
    entity_id: sub.id,
    current_status: sub.status,
    command: 'subscription.exceptional_refund',
    allowed_from: ['active', 'frozen'],
  });

/**
 * P-07 «استرداد استثنائي» (V2-036; DEC-600; annex clause 5 «في الحالات المستثناة من شرط عدم الاسترداد …»):
 * `platform.refund_issue` (owner and finance — money goes out, DEC-465). A case the non-refund condition does not
 * cover (a right the law gives, the service made impossible, the agreement ended): the remaining counted days out of
 * the term's (or the unused time of a calendar term) are refunded pro rata to the original payment method by the
 * manual refund path of DEC-513 (the gateway called after COMMIT; the credit note issued by the V5 hook settles the
 * VAT), the subscription ends (`exceptional_refund`), and the money is due back within 12 calendar days
 * (`refund_due_at`, shown on C-14 and P-07). Locks: the payment row, then the subscription (the payment hooks' order).
 */
export class ExceptionalRefunds {
  private readonly refunds = new RefundsService();

  async issue(
    tx: Tx,
    actor: PlatformActorContext,
    subscriptionId: string,
    body: PlatformExceptionalRefundBody,
    client: ClientInfo,
  ) {
    const reason = (body.reason ?? '').trim();
    if (reason.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    const seen = await subscriptionById(tx, subscriptionId);
    if (!seen) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
    if ((seen.status !== 'active' && seen.status !== 'frozen') || seen.periods_paid < 1)
      throw notRefundable(seen);
    const period = await periodOf(tx, seen.id, seen.periods_paid);
    if (!period) throw notRefundable(seen);
    const payment = await paymentById(tx, period.online_payment_id, true);
    const sub = await subscriptionById(tx, subscriptionId, true);
    if (
      !payment ||
      !sub ||
      (sub.status !== 'active' && sub.status !== 'frozen') ||
      sub.periods_paid !== period.seq
    )
      throw notRefundable(seen);
    const plan = await policyOf(tx, sub);
    const amount = Math.min(
      await unusedShareHalalas(tx, sub, period),
      payment.amount_halalas - payment.refunded_halalas,
    );
    if (amount <= 0)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'subscription', issue: 'nothing_to_refund' }],
      });
    const remaining =
      termOf(sub) && plan.service_weekdays_mask
        ? refundableDays(tx.now, sub, plan.service_weekdays_mask)
        : null;
    const issued = await this.refunds.issue(
      tx,
      actor,
      payment.id,
      { amount_halalas: amount, reason },
      client,
    );
    const who: SubActor = {
      type: 'platform',
      userId: actor.userId,
      role: actor.role,
      requestId: client.requestId,
    };
    await transition(
      tx,
      sub,
      'exceptional_refund',
      {
        ...endPatch(tx, sub, 'exceptional_refund'),
        cancel_at_period_end: false,
        cancel_requested_at: null,
        refund_due_at: new Date(tx.now.getTime() + SERVICE_DAY_RULES.exceptional_refund_sla_days * DAY_MS),
      },
      who,
      {
        refund_id: issued.refund.id,
        refund_halalas: amount,
        remaining_days: remaining,
        term_days: plan.service_days,
        reason,
      },
    );
    return { refund: issued.refund, amount_halalas: amount, remaining_days: remaining };
  }
}
