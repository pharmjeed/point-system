import {
  addBillingPeriods,
  addDays,
  canTransitionSubscription,
  OPERATOR_BLOCKED_STATUSES,
  proratedRefundHalalas,
  remainingServiceDays,
  resumedTermEnd,
  riyadhDate,
  riyadhMidnight,
  serviceDaysRefundHalalas,
  serviceTerm,
  serviceTermInstants,
  SUBSCRIPTION_RULES,
  type IsoDate,
  type SubscriptionEndedReason,
  type SubscriptionFrozenReason,
  type SubscriptionStatus,
  type SubscriptionTransition,
} from '@point/shared';
import { customerRoom, type CustomerSubscriptionPushKind } from '@point/shared/customer';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { planCustomerPush } from '../../customer-accounts/index.js';
import { issueSystemRefund, paymentById, type OnlinePaymentRow } from '../../payments-online/index.js';
import {
  PENDING_PAYMENT_EXPIRE_JOB,
  SUBSCRIPTION_GRACE_EXPIRE_JOB,
  SUBSCRIPTION_RENEW_JOB,
  SUBSCRIPTION_RENEWAL_NOTICE_JOB,
} from '../domain/jobs.js';
import {
  PERIOD_COLUMNS,
  policyOf,
  SUBSCRIPTION_COLUMNS,
  type PeriodRow,
  type PlanPolicyRow,
  type SubscriptionRow,
} from './rows.js';
import { firstUnconsumedAt, isServiceDaysPlan, refundableDays, resumeDay, termOf } from './terms.js';

const DAY_MS = 86_400_000;
const { grace_days, retry_offsets_days, renewal_notice_days, grace_expire_margin_minutes } =
  SUBSCRIPTION_RULES;

/** Who moved a subscription (the audit rows of the transition). */
export type SubActor =
  | {
      type: 'customer';
      accountId: string;
      requestId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    }
  | { type: 'platform'; userId: string; role: string; requestId?: string | null }
  | { type: 'system'; name: string; requestId?: string | null };

const systemActor = (name: string): SubActor => ({ type: 'system', name });

/**
 * One transition of the machine of docs/v2/04 §1 (DEC-532) on a locked row: the guard of
 * `SUBSCRIPTION_TRANSITIONS`, the update with the version check, `subscription.<event>` in platform_audit_log
 * (POINT's record, never the operator's audit_log: V2-D12) and in the customer's customer_audit_log, and
 * `subscription.updated` on the customer socket — all in the caller's transaction.
 */
