import {
  countServiceDays,
  freezeRequestCheck,
  resumedTermEnd,
  riyadhDate,
  riyadhMidnight,
  remainingServiceDays,
  type IsoDate,
  type SubscriptionFreezeStatus,
} from '@point/shared';
import type { CustomerSubscriptionFreezeBody } from '@point/shared/customer';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { STALE_TIMER, type JobHandler, type JobResult } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { SUBSCRIPTION_FREEZE_END_JOB, SUBSCRIPTION_FREEZE_START_JOB } from '../domain/jobs.js';
import {
  auditTransition,
  freeze,
  freezeReasonNow,
  publishSubscriptionUpdated,
  unfreeze,
  type SubActor,
} from './machine.js';
import { policyOf, subscriptionById, UUID, type PlanPolicyRow, type SubscriptionRow } from './rows.js';
import { termOf } from './terms.js';

/** A customer freeze (`subscription_freezes`, 0019; DEC-594). Dates are `YYYY-MM-DD` read as text. */
export interface FreezeRow {
  id: string;
  subscription_id: string;
  account_id: string;
  org_id: string;
  venue_id: string;
  period_seq: number;
  starts_on: string;
  returns_on: string;
  days: number;
  status: SubscriptionFreezeStatus;
  used_days: number | null;
  ended_on: string | null;
  end_reason: string | null;
  version: number;
  created_at: Date;
}

export const FREEZE_COLUMNS = `f.id, f.subscription_id, f.account_id, f.org_id, f.venue_id, f.period_seq,
  f.starts_on::text AS starts_on, f.returns_on::text AS returns_on, f.days, f.status, f.used_days,
  f.ended_on::text AS ended_on, f.end_reason, f.version, f.created_at`;

/** The freezes of a subscription's current term, newest first. */
export async function termFreezes(
  q: Pick<Tx, 'rows'>,
  sub: Pick<SubscriptionRow, 'id' | 'org_id' | 'periods_paid'>,
): Promise<FreezeRow[]> {
  return q.rows<FreezeRow>(
    `SELECT ${FREEZE_COLUMNS} FROM subscription_freezes f
      WHERE f.subscription_id = $1 AND f.org_id = $2 AND f.period_seq = $3
      ORDER BY f.created_at DESC, f.id DESC`,
    [sub.id, sub.org_id, sub.periods_paid],
  );
}

/** A freeze counts as this term's once it is scheduled, running or used (a withdrawn or canceled one does not). */
export const usesTheRight = (f: Pick<FreezeRow, 'status'>) =>
  f.status === 'scheduled' || f.status === 'active' || f.status === 'completed';

/** What C-14 may offer (the same rules the command checks). */
export function freezeOffer(
  sub: Pick<SubscriptionRow, 'status' | 'service_start_on' | 'service_end_on'>,
  plan: Pick<PlanPolicyRow, 'freeze_max_times'>,
  freezes: readonly FreezeRow[],
): { left: number; canFreeze: boolean; live: FreezeRow | null } {
  const used = freezes.filter(usesTheRight).length;
  const live = freezes.find((f) => f.status === 'scheduled' || f.status === 'active') ?? null;
  const left = Math.max(0, plan.freeze_max_times - used);
  return { left, live, canFreeze: sub.status === 'active' && !!termOf(sub) && left > 0 && !live };
}

/** The last counted day the term will have if a freeze runs as asked (C-14 shows it before and while it runs). */
export function projectedEnd(
  sub: Pick<SubscriptionRow, 'service_start_on' | 'service_end_on' | 'frozen_remaining_days' | 'status'>,
  f: Pick<FreezeRow, 'starts_on' | 'returns_on' | 'status'>,
  mask: number,
): IsoDate | null {
  const term = termOf(sub);
  if (!term) return null;
  if (f.status === 'active' && sub.status === 'frozen' && sub.frozen_remaining_days !== null)
    return sub.frozen_remaining_days > 0
      ? resumedTermEnd(f.returns_on, sub.frozen_remaining_days, mask)
      : term.endOn;
  if (f.status !== 'scheduled') return null;
  const remaining = remainingServiceDays(f.starts_on, term, mask);
  return remaining > 0 ? resumedTermEnd(f.returns_on, remaining, mask) : term.endOn;
}

const unavailable = (reason: 'not_offered' | 'used' | 'live' | 'status') =>
  new AppError('SUBSCRIPTION_FREEZE_UNAVAILABLE', { reason });

async function liveFreeze(tx: Tx, sub: SubscriptionRow): Promise<FreezeRow | null> {
  return tx.maybeOne<FreezeRow>(
    `SELECT ${FREEZE_COLUMNS} FROM subscription_freezes f
      WHERE f.subscription_id = $1 AND f.org_id = $2 AND f.status IN ('scheduled','active')
      FOR NO KEY UPDATE`,
    [sub.id, sub.org_id],
  );
}

