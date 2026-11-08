import {
  PLATFORM_REASON_MIN,
  type PlatformPlan,
  type PlatformPlanCreateBody,
  type PlatformPlanRetireBody,
  type PlatformPlansQuery,
} from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { iso, PLAN_COLUMNS, planById, type PlanRow, type Q } from './rows.js';

const RECURRING = new Set(['office', 'mall', 'hospital', 'residential', 'hotel', 'club', 'other']);

function planView(p: PlanRow & { live_subscriptions?: number }): PlatformPlan {
  return {
    plan_id: p.id,
    venue_id: p.venue_id,
    name_ar: p.name_ar,
    name_en: p.name_en,
    vehicles_included: p.vehicles_included,
    monthly_price_halalas: p.monthly_price_halalas,
    yearly_price_halalas: p.yearly_price_halalas,
    status: p.status,
    replaces_plan_id: p.replaces_plan_id,
    replaced_by_plan_id: p.replaced_by_plan_id,
    live_subscriptions: p.live_subscriptions ?? 0,
    created_at: iso(p.created_at)!,
    retired_at: iso(p.retired_at),
  };
}

const PLAN_WITH_COUNT = `SELECT ${PLAN_COLUMNS},
       (SELECT count(*)::int FROM subscriptions s
         WHERE s.plan_id = p.id AND s.org_id = p.org_id
           AND s.status IN ('pending_payment','active','past_due','frozen')) AS live_subscriptions
  FROM subscription_plans p`;

interface VenueRow {
  venue_id: string;
  org_id: string;
  name_ar: string;
  name_en: string | null;
  operator_name_ar: string;
  category: string;
  profile_status: string;
  profile_version: number;
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch {
    // fall through
  }
  throw new AppError('PAGINATION_CURSOR_INVALID');
}

/**
 * P-05 «باقات الاشتراك» (V2-030; docs/v2/02 §2 P-05, V2-D05 … V2-D07; DEC-531): `platform.plan_manage` (owner and
 * finance). The venues with a public profile (the subscription switch and the visit price are P-04's pricing
 * command, `PUT /v1/platform/venues/{venueId}/pricing`, same permission) and their plans. A plan is never edited: a
 * price change is a new plan that retires the one it replaces, in one transaction; its subscribers keep their own
 * price until the renewal notice announces the new one (`sendRenewalNotice`). Every command is in
 * platform_audit_log and in the operator's audit_log (`platformAudit` with the venue's org).
 */
export class PlatformPlansService {
  constructor(private readonly db: Database) {}