export async function transition(
  tx: Tx,
  sub: SubscriptionRow,
  event: SubscriptionTransition,
  patch: Record<string, unknown>,
  actor: SubActor,
  metadata: Record<string, unknown> = {},
): Promise<SubscriptionRow> {
  if (!canTransitionSubscription(sub.status, event))
    throw new InvariantViolation(`subscription ${sub.id}: ${event} from ${sub.status}`);
  const cols = Object.keys(patch);
  const updated = await tx.one<SubscriptionRow>(
    `UPDATE subscriptions s SET ${[...cols.map((c, i) => `${c} = $${i + 3}`), 'version = s.version + 1'].join(', ')}
      WHERE s.id = $1 AND s.version = $2 RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [sub.id, sub.version, ...cols.map((c) => patch[c])],
  );
  await auditTransition(tx, updated, `subscription.${event}`, actor, {
    from_status: sub.status,
    to_status: updated.status,
    ...metadata,
  });
  await publishSubscriptionUpdated(tx, updated);
  return updated;
}

export async function auditTransition(
  tx: Tx,
  sub: Pick<SubscriptionRow, 'id' | 'account_id' | 'venue_id' | 'org_id'>,
  action: string,
  actor: SubActor,
  metadata: Record<string, unknown>,
): Promise<void> {
  const meta = { venue_id: sub.venue_id, org_id: sub.org_id, ...metadata };
  await platformAudit(tx, {
    actor:
      actor.type === 'platform'
        ? { type: 'platform_user', id: actor.userId, role: actor.role }
        : { type: 'system', id: null, name: actor.type === 'customer' ? 'customer' : actor.name },
    action,
    entityType: 'subscription',
    entityId: sub.id,
    orgId: null,
    requestId: actor.requestId ?? null,
    metadata: meta,
  });
  await customerAudit(tx, {
    actor:
      actor.type === 'customer'
        ? { type: 'customer', accountId: actor.accountId }
        : { type: 'system', name: actor.type === 'platform' ? 'platform' : actor.name },
    accountId: sub.account_id,
    action,
    entityType: 'subscription',
    entityId: sub.id,
    requestId: actor.requestId ?? null,
    ...(actor.type === 'customer' ? { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null } : {}),
    metadata: meta,
  });
}

/** `subscription.updated` in the account's room (DEC-520's customer namespace; pg_notify in this transaction). */
export async function publishSubscriptionUpdated(
  tx: Tx,
  sub: Pick<SubscriptionRow, 'id' | 'account_id' | 'org_id' | 'status'>,
): Promise<void> {
  await publishRealtime(tx, sub.org_id, [customerRoom(sub.account_id)], {
    event: 'subscription.updated',
    id: newId(),
    data: { subscription_id: sub.id, status: sub.status },
  });
}

export async function push(
  tx: Tx,
  sub: Pick<SubscriptionRow, 'id' | 'account_id' | 'org_id' | 'venue_id'>,
  kind: CustomerSubscriptionPushKind,
  ref: string,
) {
  await planCustomerPush(tx, {
    accountId: sub.account_id,
    orgId: sub.org_id,
    venueId: sub.venue_id,
    kind,
    subscriptionId: sub.id,
    ref: `${sub.id}:${ref}`,
  });
}

// ------------------------------------------------------------------------------------------------ timers

const timerRow = (sub: SubscriptionRow) => ({
  orgId: sub.org_id,
  venueId: sub.venue_id,
  aggregate: { type: 'subscription', id: sub.id, version: sub.version },
});
const later = (tx: Tx, at: number) => new Date(Math.max(at, tx.now.getTime()));

/**
 * The timers of a period that just started or moved (DEC-533): the renewal notice 3 days before the end and the
 * first renewal attempt at the end. The keys carry the end itself, so a period moved by an unfreeze schedules new
 * timers and the old ones find the end changed (stale).
 */
export async function scheduleCycleTimers(tx: Tx, sub: SubscriptionRow): Promise<void> {
  const end = sub.current_period_end!;
  const seq = sub.periods_paid + 1;
  const key = `${sub.id}:${seq}:${end.getTime()}`;
  const payload = { subscription_id: sub.id, seq, period_end: end.toISOString() };
  await schedule(
    tx,
    SUBSCRIPTION_RENEWAL_NOTICE_JOB,
    later(tx, end.getTime() - renewal_notice_days * DAY_MS),
    {
      ...timerRow(sub),
      dedupeKey: `subscription_renewal_notice:${key}`,
      payload,
    },
  );
  await schedule(tx, SUBSCRIPTION_RENEW_JOB, later(tx, end.getTime()), {
    ...timerRow(sub),
    dedupeKey: `subscription_renew:${key}:0`,
    payload: { ...payload, attempt: 0 },
  });
}

async function scheduleRetry(tx: Tx, sub: SubscriptionRow, attempt: number): Promise<void> {
  const end = sub.current_period_end!;
  const seq = sub.periods_paid + 1;
  await schedule(
    tx,
    SUBSCRIPTION_RENEW_JOB,
    later(tx, end.getTime() + retry_offsets_days[attempt]! * DAY_MS),
    {
      ...timerRow(sub),
      dedupeKey: `subscription_renew:${sub.id}:${seq}:${end.getTime()}:${attempt}`,
      payload: { subscription_id: sub.id, seq, period_end: end.toISOString(), attempt },
    },
  );
}

export async function schedulePendingExpiry(tx: Tx, sub: SubscriptionRow): Promise<void> {
  await schedule(tx, PENDING_PAYMENT_EXPIRE_JOB, sub.pending_expires_at!, {
    ...timerRow(sub),
    dedupeKey: `pending_payment_expire:${sub.id}`,
    payload: { subscription_id: sub.id },
  });
}

// ------------------------------------------------------------------------------------------------ payments

export async function periodOf(tx: Tx, subscriptionId: string, seq: number): Promise<PeriodRow | null> {
  return tx.maybeOne<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM subscription_periods sp WHERE sp.subscription_id = $1 AND sp.seq = $2`,
    [subscriptionId, seq],
  );
}

