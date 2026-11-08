import { newId } from '../../../core/crypto/ids.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  RetryableJobError,
  backoffMs,
  STALE_TIMER,
  type JobContext,
  type JobHandler,
  type JobResult,
} from '../../../core/outbox/dispatcher.js';
import { OnlinePayments, type PaymentsRuntime } from '../../payments-online/index.js';
import {
  PENDING_PAYMENT_EXPIRE_JOB,
  renewalGivenId,
  SUBSCRIPTION_GRACE_EXPIRE_JOB,
  SUBSCRIPTION_RENEW_JOB,
  SUBSCRIPTION_RENEWAL_NOTICE_JOB,
} from '../domain/jobs.js';
import { endPatch, expire, recordRenewalFailure, sendRenewalNotice, transition } from './machine.js';
import { subscriptionById, type SubscriptionRow } from './rows.js';

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const system = { type: 'system' as const, name: 'subscriptions' };

/** The timer still names the subscription's current period (an unfreeze moves the end: older timers are stale). */
function samePeriod(sub: SubscriptionRow, payload: Record<string, unknown>): boolean {
  const end = str(payload.period_end);
  return (
    num(payload.seq) === sub.periods_paid + 1 &&
    !!end &&
    !!sub.current_period_end &&
    sub.current_period_end.getTime() === Date.parse(end)
  );
}

/** `job.pending_payment_expire` (tx): a checkout unpaid after 30 minutes is canceled (04 §1). */
export const pendingPaymentExpireJob: JobHandler = {
  type: PENDING_PAYMENT_EXPIRE_JOB,
  mode: 'tx',
  async handle({ row, tx }): Promise<JobResult> {
    const sub = await subscriptionById(tx!, str(row.payload?.subscription_id) ?? '', true);
    if (!sub || sub.status !== 'pending_payment') return STALE_TIMER;
    if (sub.pending_expires_at && sub.pending_expires_at > tx!.now) return STALE_TIMER;
    await transition(tx!, sub, 'pending_expired', endPatch(tx!, sub, 'pending_expired'), system);
  },
};

/** `job.subscription_renewal_notice` (tx): 3 days before the end, the notice and the price it announces. */
export const renewalNoticeJob: JobHandler = {
  type: SUBSCRIPTION_RENEWAL_NOTICE_JOB,
  mode: 'tx',
  async handle({ row, tx }): Promise<JobResult> {
    const sub = await subscriptionById(tx!, str(row.payload?.subscription_id) ?? '', true);
    if (!sub || sub.status !== 'active' || sub.cancel_at_period_end) return STALE_TIMER;
    if (!samePeriod(sub, row.payload ?? {})) return STALE_TIMER;
    if (sub.renewal_notice_for && sub.renewal_notice_for.getTime() === sub.current_period_end!.getTime())
      return STALE_TIMER;
    await sendRenewalNotice(tx!, sub);
  },
};

/**
 * `job.subscription_grace_expire` (tx): the safety net one hour after the grace (04 §1 «انتهاء السماح»): a
 * subscription still past due — its third attempt could not run or still waits for an answer — expires.
 */
export const graceExpireJob: JobHandler = {
  type: SUBSCRIPTION_GRACE_EXPIRE_JOB,
  mode: 'tx',
  async handle({ row, tx }): Promise<JobResult> {
    const sub = await subscriptionById(tx!, str(row.payload?.subscription_id) ?? '', true);
    if (!sub || sub.status !== 'past_due' || !samePeriod(sub, row.payload ?? {})) return STALE_TIMER;
    if (sub.grace_ends_at && sub.grace_ends_at > tx!.now) return STALE_TIMER;
    await expire(tx!, sub, system, { cause: 'grace_timer' });
  },
};

type Prepared =
  | { kind: 'done'; stale: boolean }
  | { kind: 'charge'; paymentId: string; token: string; amount: number; subscriptionId: string; attempt: number }
  | { kind: 'resend'; paymentId: string; token: string; amount: number; subscriptionId: string; attempt: number };

/**
 * `job.subscription_renew` (external; DEC-533): the renewal at the end of a period and its grace retries (day 1, day 3).
 * 1. one transaction, the subscription locked: still this period and this attempt (else stale); `cancel_at_period_end`
 *    → canceled at the end (no renewal); no saved card or an account not active → a failed attempt without a
 *    charge; otherwise the `initiated` payment of this period and attempt (its given_id derived from both: a re-run
 *    finds it and sends the same given_id again — the gateway never charges twice);
 * 2. the gateway charges the account's default saved card (`chargeSavedMethod`, merchant-initiated, outside any
 *    transaction); `paid` starts the next period in the payment's own transaction (the payments-online hook), a
 *    decline is the failed attempt (the hook), an unreachable gateway retries the job with the same given_id;
 * 3. a charge answered `initiated` (3-D Secure asked while nobody is there to answer it) counts as a failed attempt;
 *    the payment stays as the gateway says, and a late `paid` still renews (or is refunded once another one paid).
 */
