import {
  planPrice,
  PLATFORM_REASON_MIN,
  SERVICE_DAY_RULES,
  type PlatformEligibilityDecisionBody,
  type PlatformEligibleStudentsBody,
  type SubscriptionEligibilitySource,
} from '@point/shared';
import type { CustomerSubscriptionApplyBody } from '@point/shared/customer';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { assertCapacity, assertOwnVehicles, lockAccount } from './checkout.js';
import {
  auditTransition,
  endPatch,
  publishSubscriptionUpdated,
  push,
  schedulePendingExpiry,
  transition,
  type SubActor,
} from './machine.js';
import { planById, subscriptionById, SUBSCRIPTION_COLUMNS, UUID, type SubscriptionRow } from './rows.js';

const DAY_MS = 86_400_000;

export interface EligibilityRow {
  id: string;
  subscription_id: string;
  account_id: string;
  plan_id: string;
  org_id: string;
  venue_id: string;
  kind: string;
  student_number: string;
  student_name: string;
  status: 'pending' | 'approved' | 'rejected';
  source: SubscriptionEligibilitySource | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  created_at: Date;
}

const ELIGIBILITY_COLUMNS = `e.id, e.subscription_id, e.account_id, e.plan_id, e.org_id, e.venue_id, e.kind,
  e.student_number, e.student_name, e.status, e.source, e.decided_by, e.decided_at, e.decision_reason, e.created_at`;

/** The student number as the customer sees it back: all masked but its last three characters (V2-D12 spirit). */
export const maskStudentNumber = (n: string) =>
  n.length <= 3 ? n : `${'•'.repeat(Math.min(6, n.length - 3))}${n.slice(-3)}`;

export async function eligibilityOf(
  q: Pick<Tx, 'maybeOne'>,
  sub: Pick<SubscriptionRow, 'id' | 'org_id'>,
  lock = false,
): Promise<EligibilityRow | null> {
  return q.maybeOne<EligibilityRow>(
    `SELECT ${ELIGIBILITY_COLUMNS} FROM subscription_eligibility e WHERE e.subscription_id = $1 AND e.org_id = $2
      ${lock ? 'FOR NO KEY UPDATE' : ''}`,
    [sub.id, sub.org_id],
  );
}

/**
 * An approval (DEC-596): the eligibility row decided, the subscription `pending_eligibility → pending_payment` with a
 * payment window of 7 days (`job.pending_payment_expire` ends an approval left unpaid), and the «تم التحقق» push when
 * the decision was not the customer's own request (a review or the list import).
 */
async function approve(
  tx: Tx,
  sub: SubscriptionRow,
  e: EligibilityRow,
  source: SubscriptionEligibilitySource,
  actor: SubActor,
  decidedBy: string | null,
  notify: boolean,
): Promise<SubscriptionRow> {
  await tx.query(
    `UPDATE subscription_eligibility SET status = 'approved', source = $3, decided_by = $4, decided_at = $5,
            version = version + 1
      WHERE id = $1 AND org_id = $2`,
    [e.id, e.org_id, source, decidedBy, tx.now],
  );
  const updated = await transition(
    tx,
    sub,
    'eligibility_approved',
    {
      status: 'pending_payment',
      pending_expires_at: new Date(tx.now.getTime() + SERVICE_DAY_RULES.eligibility_payment_days * DAY_MS),
    },
    actor,
    { source },
  );
  await schedulePendingExpiry(tx, updated);
  if (notify) await push(tx, updated, 'subscription_eligibility_approved', 'approved');
  return updated;
}

/**
 * C-09 «أرسل طلب الاشتراك» for a plan checked for eligibility (V2-036; DEC-596; annex clause 3 «يفعّل الاشتراك بعد
 * التحقق من الأهلية ونجاح الدفع»). Under the account row (FOR NO KEY UPDATE): the plan sold here and checked for
 * eligibility, the vehicles the account's own, no live subscription at the venue, a seat free, and the student
 * number not held by another account's live subscription at the venue (personal, not shared: annex clause 3). The
 * subscription is written `pending_eligibility` with its vehicles and the application; nothing is paid. It is approved
 * at once when the number is on the venue's eligible list (`list`) or was approved for this account at this venue
 * within 180 days (`reuse`, a renewal); otherwise the platform decides (P-07).
 */
