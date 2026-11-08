import { subscriptionLifecycle } from '../../../core/hooks/subscription-lifecycle.js';
import { Inject, Injectable } from '@nestjs/common';
import {
  OPERATOR_STATUSES,
  OPERATOR_TRANSITIONS,
  rooms,
  type OperatorStatus,
  type OperatorTransition,
  type SaasCycle,
} from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { maskPhone } from '../../../core/logging/redact.js';
import { normalizePhone } from '../../../core/phone.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import {
  insertFirstOwner,
  newOwnerTemporaryPassword,
} from '../../identity-access/application/owner-bootstrap.js';
import { SecretHasher } from '../../identity-access/infra/secret-hasher.js';
import { assertNoContractOverlap } from './operator-contracts.js';
import type {
  CreateContractBody,
  CreateOperatorBody,
  EndContractBody,
  OperatorReasonBody,
  OptionalReasonBody,
} from '../http/schemas.js';

type Q = Pick<Tx, 'query'> | Pick<Database, 'query'>;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rooms per NOTIFY: `user:<uuid>` rooms stay well under the 8000-byte payload limit (DEC-48). */
const ROOMS_PER_NOTIFY = 100;
/** The platform's day (contract dates, «tickets today»): Asia/Riyadh (canon §2 rule 10). */
const TODAY = `($1::timestamptz AT TIME ZONE 'Asia/Riyadh')::date`;
const MIN_REASON = 3;

/** The audit actions of the operator lifecycle (platform_audit_log and the operator's audit_log). */
export const OPERATOR_STATUS_ACTIONS = [
  'operator.create',
  'operator.activate',
  'operator.suspend',
  'operator.reactivate',
  'operator.terminate',
] as const;

interface OrgRow {
  id: string;
  name_ar: string;
  name_en: string | null;
  legal_name: string | null;
  cr_number: string | null;
  vat_number: string | null;
  operator_status: OperatorStatus;
  is_platform_operated: boolean;
  created_at: Date;
  venues_count: number;
  active_venues_count: number;
  staff_count: number;
}

interface ContractRow {
  id: string;
  org_id: string;
  saas_fee_halalas_per_venue: number;
  saas_cycle: SaasCycle;
  subscriber_visit_payout_halalas: number;
  app_payment_commission_bp: number;
  starts_on: string;
  ends_on: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  state: 'upcoming' | 'current' | 'ended';
}

const ORG_SELECT = `
  SELECT o.id, o.name_ar, o.name_en, o.legal_name, o.cr_number, o.vat_number, o.operator_status,
         o.is_platform_operated, o.created_at,
         (SELECT count(*)::int FROM venues v WHERE v.org_id = o.id) AS venues_count,
         (SELECT count(*)::int FROM venues v WHERE v.org_id = o.id AND v.status = 'active') AS active_venues_count,
         (SELECT count(*)::int FROM users u WHERE u.org_id = o.id) AS staff_count
    FROM organizations o`;

/** `date` columns as `YYYY-MM-DD` text (the pg driver would turn them into local-midnight Dates). */
const CONTRACT_SELECT = `
  SELECT c.id, c.org_id, c.saas_fee_halalas_per_venue, c.saas_cycle, c.subscriber_visit_payout_halalas,
         c.app_payment_commission_bp, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.created_by,
         pu.full_name AS created_by_name, c.created_at,
         CASE WHEN c.starts_on > ${TODAY} THEN 'upcoming'
              WHEN c.ends_on IS NOT NULL AND c.ends_on <= ${TODAY} THEN 'ended'
              ELSE 'current' END AS state
    FROM operator_contracts c LEFT JOIN platform_users pu ON pu.id = c.created_by`;

function contractView(c: ContractRow) {
  return {
    id: c.id,
    org_id: c.org_id,
    saas_fee_halalas_per_venue: c.saas_fee_halalas_per_venue,
    saas_cycle: c.saas_cycle,
    subscriber_visit_payout_halalas: c.subscriber_visit_payout_halalas,
    app_payment_commission_bp: c.app_payment_commission_bp,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
    state: c.state,
    created_by: { id: c.created_by, full_name: c.created_by_name },
    created_at: iso(c.created_at),
  };
}
export type OperatorContractView = ReturnType<typeof contractView>;