/** Whether the venue's operator or the venue itself keeps the subscription from running (V2-034). */
export async function freezeReasonNow(
  tx: Tx,
  sub: Pick<SubscriptionRow, 'org_id' | 'venue_id'>,
): Promise<SubscriptionFrozenReason | 'terminated' | null> {
  const r = await tx.one<{ operator_status: string; venue_status: string }>(
    `SELECT o.operator_status, v.status AS venue_status
       FROM venues v JOIN organizations o ON o.id = v.org_id
      WHERE v.id = $1 AND v.org_id = $2`,
    [sub.venue_id, sub.org_id],
  );
  if (r.operator_status === 'terminated') return 'terminated';
  if ((OPERATOR_BLOCKED_STATUSES as readonly string[]).includes(r.operator_status))
    return 'operator_suspended';
  if (r.venue_status !== 'active') return 'venue_inactive';
  return null;
}

/**
 * A subscription payment counts for the first time (the hook of payments-online, the payment row locked by the
 * caller): it pays the first period (pending_payment → active), the next one (active → active, past_due → active, the
 * new period starting at the old end: no free extension, 04 §1), or nothing — then the money goes back at once
 * (DEC-523's system refund): a period paid already (`double_payment`), a subscription that ended or is frozen
 * (`not_due`). An activation while the operator is suspended or the venue closed starts frozen (V2-034).
 */