export async function applyForSubscription(
  tx: Tx,
  accountId: string,
  body: CustomerSubscriptionApplyBody,
  actor: SubActor,
): Promise<string> {
  await lockAccount(tx, accountId);
  const plan = await planById(tx, body.plan_id);
  if (!plan) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription_plan' });
  const sale = await tx.one<{ listed: boolean; subscriptions_enabled: boolean; category: string }>(
    `SELECT (vp.status = 'approved' AND v.status = 'active' AND o.operator_status = 'active') AS listed,
            COALESCE(vp.subscriptions_enabled, false) AS subscriptions_enabled, COALESCE(vp.category, 'other') AS category
       FROM venues v JOIN organizations o ON o.id = v.org_id
       LEFT JOIN venue_public_profiles vp ON vp.venue_id = v.id AND vp.org_id = v.org_id
      WHERE v.id = $1 AND v.org_id = $2`,
    [plan.venue_id, plan.org_id],
  );
  if (!sale.listed) throw new AppError('VENUE_NOT_LISTED');
  if (!sale.subscriptions_enabled || sale.category === 'hall')
    throw new AppError('SUBSCRIPTION_PLAN_UNAVAILABLE', { reason: 'not_sold' });
  if (plan.status !== 'active') throw new AppError('SUBSCRIPTION_PLAN_UNAVAILABLE', { reason: 'retired' });
  if (plan.eligibility === 'none')
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'plan_id', issue: 'no_eligibility_check' }],
    });
  const cycle = plan.monthly_price_halalas !== null ? 'monthly' : 'yearly';
  const price = planPrice(plan, cycle)!;
  if (body.vehicle_ids.length > plan.vehicles_included)
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'vehicle_ids', issue: 'too_many', max: plan.vehicles_included }],
    });
  await assertOwnVehicles(tx, accountId, body.vehicle_ids);
  const live = await tx.maybeOne<{ id: string; status: string }>(
    `SELECT id, status FROM subscriptions
      WHERE account_id = $1 AND venue_id = $2 AND org_id = $3
        AND status IN ('pending_eligibility','pending_payment','active','past_due','frozen')`,
    [accountId, plan.venue_id, plan.org_id],
  );
  if (live)
    throw new AppError('SUBSCRIPTION_ALREADY_EXISTS', { subscription_id: live.id, status: live.status });
  const held = await tx.maybeOne<{ id: string }>(
    `SELECT e.id FROM subscription_eligibility e JOIN subscriptions s ON s.id = e.subscription_id AND s.org_id = e.org_id
      WHERE e.venue_id = $1 AND e.org_id = $2 AND e.student_number = $3 AND e.account_id <> $4
        AND e.status <> 'rejected'
        AND s.status IN ('pending_eligibility','pending_payment','active','past_due','frozen')
      LIMIT 1`,
    [plan.venue_id, plan.org_id, body.student_number, accountId],
  );
  if (held)
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'student_number', issue: 'in_use' }] });
  await assertCapacity(tx, plan, null);
  const subId = newId();
  const sub = await tx.one<SubscriptionRow>(
    `INSERT INTO subscriptions AS s (id, account_id, plan_id, org_id, venue_id, billing_cycle, status, price_halalas,
                                     vehicles_included, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_eligibility', $7, $8, $9, $9) RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [subId, accountId, plan.id, plan.org_id, plan.venue_id, cycle, price, plan.vehicles_included, tx.now],
  );
  for (const v of body.vehicle_ids)
    await tx.query(
      `INSERT INTO subscription_vehicles (subscription_id, account_id, customer_vehicle_id, added_at)
       VALUES ($1, $2, $3, $4)`,
      [subId, accountId, v, tx.now],
    );
  const e = await tx.one<EligibilityRow>(
    `INSERT INTO subscription_eligibility AS e (subscription_id, account_id, plan_id, org_id, venue_id, kind,
                                                student_number, student_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${ELIGIBILITY_COLUMNS}`,
    [
      subId,
      accountId,
      plan.id,
      plan.org_id,
      plan.venue_id,
      plan.eligibility,
      body.student_number,
      body.student_name,
      tx.now,
    ],
  );
  // metadata: never the student number or name (personal data stays in its table, V2-D12)
  await auditTransition(tx, sub, 'subscription.apply', actor, {
    from_status: null,
    to_status: 'pending_eligibility',
    plan_id: plan.id,
    price_halalas: price,
    vehicles: body.vehicle_ids.length,
  });
  const listed = await tx.maybeOne(
    `SELECT 1 FROM subscription_eligible_students
      WHERE venue_id = $1 AND org_id = $2 AND student_number = $3 AND removed_at IS NULL`,
    [plan.venue_id, plan.org_id, body.student_number],
  );
  const reused = listed
    ? null
    : await tx.maybeOne(
        `SELECT 1 FROM subscription_eligibility
          WHERE venue_id = $1 AND org_id = $2 AND student_number = $3 AND account_id = $4 AND status = 'approved'
            AND decided_at > $5
          LIMIT 1`,
        [
          plan.venue_id,
          plan.org_id,
          body.student_number,
          accountId,
          new Date(tx.now.getTime() - SERVICE_DAY_RULES.eligibility_reuse_days * DAY_MS),
        ],
      );
  if (listed || reused)
    await approve(
      tx,
      sub,
      e,
      listed ? 'list' : 'reuse',
      { type: 'system', name: 'eligibility' },
      null,
      false,
    );
  else await publishSubscriptionUpdated(tx, sub);
  return subId;
}

/**
 * The cancel of an application by its customer (C-14 «سحب الطلب»): `pending_eligibility → canceled` (`abandoned`).
 */
export async function withdrawApplication(tx: Tx, sub: SubscriptionRow, actor: SubActor): Promise<void> {
  await transition(tx, sub, 'abandon', endPatch(tx, sub, 'abandoned'), actor);
}

const notPending = (sub: SubscriptionRow) =>
  new AppError('INVALID_STATE_TRANSITION', {
    entity_type: 'subscription',
    entity_id: sub.id,
    current_status: sub.status,
    command: 'subscription.eligibility',
    allowed_from: ['pending_eligibility'],
  });

/**
 * P-07 (V2-036; DEC-596; `platform.subscription_manage`): the eligibility decisions and the venue's eligible list.
 * Only the platform decides (V2-D12: the operator never reads the applicant's data); every decision is in
 * platform_audit_log (`subscription.eligibility_approved` / `_rejected`, with the reason) and the customer's log.
 */
export class PlatformEligibilityService {
  constructor(private readonly db: Database) {}

  async decide(
    tx: Tx,
    actor: PlatformActorContext,
    subscriptionId: string,
    body: PlatformEligibilityDecisionBody,
    client: ClientInfo,
  ): Promise<void> {
    const reason = (body.reason ?? '').trim();
    if (body.decision === 'reject' && reason.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    const sub = await subscriptionById(tx, subscriptionId, true);
    if (!sub) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
    if (sub.status !== 'pending_eligibility') throw notPending(sub);
    const e = await eligibilityOf(tx, sub, true);
    if (!e || e.status !== 'pending') throw notPending(sub);
    const who: SubActor = {
      type: 'platform',
      userId: actor.userId,
      role: actor.role,
      requestId: client.requestId,
    };
    if (body.decision === 'approve') {
      await approve(tx, sub, e, 'review', who, actor.userId, true);
      return;
    }
    await tx.query(
      `UPDATE subscription_eligibility SET status = 'rejected', source = 'review', decided_by = $3, decided_at = $4,
              decision_reason = $5, version = version + 1
        WHERE id = $1 AND org_id = $2`,
      [e.id, e.org_id, actor.userId, tx.now, reason],
    );
    const ended = await transition(
      tx,
      sub,
      'eligibility_rejected',
      endPatch(tx, sub, 'eligibility_rejected'),
      who,
      {
        reason,
      },
    );
    await push(tx, ended, 'subscription_eligibility_rejected', 'rejected');
  }

  /** `GET …/venues/{venueId}/eligible-students`: counts only (the numbers are personal data). */
  async listSummary(venueId: string) {
    if (!UUID.test(venueId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    const r = await this.db.query<{ listed: number; pending: number; exists: boolean }>(
      `SELECT (SELECT count(*)::int FROM subscription_eligible_students WHERE venue_id = $1 AND removed_at IS NULL)
                AS listed,
              (SELECT count(*)::int FROM subscription_eligibility WHERE venue_id = $1 AND status = 'pending') AS pending,
              EXISTS (SELECT 1 FROM venues WHERE id = $1) AS exists`,
      [venueId],
    );
    const row = r.rows[0]!;
    if (!row.exists) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    return { venue_id: venueId, listed: row.listed, pending_applications: row.pending };
  }

  /**
   * `POST …/venues/{venueId}/eligible-students` (DEC-597): numbers added to (or removed from) the venue's list; every
   * application at the venue still waiting whose number is now listed is approved (`list`) in this transaction, its
   * subscription rows locked by id. The audit holds the counts, never the numbers.
   */
  async importList(
    tx: Tx,
    actor: PlatformActorContext,
    venueId: string,
    body: PlatformEligibleStudentsBody,
    client: ClientInfo,
  ) {
    if (!UUID.test(venueId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    const venue = await tx.maybeOne<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM venues WHERE id = $1 FOR NO KEY UPDATE`,
      [venueId],
    );
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    const numbers = [...new Set(body.student_numbers)];
    let changed: number;
    let approved = 0;
    if (body.mode === 'add') {
      const r = await tx.query(
        `INSERT INTO subscription_eligible_students (org_id, venue_id, student_number, added_by, added_at)
         SELECT $1, $2, n, $3, $4 FROM unnest($5::text[]) AS n
         ON CONFLICT (venue_id, student_number) WHERE removed_at IS NULL DO NOTHING`,
        [venue.org_id, venue.id, actor.userId, tx.now, numbers],
      );
      changed = r.rowCount ?? 0;
      const waiting = await tx.rows<{ subscription_id: string }>(
        `SELECT subscription_id FROM subscription_eligibility
          WHERE venue_id = $1 AND org_id = $2 AND status = 'pending' AND student_number = ANY($3)
          ORDER BY subscription_id`,
        [venue.id, venue.org_id, numbers],
      );
      const who: SubActor = {
        type: 'platform',
        userId: actor.userId,
        role: actor.role,
        requestId: client.requestId,
      };
      for (const w of waiting) {
        const sub = await subscriptionById(tx, w.subscription_id, true);
        if (!sub || sub.status !== 'pending_eligibility') continue;
        const e = await eligibilityOf(tx, sub, true);
        if (!e || e.status !== 'pending') continue;
        await approve(tx, sub, e, 'list', who, actor.userId, true);
        approved++;
      }
    } else {
      const r = await tx.query(
        `UPDATE subscription_eligible_students SET removed_at = $4, removed_by = $3
          WHERE venue_id = $1 AND org_id = $2 AND removed_at IS NULL AND student_number = ANY($5)`,
        [venue.id, venue.org_id, actor.userId, tx.now, numbers],
      );
      changed = r.rowCount ?? 0;
    }
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: `subscription_eligible_list.${body.mode}`,
      entityType: 'venue',
      entityId: venue.id,
      orgId: null,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { sent: numbers.length, changed, approved },
    });
    const listed = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscription_eligible_students
        WHERE venue_id = $1 AND org_id = $2 AND removed_at IS NULL`,
      [venue.id, venue.org_id],
    );
    return { venue_id: venue.id, mode: body.mode, changed, approved, listed: listed.n };
  }
}