function operatorView(o: OrgRow, current: ContractRow | null) {
  return {
    id: o.id,
    name_ar: o.name_ar,
    name_en: o.name_en,
    legal_name: o.legal_name,
    cr_number: o.cr_number,
    vat_number: o.vat_number,
    operator_status: o.operator_status,
    is_platform_operated: o.is_platform_operated,
    venues_count: o.venues_count,
    active_venues_count: o.active_venues_count,
    staff_count: o.staff_count,
    current_contract: current ? contractView(current) : null,
    created_at: iso(o.created_at),
  };
}

const notFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'organization' });

/**
 * The platform console's operators (V2-003 P-01 … P-03, V2-005 lifecycle; docs/v2/02 §2, §4). The platform reads
 * across operators — counts, the operator rows, their contracts, venues and staff (read-only, masked phones) —
 * but never operates inside one (02 §1): its commands touch `organizations`, `operator_contracts` and, for the
 * operator's first owner only, `users` / `role_scopes`. Every command writes platform_audit_log and the operator's
 * audit_log in its transaction (platformAudit with `orgId`). Lock order (DEC-462): the platform idempotency key,
 * then the organization row (`FOR NO KEY UPDATE`), then the appends; no L1–L10 row of V1 is locked.
 */
@Injectable()
export class OperatorsService {
  private readonly hasher: SecretHasher;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) env: Env,
  ) {
    this.hasher = new SecretHasher(env.AUTH_SECRET_PEPPER);
  }

  // ------------------------------------------------------------------------------------------- reads (P-01…P-03)

  /** P-01: counts only — no customer, plate or staff data (02 §2). */
  async overview() {
    const now = this.clock.now();
    const [r] = await this.db.rows<{
      by_status: Record<string, number> | null;
      venues_total: number;
      venues_active: number;
      drivers_on_duty: number;
      tickets_today: number;
      day: string;
    }>(
      `SELECT (SELECT jsonb_object_agg(s.operator_status, s.n)
                 FROM (SELECT operator_status, count(*)::int AS n FROM organizations GROUP BY operator_status) s)
                AS by_status,
              (SELECT count(*)::int FROM venues) AS venues_total,
              (SELECT count(*)::int FROM venues WHERE status = 'active') AS venues_active,
              (SELECT count(*)::int FROM duty_sessions WHERE status <> 'ended') AS drivers_on_duty,
              (SELECT count(*)::int FROM tickets
                WHERE created_at >= (${TODAY}::timestamp AT TIME ZONE 'Asia/Riyadh')) AS tickets_today,
              ${TODAY}::text AS day`,
      [now],
    );
    const byStatus = Object.fromEntries(OPERATOR_STATUSES.map((s) => [s, r?.by_status?.[s] ?? 0])) as Record<
      OperatorStatus,
      number
    >;
    return {
      operators: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), by_status: byStatus },
      venues: { total: r?.venues_total ?? 0, active: r?.venues_active ?? 0 },
      drivers_on_duty: r?.drivers_on_duty ?? 0,
      tickets_today: r?.tickets_today ?? 0,
      day: r?.day ?? null,
      generated_at: now.toISOString(),
    };
  }

  /** P-02: every operator (a handful per deployment), with its venue and staff counts and current contract. */
  async list(query: { status?: OperatorStatus }) {
    const now = this.clock.now();
    const orgs = await this.db.rows<OrgRow>(
      `${ORG_SELECT} WHERE ($1::text IS NULL OR o.operator_status = $1) ORDER BY o.name_ar, o.id`,
      [query.status ?? null],
    );
    const current = await this.db.rows<ContractRow>(
      `${CONTRACT_SELECT}
        WHERE c.org_id = ANY($2::uuid[]) AND c.starts_on <= ${TODAY} AND (c.ends_on IS NULL OR c.ends_on > ${TODAY})`,
      [now, orgs.map((o) => o.id)],
    );
    const byOrg = new Map(current.map((c) => [c.org_id, c]));
    return { items: orgs.map((o) => operatorView(o, byOrg.get(o.id) ?? null)) };
  }

  /** P-03: the operator, its venues, its owner (masked phone), its current contract and its status history. */
  async detail(orgId: string) {
    const now = this.clock.now();
    const o = await this.orgOf(this.db, orgId);
    const contracts = await this.contractRows(this.db, orgId, now);
    const venues = await this.db.rows<{
      id: string;
      code: string;
      name_ar: string;
      city: string | null;
      status: string;
    }>(`SELECT id, code, name_ar, city, status FROM venues WHERE org_id = $1 ORDER BY code, id`, [orgId]);
    const owner = (
      await this.db.rows<{
        id: string;
        full_name: string;
        employee_code: string;
        phone_e164: string;
        status: string;
        must_change_secret: boolean;
        mfa_enabled: boolean;
        last_login_at: Date | null;
      }>(
        `SELECT id, full_name, employee_code, phone_e164, status, must_change_secret, mfa_enabled, last_login_at
           FROM users WHERE org_id = $1 AND role = 'owner' ORDER BY created_at, id LIMIT 1`,
        [orgId],
      )
    )[0];
    const history = await this.db.rows<{
      action: string;
      reason: string | null;
      metadata: Record<string, unknown>;
      occurred_at: Date;
      actor_id: string | null;
      actor_name: string | null;
    }>(
      `SELECT a.action, a.reason, a.metadata, a.occurred_at, a.actor_id, pu.full_name AS actor_name
         FROM platform_audit_log a LEFT JOIN platform_users pu ON pu.id = a.actor_id
        WHERE a.org_id = $1 AND a.action = ANY($2::text[])
        ORDER BY a.occurred_at DESC, a.id DESC`,
      [orgId, [...OPERATOR_STATUS_ACTIONS]],
    );
    return {
      ...operatorView(o, contracts.find((c) => c.state === 'current') ?? null),
      venues,
      owner: owner
        ? {
            id: owner.id,
            full_name: owner.full_name,
            employee_code: owner.employee_code,
            phone_masked: maskPhone(owner.phone_e164),
            status: owner.status,
            must_change_secret: owner.must_change_secret,
            mfa_enabled: owner.mfa_enabled,
            last_login_at: iso(owner.last_login_at),
            /** the temporary password may be issued again until the owner's first sign-in (DEC-485) */
            temporary_password_reissuable: owner.last_login_at === null && owner.must_change_secret,
          }
        : null,
      status_history: history.map((h) => ({
        action: h.action,
        from_status: (h.metadata?.from_status as OperatorStatus | undefined) ?? null,
        to_status: (h.metadata?.to_status as OperatorStatus | undefined) ?? null,
        reason: h.reason,
        occurred_at: iso(h.occurred_at),
        actor: h.actor_id ? { id: h.actor_id, full_name: h.actor_name } : null,
      })),
    };
  }

  /** P-03: the contract history, newest first (contracts are never edited in place nor deleted). */
  async contracts(orgId: string) {
    await this.orgOf(this.db, orgId);
    return { items: (await this.contractRows(this.db, orgId, this.clock.now())).map(contractView) };
  }

  /** P-03 «المستخدمون (قراءة)»: the operator's staff, read-only, phones masked (09 §5 projection). */
  async users(orgId: string) {
    await this.orgOf(this.db, orgId);
    const users = await this.db.rows<{
      id: string;
      employee_code: string;
      full_name: string;
      phone_e164: string;
      role: string;
      can_drive: boolean;
      status: string;
      mfa_enabled: boolean;
      last_login_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, employee_code, full_name, phone_e164, role, can_drive, status, mfa_enabled, last_login_at, created_at
         FROM users WHERE org_id = $1
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'supervisor' THEN 2 ELSE 3 END,
                 employee_code, id`,
      [orgId],
    );
    return {
      items: users.map((u) => ({
        id: u.id,
        employee_code: u.employee_code,
        full_name: u.full_name,
        phone_masked: maskPhone(u.phone_e164),
        role: u.role,
        can_drive: u.can_drive,
        status: u.status,
        mfa_enabled: u.mfa_enabled,
        last_login_at: iso(u.last_login_at),
        created_at: iso(u.created_at),
      })),
    };
  }

  // ------------------------------------------------------------------------------------------- commands

  /**
   * P-02 «إضافة مشغل» (V2-003, DEC-485): the `organizations` row (`trial` or `active`, legal name, CR, VAT) and its
   * first owner through the create-owner logic (insertFirstOwner): a temporary password returned once — never in
   * the stored idempotent response, a log or the audit metadata. The owner's phone must be free in every operator
   * (DEC-476: staff sign-in finds an account by phone across the deployment).
   */
  async create(tx: Tx, actor: PlatformActorContext, body: CreateOperatorBody, client: ClientInfo) {
    const phone = normalizePhone(body.owner.phone);
    if (!phone) throw new AppError('PHONE_INVALID', { fields: [{ field: 'owner.phone', issue: 'invalid' }] });
    const temporaryPassword = newOwnerTemporaryPassword();
    const secretHash = await this.hasher.hash(temporaryPassword);
    const orgId = newId();
    await tx.query(
      `INSERT INTO organizations (id, name_ar, name_en, legal_name, cr_number, vat_number, operator_status,
                                  is_platform_operated, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        orgId,
        body.name_ar,
        body.name_en ?? null,
        body.legal_name,
        body.cr_number ?? null,
        body.vat_number ?? null,
        body.operator_status,
        body.is_platform_operated ?? false,
        tx.now,
      ],
    );
    const owner = await insertFirstOwner(tx, {
      orgId,
      phoneE164: phone,
      fullName: body.owner.full_name,
      secretHash,
      phoneScope: 'all',
    });
    if (!owner.ok) {
      // a new organization has no owner yet: the only refusal is a phone held by a user of another operator
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'owner.phone', issue: 'in_use_by_another_operator' }],
      });
    }
    const audit = (action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) =>
      platformAudit(tx, {
        actor: { type: 'platform_user', id: actor.userId, role: actor.role },
        action,
        entityType,
        entityId,
        orgId,
        requestId: client.requestId,
        ip: client.ip,
        userAgent: client.userAgent,
        metadata,
      });
    await audit('operator.create', 'organization', orgId, {
      from_status: null,
      to_status: body.operator_status,
      is_platform_operated: body.is_platform_operated ?? false,
    });
    await audit('owner.bootstrap', 'user', owner.userId, {
      role: 'owner',
      employee_code: owner.employeeCode,
      must_change_secret: true,
      mfa_setup_required: true,
    });
    const operator = operatorView(await this.orgOf(tx, orgId), null);
    const ownerView = {
      id: owner.userId,
      full_name: body.owner.full_name,
      employee_code: owner.employeeCode,
      phone_masked: maskPhone(phone),
    };
    return {
      data: { operator, owner: ownerView, temporary_password: temporaryPassword },
      stored: { operator, owner: ownerView, temporary_password: null },
    };
  }

  /**
   * The owner's temporary password again (DEC-485), while the owner has never signed in: the first answer of
   * «إضافة مشغل» may be lost and is never replayed with the password. After the first sign-in, owner recovery stays
   * the audited out-of-band procedure of 09 §9.1.
   */
  async reissueOwnerPassword(tx: Tx, actor: PlatformActorContext, orgId: string, client: ClientInfo) {
    const org = await this.lockOrg(tx, orgId);
    if (org.operator_status === 'terminated')
      throw this.transitionError(org, 'owner.temporary_password', 'operator_terminated');
    const owner = await tx.maybeOne<{ id: string; last_login_at: Date | null; must_change_secret: boolean }>(
      `SELECT id, last_login_at, must_change_secret FROM users
        WHERE org_id = $1 AND role = 'owner' ORDER BY created_at, id LIMIT 1 FOR NO KEY UPDATE`,
      [orgId],
    );
    if (!owner) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
    if (owner.last_login_at !== null || !owner.must_change_secret)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: owner.id,
        command: 'owner.temporary_password',
        reason: 'owner_signed_in',
      });
    const temporaryPassword = newOwnerTemporaryPassword();
    await tx.query(
      `UPDATE users SET secret_hash = $3, failed_login_count = 0, locked_until = NULL, version = version + 1
        WHERE id = $1 AND org_id = $2`,
      [owner.id, orgId, await this.hasher.hash(temporaryPassword)],
    );
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'owner.temporary_password_reissue',
      entityType: 'user',
      entityId: owner.id,
      orgId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { must_change_secret: true },
    });
    return {
      data: { user_id: owner.id, temporary_password: temporaryPassword },
      stored: { user_id: owner.id, temporary_password: null },
    };
  }

  /** A contract (DEC-463: assertNoContractOverlap first, under the organization row lock). */
  async createContract(
    tx: Tx,
    actor: PlatformActorContext,
    orgId: string,
    body: CreateContractBody,
    client: ClientInfo,
  ) {
    if (!UUID.test(orgId)) throw notFound();
    await assertNoContractOverlap(tx, orgId, { startsOn: body.starts_on, endsOn: body.ends_on ?? null });
    const org = await this.orgOf(tx, orgId);
    if (org.operator_status === 'terminated')
      throw this.transitionError(org, 'operator_contract.create', 'operator_terminated');
    const id = newId();
    await tx.query(
      `INSERT INTO operator_contracts (id, org_id, saas_fee_halalas_per_venue, saas_cycle, subscriber_visit_payout_halalas,
                                       app_payment_commission_bp, starts_on, ends_on, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        orgId,
        body.saas_fee_halalas_per_venue,
        body.saas_cycle,
        body.subscriber_visit_payout_halalas,
        body.app_payment_commission_bp,
        body.starts_on,
        body.ends_on ?? null,
        actor.userId,
        tx.now,
      ],
    );
    const row = await this.contractRow(tx, orgId, id);
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'operator_contract.create',
      entityType: 'operator_contract',
      entityId: id,
      orgId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: {
        saas_fee_halalas_per_venue: row.saas_fee_halalas_per_venue,
        saas_cycle: row.saas_cycle,
        subscriber_visit_payout_halalas: row.subscriber_visit_payout_halalas,
        app_payment_commission_bp: row.app_payment_commission_bp,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
      },
    });
    return contractView(row);
  }

  /**
   * Ends a contract (sets `ends_on`, the exclusive end day): the only change a contract ever takes (DEC-485). The
   * new end is today or later (no retroactive end), after the start, and earlier than the current end — extending
   * terms is a new contract. An ended contract is refused (INVALID_STATE_TRANSITION `contract_ended`).
   */
  async endContract(
    tx: Tx,
    actor: PlatformActorContext,
    orgId: string,
    contractId: string,
    body: EndContractBody,
    client: ClientInfo,
  ) {
    if (!UUID.test(orgId)) throw notFound();
    if (!UUID.test(contractId)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'operator_contract' });
    // the organization row first (DEC-463), then the contract
    await this.lockOrg(tx, orgId);
    const c = await tx.maybeOne<{ id: string; starts_on: string; ends_on: string | null; today: string }>(
      `SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on, ${TODAY}::text AS today
         FROM operator_contracts WHERE id = $2 AND org_id = $3 FOR NO KEY UPDATE`,
      [tx.now, contractId, orgId],
    );
    if (!c) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'operator_contract' });
    if (c.ends_on !== null && c.ends_on <= c.today)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'operator_contract',
        entity_id: c.id,
        command: 'operator_contract.end',
        reason: 'contract_ended',
      });
    const issue =
      body.ends_on < c.today
        ? 'in_the_past'
        : body.ends_on <= c.starts_on
          ? 'not_after_start'
          : c.ends_on !== null && body.ends_on >= c.ends_on
            ? 'not_earlier_than_current_end'
            : null;
    if (issue) throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'ends_on', issue }] });
    await tx.query(`UPDATE operator_contracts SET ends_on = $3 WHERE id = $1 AND org_id = $2`, [
      c.id,
      orgId,
      body.ends_on,
    ]);
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: 'operator_contract.end',
      entityType: 'operator_contract',
      entityId: c.id,
      orgId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason: body.reason?.trim() || null,
      metadata: { ends_on_before: c.ends_on, ends_on_after: body.ends_on },
    });
    return contractView(await this.contractRow(tx, orgId, c.id));
  }

  /**
   * The operator lifecycle of 02 §4 (V2-005, DEC-486): activate (invited/trial → active), suspend (trial/active →
   * suspended, reason required), reactivate (suspended → active), terminate (suspended → terminated, reason
   * required, final: no command leaves it, nothing is deleted). The staff app of the operator is told to re-read
   * `/v1/me` (`sync.required`, scope `me`), which carries the status and the banner; the server refuses new
   * events, shifts, duties and intakes whatever the app shows (assertOperatorOperating).
   */
  async transition(
    tx: Tx,
    actor: PlatformActorContext,
    orgId: string,
    command: OperatorTransition,
    body: OperatorReasonBody | OptionalReasonBody,
    client: ClientInfo,
  ) {
    const rule = OPERATOR_TRANSITIONS[command];
    const needsReason = command === 'suspend' || command === 'terminate';
    const reason = (body.reason ?? '').trim();
    if (needsReason && reason.length < MIN_REASON)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: MIN_REASON });
    const org = await this.lockOrg(tx, orgId);
    if (!(rule.from as readonly string[]).includes(org.operator_status))
      throw this.transitionError(org, `operator.${command}`, null, rule.from);
    await tx.query(`UPDATE organizations SET operator_status = $2, updated_at = $3 WHERE id = $1`, [
      orgId,
      rule.to,
      tx.now,
    ]);
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: `operator.${command}`,
      entityType: 'organization',
      entityId: orgId,
      orgId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      reason: reason || null,
      metadata: { from_status: org.operator_status, to_status: rule.to },
    });
    // V2-034 (docs/v2/02 §4, 04 §1; DEC-536): the customers' subscriptions at the operator's venues are frozen while it
    // is suspended, unfrozen with the frozen days added when it comes back, and refunded pro rata when it is terminated
    await subscriptionLifecycle.onOperatorStatusChanged(tx, {
      orgId,
      from: org.operator_status,
      to: rule.to,
      requestId: client.requestId,
    });
    await this.tellStaff(tx, orgId);
    return this.detailIn(tx, orgId);
  }

  // ------------------------------------------------------------------------------------------- helpers

  /** Every active staff user of the operator re-reads `/v1/me` (the org-settings pattern, 07 §4). */
  private async tellStaff(tx: Tx, orgId: string) {
    const users = await tx.rows<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND status = 'active' ORDER BY id`,
      [orgId],
    );
    for (let i = 0; i < users.length; i += ROOMS_PER_NOTIFY)
      await publishRealtime(
        tx,
        orgId,
        users.slice(i, i + ROOMS_PER_NOTIFY).map((u) => rooms.user(u.id)),
        { event: 'sync.required', id: newId(), data: { reason: 'operator_status_changed', scope: 'me' } },
      );
  }

  private async detailIn(tx: Tx, orgId: string) {
    const o = await this.orgOf(tx, orgId);
    const current = (await this.contractRows(tx, orgId, tx.now)).find((c) => c.state === 'current') ?? null;
    return operatorView(o, current);
  }

  private async orgOf(q: Q, orgId: string): Promise<OrgRow> {
    if (!UUID.test(orgId)) throw notFound();
    const r = await q.query<OrgRow>(`${ORG_SELECT} WHERE o.id = $1`, [orgId]);
    if (!r.rows[0]) throw notFound();
    return r.rows[0];
  }

  /** The organization row `FOR NO KEY UPDATE` (the first lock of a platform command after its key, DEC-462). */
  private async lockOrg(tx: Tx, orgId: string): Promise<{ id: string; operator_status: OperatorStatus }> {
    if (!UUID.test(orgId)) throw notFound();
    const org = await tx.maybeOne<{ id: string; operator_status: OperatorStatus }>(
      `SELECT id, operator_status FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
      [orgId],
    );
    if (!org) throw notFound();
    return org;
  }

  private contractRows(q: Q, orgId: string, now: Date): Promise<ContractRow[]> {
    return q
      .query<ContractRow>(
        `${CONTRACT_SELECT} WHERE c.org_id = $2 ORDER BY c.starts_on DESC, c.created_at DESC`,
        [now, orgId],
      )
      .then((r) => r.rows);
  }

  private async contractRow(tx: Tx, orgId: string, id: string): Promise<ContractRow> {
    return tx.one<ContractRow>(`${CONTRACT_SELECT} WHERE c.id = $2 AND c.org_id = $3`, [tx.now, id, orgId]);
  }

  private transitionError(
    org: { id: string; operator_status: OperatorStatus },
    command: string,
    reason: string | null,
    allowedFrom?: readonly string[],
  ) {
    return new AppError('INVALID_STATE_TRANSITION', {
      entity_type: 'organization',
      entity_id: org.id,
      current_status: org.operator_status,
      command,
      ...(allowedFrom ? { allowed_from: [...allowedFrom] } : {}),
      ...(reason ? { reason } : {}),
    });
  }
}