export async function onSubscriptionPaid(tx: Tx, p: OnlinePaymentRow): Promise<void> {
  const sub = await tx.maybeOne<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s WHERE s.id = $1 FOR NO KEY UPDATE`,
    [p.subscription_id],
  );
  if (!sub) return;
  const seq = p.subscription_period_seq ?? 0;
  const refund = (reason: 'double_payment' | 'not_due', why: string) =>
    issueSystemRefund(tx, p, reason, { subscription_id: sub.id, subscription_status: sub.status, why });
  if (await periodOf(tx, sub.id, seq)) return void (await refund('double_payment', 'period_paid'));
  if (seq !== sub.periods_paid + 1) return void (await refund('not_due', 'period_mismatch'));
  const live: readonly SubscriptionStatus[] = ['pending_payment', 'active', 'past_due'];
  if (!live.includes(sub.status)) return void (await refund('not_due', 'not_live'));
  const block = await freezeReasonNow(tx, sub);
  if (block === 'terminated') {
    await refund('not_due', 'operator_terminated');
    if (sub.status !== 'canceled')
      await transition(
        tx,
        sub,
        'operator_terminated',
        endPatch(tx, sub, 'operator_terminated'),
        systemActor('subscriptions'),
        { online_payment_id: p.id },
      );
    return;
  }
  const now = tx.now;
  const first = sub.status === 'pending_payment';
  const anchor = first ? now : sub.cycle_anchor_at!;
  const planId = first ? sub.plan_id : (sub.next_plan_id ?? sub.plan_id);
  const plan = await policyOf(tx, { plan_id: planId, org_id: sub.org_id });
  let start = first ? now : sub.current_period_end!;
  let end = addBillingPeriods(anchor, sub.billing_cycle, seq);
  // 04 §7 (DEC-591): a counted-day term runs from its first counted day to the midnight after its N-th
  let term: { startOn: IsoDate; endOn: IsoDate } | null = null;
  if (isServiceDaysPlan(plan)) {
    term = serviceTerm(now, plan.service_days!, plan.service_weekdays_mask!);
    ({ start, end } = serviceTermInstants(term));
  }
  await tx.query(
    `INSERT INTO subscription_periods (subscription_id, org_id, venue_id, seq, plan_id, billing_cycle, starts_at, ends_at,
                                       price_halalas, online_payment_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7)`,
    [sub.id, sub.org_id, sub.venue_id, seq, planId, sub.billing_cycle, start, end, p.amount_halalas, p.id],
  );
  const frozen = block && first ? block : null;
  const patch: Record<string, unknown> = {
    status: frozen ? 'frozen' : 'active',
    periods_paid: seq,
    cycle_anchor_at: anchor,
    current_period_start: start,
    current_period_end: end,
    price_halalas: p.amount_halalas,
    plan_id: planId,
    next_plan_id: null,
    next_price_halalas: null,
    pending_expires_at: null,
    grace_ends_at: null,
    renewal_attempts: 0,
    payment_method_id: p.payment_method_id ?? sub.payment_method_id,
    ...(first ? { activated_at: now } : {}),
    ...(frozen ? { frozen_at: now, frozen_reason: frozen } : {}),
    ...(term ? { service_start_on: term.startOn, service_end_on: term.endOn } : {}),
    ...(term && frozen ? { frozen_remaining_days: plan.service_days } : {}),
  };
  const event: SubscriptionTransition = first
    ? 'first_payment_paid'
    : sub.status === 'past_due'
      ? 'past_due_paid'
      : 'renewal_paid';
  const updated = await transition(tx, sub, event, patch, systemActor('payments'), {
    online_payment_id: p.id,
    seq,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    price_halalas: p.amount_halalas,
    ...(frozen ? { frozen_reason: frozen } : {}),
    ...(term ? { service_start_on: term.startOn, service_end_on: term.endOn } : {}),
  });
  if (frozen) {
    // the freeze is part of the activation: its own audit row, no timers until the unfreeze
    await auditTransition(tx, updated, 'subscription.freeze', systemActor('subscriptions'), {
      from_status: 'active',
      to_status: 'frozen',
      reason: frozen,
    });
    return;
  }
  await scheduleCycleTimers(tx, updated);
}

/**
 * A renewal attempt failed (declined, refused, 3-D Secure asked with nobody to answer it, no saved card): active →
 * past_due with the grace of 04 §1 and the «فشل الدفع» push (once per period), or one more failure of the grace; the
 * next attempt is scheduled on day 1 then day 3 after the end, and the third failure expires the subscription at once
 * (DEC-533). `attempt` is the attempt that failed: a duplicate report of it (a webhook after the job counted it)
 * changes nothing.
 */
export async function recordRenewalFailure(
  tx: Tx,
  sub: SubscriptionRow,
  failure: { attempt: number; reason: string; paymentId: string | null },
): Promise<SubscriptionRow | null> {
  if (sub.status !== 'active' && sub.status !== 'past_due') return null;
  if (failure.attempt !== sub.renewal_attempts) return null;
  const attempts = sub.renewal_attempts + 1;
  const meta = {
    attempt: failure.attempt,
    reason: failure.reason,
    seq: sub.periods_paid + 1,
    ...(failure.paymentId ? { online_payment_id: failure.paymentId } : {}),
  };
  if (attempts >= retry_offsets_days.length) {
    // the third failure ends the grace (the safety-net timer finds it expired already)
    if (sub.status === 'active') throw new InvariantViolation('a first failure cannot end the grace');
    return expire(tx, sub, systemActor('subscriptions'), meta);
  }
  const updated = await transition(
    tx,
    sub,
    'renewal_failed',
    {
      status: 'past_due',
      renewal_attempts: attempts,
      ...(sub.status === 'active'
        ? { grace_ends_at: new Date(sub.current_period_end!.getTime() + grace_days * DAY_MS) }
        : {}),
    },
    systemActor('subscriptions'),
    meta,
  );
  if (sub.status === 'active') {
    await push(tx, updated, 'subscription_payment_failed', `${updated.periods_paid + 1}`);
    await schedule(
      tx,
      SUBSCRIPTION_GRACE_EXPIRE_JOB,
      new Date(updated.grace_ends_at!.getTime() + grace_expire_margin_minutes * 60_000),
      {
        ...timerRow(updated),
        dedupeKey: `subscription_grace_expire:${updated.id}:${updated.periods_paid + 1}`,
        payload: {
          subscription_id: updated.id,
          seq: updated.periods_paid + 1,
          period_end: updated.current_period_end!.toISOString(),
        },
      },
    );
  }
  await scheduleRetry(tx, updated, attempts);
  return updated;
}

/** past_due → expired (04 §1 «انتهاء السماح»): the visits after it are paid; the «الانتهاء» push. */
export async function expire(
  tx: Tx,
  sub: SubscriptionRow,
  actor: SubActor,
  metadata: Record<string, unknown> = {},
): Promise<SubscriptionRow> {
  const updated = await transition(
    tx,
    sub,
    'grace_expired',
    { status: 'expired', grace_ends_at: null, ended_at: tx.now, ended_reason: 'grace_expired' },
    actor,
    metadata,
  );
  await push(tx, updated, 'subscription_expired', `${updated.periods_paid + 1}`);
  return updated;
}

export function endPatch(tx: Tx, sub: SubscriptionRow, reason: SubscriptionEndedReason) {
  return {
    status: 'canceled',
    ended_at: tx.now,
    ended_reason: reason,
    pending_expires_at: null,
    grace_ends_at: null,
    frozen_at: null,
    frozen_reason: null,
    frozen_remaining_days: null,
    next_plan_id: null,
    next_price_halalas: null,
    ...(sub.status === 'frozen' && sub.frozen_at
      ? { frozen_seconds_total: sub.frozen_seconds_total + frozenSeconds(tx, sub) }
      : {}),
  };
}

const frozenSeconds = (tx: Tx, sub: SubscriptionRow) =>
  sub.frozen_at ? Math.max(0, Math.floor((tx.now.getTime() - sub.frozen_at.getTime()) / 1000)) : 0;

/**
 * The renewal notice (job.subscription_renewal_notice, 3 days before the end; DEC-531): when the plan was replaced
 * (a price change on P-05), the replacement's price for the cycle becomes the next period's — announced in this push,
 * so that «the subscriber keeps the price until the next renewal after notice» holds. A plan retired without a
 * replacement, or whose replacement does not sell the cycle, keeps the subscriber's own price.
 */
interface PlanHop {
  id: string;
  status: string;
  replaced_by_plan_id: string | null;
  monthly: number | null;
  yearly: number | null;
}

export async function sendRenewalNotice(
  tx: Tx,
  sub: SubscriptionRow,
  policy?: Pick<PlanPolicyRow, 'renewal_mode'>,
): Promise<SubscriptionRow> {
  const manual = (policy ?? (await policyOf(tx, sub))).renewal_mode === 'manual';
  let nextPlan: { id: string; price: number } | null = null;
  let planId: string | null = sub.plan_id;
  for (let hop = 0; planId && hop < 10; hop++) {
    const p: PlanHop | null = await tx.maybeOne<PlanHop>(
      `SELECT id, status, replaced_by_plan_id, monthly_price_halalas::float8 AS monthly,
              yearly_price_halalas::float8 AS yearly
         FROM subscription_plans WHERE id = $1 AND org_id = $2`,
      [planId, sub.org_id],
    );
    if (!p) break;
    if (p.id !== sub.plan_id && p.status === 'active') {
      const price = sub.billing_cycle === 'yearly' ? p.yearly : p.monthly;
      if (price !== null) nextPlan = { id: p.id, price };
      break;
    }
    planId = p.replaced_by_plan_id;
  }
  const end = sub.current_period_end!;
  const updated = await transition(
    tx,
    sub,
    'renewal_notice',
    {
      renewal_notice_for: end,
      next_plan_id: nextPlan?.id ?? null,
      next_price_halalas: nextPlan ? nextPlan.price : null,
    },
    systemActor('subscriptions'),
    {
      period_end: end.toISOString(),
      price_halalas: sub.price_halalas,
      ...(nextPlan ? { next_plan_id: nextPlan.id, next_price_halalas: nextPlan.price } : {}),
    },
  );
  // DEC-595: a term renewed by hand is never charged — the notice says it ends and how to renew it
  await push(tx, updated, manual ? 'subscription_ending' : 'subscription_renewal', `${end.getTime()}`);
  return updated;
}

/**
 * The end of a term renewed by hand (`renewal_mode = manual`; DEC-595; annex clause 3 «لا يخصم مبلغ التجديد
 * تلقائيًا»): active → expired (`term_completed`) at the period end, nothing charged; the «الانتهاء» push. The
 * customer renews from C-14 with a new paid subscription.
 */
export async function completeTerm(
  tx: Tx,
  sub: SubscriptionRow,
  actor: SubActor,
  metadata: Record<string, unknown> = {},
): Promise<SubscriptionRow> {
  const updated = await transition(
    tx,
    sub,
    'term_completed',
    {
      status: 'expired',
      ended_at: tx.now,
      ended_reason: 'term_completed',
      cancel_at_period_end: false,
      cancel_requested_at: null,
    },
    actor,
    { period_end: sub.current_period_end?.toISOString() ?? null, ...metadata },
  );
  await push(tx, updated, 'subscription_expired', `${updated.periods_paid}:term`);
  return updated;
}

// ------------------------------------------------------------------------------------------------ freeze (V2-034)

/** active → frozen (04 §1: «تعليق المشغل أو إغلاق الموقع»): the days stop counting from now. */
export async function freeze(
  tx: Tx,
  sub: SubscriptionRow,
  reason: SubscriptionFrozenReason,
  actor: SubActor,
  opts: { at?: Date; metadata?: Record<string, unknown> } = {},
): Promise<SubscriptionRow> {
  const at = opts.at ?? tx.now;
  const patch: Record<string, unknown> = { status: 'frozen', frozen_at: at, frozen_reason: reason };
  const term = termOf(sub);
  if (term) {
    // DEC-593: the counted days not consumed when it froze resume when it is lifted
    const plan = await policyOf(tx, sub);
    patch.frozen_remaining_days = remainingServiceDays(
      firstUnconsumedAt(at),
      term,
      plan.service_weekdays_mask!,
    );
  }
  return transition(tx, sub, 'freeze', patch, actor, {
    reason,
    ...(term ? { remaining_days: patch.frozen_remaining_days } : {}),
    ...opts.metadata,
  });
}

/**
 * frozen → active with «تمديد مساوٍ» (04 §1, DEC-536): the period end and the cycle anchor move by the frozen time,
 * the paid period's row records it (extended_seconds), and the renewal timers are scheduled for the new end.
 */
export async function unfreeze(
  tx: Tx,
  sub: SubscriptionRow,
  actor: SubActor,
  opts: { resumeOn?: IsoDate; metadata?: Record<string, unknown> } = {},
): Promise<SubscriptionRow> {
  if (termOf(sub)) return unfreezeServiceDays(tx, sub, actor, opts);
  const ms = Math.max(0, tx.now.getTime() - sub.frozen_at!.getTime());
  const seconds = Math.floor(ms / 1000);
  const end = new Date(sub.current_period_end!.getTime() + seconds * 1000);
  const anchor = new Date(sub.cycle_anchor_at!.getTime() + seconds * 1000);
  await tx.query(
    `UPDATE subscription_periods SET ends_at = $3, extended_seconds = extended_seconds + $4
      WHERE subscription_id = $1 AND seq = $2`,
    [sub.id, sub.periods_paid, end, seconds],
  );
  const updated = await transition(
    tx,
    sub,
    'unfreeze',
    {
      status: 'active',
      frozen_at: null,
      frozen_reason: null,
      frozen_seconds_total: sub.frozen_seconds_total + seconds,
      current_period_end: end,
      cycle_anchor_at: anchor,
    },
    actor,
    {
      frozen_reason: sub.frozen_reason,
      frozen_seconds: seconds,
      period_end_before: sub.current_period_end!.toISOString(),
      period_end_after: end.toISOString(),
    },
  );
  await scheduleCycleTimers(tx, updated);
  return updated;
}

/**
 * frozen → active for a counted-day term (DEC-593; annex clause 4 «تستكمل الأيام المتبقية … وتحدّث نهاية الاشتراك
 * وفق الأيام المجمدة فعليًا»): the counted days left when it froze resume on the resume day (the freeze's return day,
 * or today on an early reactivation or when a system freeze is lifted) and the last day is the N-th service day from
 * it; Friday and Saturday are skipped again, nothing else is given back. The paid period's end follows.
 */
async function unfreezeServiceDays(
  tx: Tx,
  sub: SubscriptionRow,
  actor: SubActor,
  opts: { resumeOn?: IsoDate; metadata?: Record<string, unknown> },
): Promise<SubscriptionRow> {
  const plan = await policyOf(tx, sub);
  const resume = resumeDay(tx.now, sub, opts.resumeOn);
  const remaining = sub.frozen_remaining_days ?? 0;
  const lastDay =
    remaining > 0 ? resumedTermEnd(resume, remaining, plan.service_weekdays_mask!) : sub.service_end_on!;
  const end = riyadhMidnight(addDays(lastDay, 1));
  const moved = Math.max(0, Math.floor((end.getTime() - sub.current_period_end!.getTime()) / 1000));
  const frozenSecondsNow = Math.max(0, Math.floor((tx.now.getTime() - sub.frozen_at!.getTime()) / 1000));
  await tx.query(
    `UPDATE subscription_periods SET ends_at = $3, extended_seconds = extended_seconds + $4
      WHERE subscription_id = $1 AND seq = $2`,
    [sub.id, sub.periods_paid, end, moved],
  );
  const updated = await transition(
    tx,
    sub,
    'unfreeze',
    {
      status: 'active',
      frozen_at: null,
      frozen_reason: null,
      frozen_remaining_days: null,
      frozen_seconds_total: sub.frozen_seconds_total + frozenSecondsNow,
      current_period_end: end,
      service_end_on: lastDay,
    },
    actor,
    {
      frozen_reason: sub.frozen_reason,
      remaining_days: remaining,
      resume_on: resume,
      service_end_before: sub.service_end_on,
      service_end_after: lastDay,
      ...opts.metadata,
    },
  );
  await scheduleCycleTimers(tx, updated);
  return updated;
}

/**
 * The refund of the unused part of a paid term (DEC-536, DEC-600): a calendar term by time (from the freeze, or now,
 * to the end), a counted-day term by its counted days left out of all of them (annex clause 5).
 */
export async function unusedShareHalalas(tx: Tx, sub: SubscriptionRow, period: PeriodRow): Promise<number> {
  const plan = await policyOf(tx, sub);
  if (termOf(sub) && plan.service_days) {
    const days = refundableDays(tx.now, sub, plan.service_weekdays_mask!);
    return serviceDaysRefundHalalas(period.price_halalas, days, plan.service_days);
  }
  return proratedRefundHalalas(
    period.price_halalas,
    period.starts_at,
    sub.current_period_end!,
    sub.frozen_at ?? tx.now,
  );
}

/** Today in Riyadh, by the transaction's clock. */
export const todayOf = (tx: Tx) => riyadhDate(tx.now);

/**
 * The operator is terminated (V2-034, DEC-536): every live subscription of its venues ends (`operator_terminated`).
 * A paid period not used to its end is refunded pro rata by the platform (the unused share from the freeze — or from
 * now — to the end, `subscription_prorated`, DEC-523's system refund without the double-payment alert); a pending or
 * past-due one has no paid time left and is refunded nothing.
 */
export async function terminate(tx: Tx, sub: SubscriptionRow, actor: SubActor): Promise<SubscriptionRow> {
  let refund: { id: string | null; amount: number } | null = null;
  if ((sub.status === 'active' || sub.status === 'frozen') && sub.periods_paid > 0) {
    const period = await periodOf(tx, sub.id, sub.periods_paid);
    if (period) {
      const amount = await unusedShareHalalas(tx, sub, period);
      const payment = await paymentById(tx, period.online_payment_id);
      if (payment && amount > 0)
        refund = {
          amount,
          id: await issueSystemRefund(
            tx,
            payment,
            'subscription_prorated',
            { subscription_id: sub.id, seq: period.seq },
            {
              amountHalalas: Math.min(amount, payment.amount_halalas - payment.refunded_halalas),
              alert: false,
            },
          ),
        };
    }
  }
  return transition(tx, sub, 'operator_terminated', endPatch(tx, sub, 'operator_terminated'), actor, {
    ...(refund ? { refund_id: refund.id, refund_halalas: refund.amount } : { refund_halalas: 0 }),
  });
}