/**
 * C-14 «تجميد» (DEC-594; annex clause 4), the subscription row locked by the caller: an `active` counted-day term
 * whose plan offers a freeze, none scheduled or running, the term's allowance not used, and dates that pass
 * `freezeRequestCheck` (ahead of today, service days, within the plan's counted days). The freeze is scheduled: it
 * starts at the Riyadh midnight of its first day (`job.subscription_freeze_start`).
 */
export async function requestFreeze(
  tx: Tx,
  sub: SubscriptionRow,
  body: CustomerSubscriptionFreezeBody,
  actor: SubActor,
): Promise<void> {
  const plan = await policyOf(tx, sub);
  const term = termOf(sub);
  if (plan.freeze_max_times < 1 || !term || !plan.freeze_max_days) throw unavailable('not_offered');
  if (sub.status !== 'active') throw unavailable('status');
  if (await liveFreeze(tx, sub)) throw unavailable('live');
  const offer = freezeOffer(sub, plan, await termFreezes(tx, sub));
  if (offer.left < 1) throw unavailable('used');
  const check = freezeRequestCheck({
    today: riyadhDate(tx.now),
    startsOn: body.starts_on,
    returnsOn: body.returns_on,
    term,
    mask: plan.service_weekdays_mask!,
    maxDays: plan.freeze_max_days,
  });
  if (!check.ok)
    throw new AppError('SUBSCRIPTION_FREEZE_INVALID', { issue: check.issue, max_days: plan.freeze_max_days });
  const f = await tx.one<FreezeRow>(
    `INSERT INTO subscription_freezes AS f (subscription_id, account_id, org_id, venue_id, period_seq, starts_on,
                                            returns_on, days, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${FREEZE_COLUMNS}`,
    [
      sub.id,
      sub.account_id,
      sub.org_id,
      sub.venue_id,
      sub.periods_paid,
      body.starts_on,
      body.returns_on,
      check.days,
      tx.now,
    ],
  );
  await schedule(tx, SUBSCRIPTION_FREEZE_START_JOB, riyadhMidnight(f.starts_on), {
    orgId: sub.org_id,
    venueId: sub.venue_id,
    aggregate: { type: 'subscription', id: sub.id, version: sub.version },
    dedupeKey: `subscription_freeze_start:${f.id}`,
    payload: { subscription_id: sub.id, freeze_id: f.id },
  });
  await auditTransition(tx, sub, 'subscription.freeze_requested', actor, {
    freeze_id: f.id,
    starts_on: f.starts_on,
    returns_on: f.returns_on,
    days: f.days,
  });
  await publishSubscriptionUpdated(tx, sub);
}

/**
 * C-14 «إلغاء التجميد» / «أعد التفعيل الآن» (DEC-594): a scheduled freeze is withdrawn (it never started: the
 * allowance is not used); a running one ends today — an early reactivation: the remaining counted days resume today
 * (today counts when it serves) and the freeze is used, however short.
 */
export async function endFreezeEarly(tx: Tx, sub: SubscriptionRow, actor: SubActor): Promise<void> {
  const f = await liveFreeze(tx, sub);
  if (!f) throw unavailable('status');
  const today = riyadhDate(tx.now);
  if (f.status === 'scheduled') {
    await closeFreeze(tx, f, 'withdrawn', { endedOn: today, reason: 'withdrawn' });
    await auditTransition(tx, sub, 'subscription.freeze_withdrawn', actor, { freeze_id: f.id });
    await publishSubscriptionUpdated(tx, sub);
    return;
  }
  if (sub.status !== 'frozen' || sub.frozen_reason !== 'customer_freeze') throw unavailable('status');
  const plan = await policyOf(tx, sub);
  await closeFreeze(tx, f, 'completed', {
    endedOn: today,
    reason: 'early_reactivation',
    usedDays: countServiceDays(f.starts_on, today, plan.service_weekdays_mask!),
  });
  await unfreeze(tx, sub, actor, {
    resumeOn: today,
    metadata: { freeze_id: f.id, early_reactivation: true },
  });
}

async function closeFreeze(
  tx: Tx,
  f: FreezeRow,
  status: 'completed' | 'withdrawn' | 'canceled',
  o: { endedOn: IsoDate; reason: string; usedDays?: number },
): Promise<void> {
  await tx.query(
    `UPDATE subscription_freezes SET status = $3, ended_on = $4, end_reason = $5, used_days = $6,
            version = version + 1
      WHERE id = $1 AND org_id = $2`,
    [f.id, f.org_id, status, o.endedOn, o.reason, o.usedDays ?? (status === 'completed' ? 0 : null)],
  );
}