  async list(q: PlatformPlansQuery) {
    const offset = decodeCursor(q.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.venue_id) {
      params.push(q.venue_id);
      where.push(`v.id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(v.name_ar ILIKE $${params.length} OR v.name_en ILIKE $${params.length})`);
    }
    if (q.subscriptions) where.push(`vp.subscriptions_enabled = ${q.subscriptions === 'enabled'}`);
    params.push(q.limit + 1, offset);
    const venues = (
      await this.db.query<VenueRow>(
        `SELECT v.id AS venue_id, v.org_id, v.name_ar, v.name_en, o.name_ar AS operator_name_ar, vp.category,
                vp.status AS profile_status, vp.version AS profile_version, vp.subscriptions_enabled,
                vp.pay_per_visit_halalas::float8 AS pay_per_visit_halalas
           FROM venue_public_profiles vp
           JOIN venues v ON v.id = vp.venue_id AND v.org_id = vp.org_id
           JOIN organizations o ON o.id = vp.org_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY v.name_ar, v.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    const page = venues.slice(0, q.limit);
    const plans = page.length
      ? (
          await this.db.query<PlanRow & { live_subscriptions: number }>(
            `${PLAN_WITH_COUNT} WHERE p.venue_id = ANY($1) ORDER BY p.status, p.created_at DESC, p.id`,
            [page.map((v) => v.venue_id)],
          )
        ).rows
      : [];
    return {
      data: {
        items: page.map((v) => ({
          ...v,
          subscriptions_allowed: RECURRING.has(v.category),
          plans: plans.filter((p) => p.venue_id === v.venue_id).map(planView),
        })),
      },
      next_cursor: venues.length > q.limit ? encodeCursor(offset + q.limit) : null,
    };
  }

  async create(tx: Tx, actor: PlatformActorContext, body: PlatformPlanCreateBody, client: ClientInfo) {
    const venue = await tx.maybeOne<{ id: string; org_id: string; category: string; subscriptions_enabled: boolean }>(
      `SELECT v.id, v.org_id, vp.category, vp.subscriptions_enabled
         FROM venues v JOIN venue_public_profiles vp ON vp.venue_id = v.id AND vp.org_id = v.org_id
        WHERE v.id = $1 FOR NO KEY UPDATE OF vp`,
      [body.venue_id],
    );
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    // V2-D07: subscriptions are sold at recurring venues only, once the platform switched them on (P-04 pricing)
    if (!RECURRING.has(venue.category))
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'venue_id', issue: 'not_recurring_venue', category: venue.category }],
      });
    if (!venue.subscriptions_enabled)
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'venue_id', issue: 'subscriptions_disabled' }] });
    let replaced: PlanRow | null = null;
    if (body.replaces_plan_id) {
      replaced = await planById(tx, body.replaces_plan_id, true);
      if (!replaced || replaced.venue_id !== venue.id)
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription_plan' });
      if (replaced.status !== 'active') throw this.retiredError(replaced);
      const reason = (body.reason ?? '').trim();
      if (reason.length < PLATFORM_REASON_MIN)
        throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    }
    const id = newId();
    const plan = await tx.one<PlanRow>(
      `INSERT INTO subscription_plans AS p (id, org_id, venue_id, name_ar, name_en, vehicles_included, monthly_price_halalas,
                                         yearly_price_halalas, replaces_plan_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING ${PLAN_COLUMNS}`,
      [
        id,
        venue.org_id,
        venue.id,
        body.name_ar,
        body.name_en ?? null,
        body.vehicles_included,
        body.monthly_price_halalas ?? null,
        body.yearly_price_halalas ?? null,
        replaced?.id ?? null,
        actor.userId,
        tx.now,
      ],
    );
    if (replaced) await this.retireRow(tx, actor, replaced, (body.reason ?? '').trim(), plan.id, client);
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'subscription_plan.create',
      entityType: 'subscription_plan',
      entityId: plan.id,
      orgId: plan.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason: replaced ? (body.reason ?? '').trim() : null,
      metadata: {
        venue_id: plan.venue_id,
        vehicles_included: plan.vehicles_included,
        monthly_price_halalas: plan.monthly_price_halalas,
        yearly_price_halalas: plan.yearly_price_halalas,
        replaces_plan_id: replaced?.id ?? null,
      },
    });
    return planView({ ...plan, live_subscriptions: 0 });
  }

  async retire(tx: Tx, actor: PlatformActorContext, planId: string, body: PlatformPlanRetireBody, client: ClientInfo) {
    const reason = (body.reason ?? '').trim();
    if (reason.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    const plan = await planById(tx, planId, true);
    if (!plan) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription_plan' });
    if (plan.status !== 'active') throw this.retiredError(plan);
    await this.retireRow(tx, actor, plan, reason, null, client);
    return this.view(tx, plan.id);
  }

  private async retireRow(
    tx: Tx,
    actor: PlatformActorContext,
    plan: PlanRow,
    reason: string,
    replacedBy: string | null,
    client: ClientInfo,
  ) {
    await tx.query(
      `UPDATE subscription_plans SET status = 'retired', retired_at = $3, retired_by = $4, retire_reason = $5,
              replaced_by_plan_id = $6, version = version + 1
        WHERE id = $1 AND org_id = $2`,
      [plan.id, plan.org_id, tx.now, actor.userId, reason, replacedBy],
    );
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'subscription_plan.retire',
      entityType: 'subscription_plan',
      entityId: plan.id,
      orgId: plan.org_id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason,
      metadata: { venue_id: plan.venue_id, replaced_by_plan_id: replacedBy },
    });
  }

  private async view(q: Q, id: string): Promise<PlatformPlan> {
    const r = await q.query<PlanRow & { live_subscriptions: number }>(`${PLAN_WITH_COUNT} WHERE p.id = $1`, [id]);
    return planView(r.rows[0]!);
  }

  private retiredError(plan: PlanRow) {
    return new AppError('INVALID_STATE_TRANSITION', {
      entity_type: 'subscription_plan',
      entity_id: plan.id,
      current_status: plan.status,
      command: 'subscription_plan.retire',
      allowed_from: ['active'],
    });
  }
}