export function subscriptionRenewJob(runtime: () => PaymentsRuntime): JobHandler {
  return {
    type: SUBSCRIPTION_RENEW_JOB,
    mode: 'external',
    async handle(ctx): Promise<JobResult> {
      const rt = runtime();
      const prepared = await ctx.db.transaction((tx) => prepare(tx, rt, ctx));
      if (prepared.kind === 'done') return prepared.stale ? STALE_TIMER : undefined;
      const payments = new OnlinePayments(ctx.db, rt);
      let actionUrl: string | null = null;
      let status: string | null = null;
      try {
        const sent = await payments.sendInitiated(prepared.paymentId, {
          source: { type: 'saved', paymentMethodId: '', token: prepared.token },
          callbackUrl: rt.env.CUSTOMER_PAY_CALLBACK_URL,
          amountHalalas: prepared.amount,
          purpose: 'subscription',
          subscriptionId: prepared.subscriptionId,
        });
        actionUrl = sent.actionUrl;
        status = sent.payment.status;
      } catch (e) {
        if (e instanceof AppError && e.code === 'PAYMENT_FAILED') return; // the hook counted the failure
        if (e instanceof AppError && (e.code === 'DEPENDENCY_TIMEOUT' || e.code === 'SERVICE_UNAVAILABLE'))
          throw new RetryableJobError(e.code, backoffMs(ctx.row.attempts + 1));
        throw e;
      }
      if (status === 'initiated' || status === 'authorized') {
        await ctx.db.transaction(async (tx) => {
          const sub = await subscriptionById(tx, prepared.subscriptionId, true);
          if (!sub) return;
          await recordRenewalFailure(tx, sub, {
            attempt: prepared.attempt,
            reason: actionUrl ? 'authentication_required' : 'not_captured',
            paymentId: prepared.paymentId,
          });
        });
      }
    },
  };
}

async function prepare(tx: Tx, rt: PaymentsRuntime, ctx: JobContext): Promise<Prepared> {
  const payload = ctx.row.payload ?? {};
  const sub = await subscriptionById(tx, str(payload.subscription_id) ?? '', true);
  const attempt = num(payload.attempt) ?? 0;
  if (!sub || (sub.status !== 'active' && sub.status !== 'past_due')) return { kind: 'done', stale: true };
  if (!samePeriod(sub, payload) || attempt !== sub.renewal_attempts) return { kind: 'done', stale: true };
  if (tx.now < sub.current_period_end!) return { kind: 'done', stale: true };
  if (sub.status === 'active' && sub.cancel_at_period_end) {
    await transition(tx, sub, 'period_end_canceled', endPatch(tx, sub, 'period_end'), system, {
      period_end: sub.current_period_end!.toISOString(),
    });
    return { kind: 'done', stale: false };
  }
  const seq = sub.periods_paid + 1;
  const givenId = renewalGivenId(sub.id, seq, attempt);
  const card = await tx.maybeOne<{ id: string; token: string; account_status: string }>(
    `SELECT m.id, m.gateway_token AS token, a.status AS account_status
       FROM customer_accounts a
       LEFT JOIN customer_payment_methods m ON m.account_id = a.id AND m.is_default AND m.removed_at IS NULL
                                           AND m.pending_payment_id IS NULL
      WHERE a.id = $1`,
    [sub.account_id],
  );
  const prior = await tx.maybeOne<{ id: string; status: string; gateway_payment_id: string | null }>(
    `SELECT id, status, gateway_payment_id FROM online_payments WHERE given_id = $1 AND org_id = $2`,
    [givenId, sub.org_id],
  );
  const amount = sub.next_price_halalas ?? sub.price_halalas;
  if (prior) {
    // this attempt ran already: resent only if it never reached the gateway, else its outcome is the hook's
    if (prior.status === 'initiated' && !prior.gateway_payment_id && card?.token)
      return { kind: 'resend', paymentId: prior.id, token: card.token, amount, subscriptionId: sub.id, attempt };
    return { kind: 'done', stale: true };
  }
  if (!card || card.account_status !== 'active' || !card.id) {
    await recordRenewalFailure(tx, sub, {
      attempt,
      reason: card?.account_status !== 'active' ? 'account_unavailable' : 'no_saved_card',
      paymentId: null,
    });
    return { kind: 'done', stale: false };
  }
  const paymentId = newId();
  await new OnlinePayments(ctx.db, rt).begin(tx, {
    id: paymentId,
    givenId,
    accountId: sub.account_id,
    purpose: 'subscription',
    subscriptionId: sub.id,
    subscriptionPeriodSeq: seq,
    orgId: sub.org_id,
    venueId: sub.venue_id,
    amountHalalas: amount,
    source: { type: 'saved', paymentMethodId: card.id, token: card.token },
    callbackUrl: rt.env.CUSTOMER_PAY_CALLBACK_URL,
  });
  return { kind: 'charge', paymentId, token: card.token, amount, subscriptionId: sub.id, attempt };
}

/** The worker's subscription jobs (canon §7.2 V2 rows). */
export function subscriptionJobs(runtime: () => PaymentsRuntime): JobHandler[] {
  return [subscriptionRenewJob(runtime), graceExpireJob, renewalNoticeJob, pendingPaymentExpireJob];
}