const str = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : '');
const system: SubActor = { type: 'system', name: 'subscriptions' };

async function lockedPair(
  tx: Tx,
  payload: Record<string, unknown> | null | undefined,
): Promise<{ sub: SubscriptionRow; f: FreezeRow } | null> {
  // the subscription row first, then its freeze (the order of every subscription command)
  const sub = await subscriptionById(tx, str(payload?.subscription_id), true);
  if (!sub) return null;
  const f = await tx.maybeOne<FreezeRow>(
    `SELECT ${FREEZE_COLUMNS} FROM subscription_freezes f WHERE f.id = $1 AND f.subscription_id = $2
      FOR NO KEY UPDATE`,
    [str(payload?.freeze_id), sub.id],
  );
  return f ? { sub, f } : null;
}

/**
 * `job.subscription_freeze_start` (tx; DEC-594): at the Riyadh midnight of the first day, the scheduled freeze of an
 * `active` term starts — the service and the count stop (`frozen`, `customer_freeze`, frozen at that midnight so the
 * day is not consumed). A subscription no longer active by then (ended, or frozen by the operator) cancels the
 * freeze without using the allowance.
 */
export const freezeStartJob: JobHandler = {
  type: SUBSCRIPTION_FREEZE_START_JOB,
  mode: 'tx',
  async handle({ row, tx: maybeTx }): Promise<JobResult> {
    const tx = maybeTx!;
    const pair = await lockedPair(tx, row.payload);
    if (!pair || pair.f.status !== 'scheduled') return STALE_TIMER;
    const { sub, f } = pair;
    const at = riyadhMidnight(f.starts_on);
    if (tx.now < at) return STALE_TIMER;
    if (sub.status !== 'active' || sub.periods_paid !== f.period_seq) {
      await closeFreeze(tx, f, 'canceled', { endedOn: riyadhDate(tx.now), reason: 'not_active' });
      await auditTransition(tx, sub, 'subscription.freeze_canceled', system, {
        freeze_id: f.id,
        status: sub.status,
      });
      return;
    }
    await tx.query(
      `UPDATE subscription_freezes SET status = 'active', version = version + 1 WHERE id = $1 AND org_id = $2`,
      [f.id, f.org_id],
    );
    const frozen = await freeze(tx, sub, 'customer_freeze', system, { at, metadata: { freeze_id: f.id } });
    await schedule(tx, SUBSCRIPTION_FREEZE_END_JOB, riyadhMidnight(f.returns_on), {
      orgId: sub.org_id,
      venueId: sub.venue_id,
      aggregate: { type: 'subscription', id: sub.id, version: frozen.version },
      dedupeKey: `subscription_freeze_end:${f.id}`,
      payload: { subscription_id: sub.id, freeze_id: f.id },
    });
  },
};

/**
 * `job.subscription_freeze_end` (tx; DEC-594): at the Riyadh midnight of the return day the freeze ends and the
 * remaining counted days resume from that day (the end recomputed). Ended early already, or the subscription ended
 * meanwhile: nothing (a freeze of an ended subscription is closed as canceled).
 */
export const freezeEndJob: JobHandler = {
  type: SUBSCRIPTION_FREEZE_END_JOB,
  mode: 'tx',
  async handle({ row, tx: maybeTx }): Promise<JobResult> {
    const tx = maybeTx!;
    const pair = await lockedPair(tx, row.payload);
    if (!pair || pair.f.status !== 'active') return STALE_TIMER;
    const { sub, f } = pair;
    if (tx.now < riyadhMidnight(f.returns_on)) return STALE_TIMER;
    const plan = await policyOf(tx, sub);
    if (sub.status !== 'frozen' || sub.frozen_reason !== 'customer_freeze') {
      await closeFreeze(tx, f, 'canceled', {
        endedOn: f.returns_on,
        reason: 'subscription_ended',
        usedDays: countServiceDays(f.starts_on, f.returns_on, plan.service_weekdays_mask!),
      });
      return;
    }
    await closeFreeze(tx, f, 'completed', {
      endedOn: f.returns_on,
      reason: 'returned',
      usedDays: countServiceDays(f.starts_on, f.returns_on, plan.service_weekdays_mask!),
    });
    const resumed = await unfreeze(tx, sub, system, {
      resumeOn: f.returns_on,
      metadata: { freeze_id: f.id },
    });
    // the operator suspended (or the venue closed under a «freeze» closure policy) meanwhile: frozen again for that
    const block = await freezeReasonNow(tx, resumed);
    if (block === 'operator_suspended' || (block === 'venue_inactive' && plan.closure_policy === 'freeze'))
      await freeze(tx, resumed, block, system);
  },
};
