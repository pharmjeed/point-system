import { Inject, Injectable } from '@nestjs/common';
import {
  CUSTOMER_ACCOUNT_TRANSITIONS,
  PLATFORM_REASON_MIN,
  PLATFORM_REVOKED_SESSION_REASON,
  normalizeSaudiMobile,
  type CustomerAccountCommand,
  type PlatformCustomerStatus,
  type PlatformCustomersQuery,
} from '@point/shared';
import { CUSTOMER_PROFILE_CONSENT_KINDS, maskPhone, saudiPlateDisplay } from '@point/shared/customer';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import { consentTexts, deletedPhoneHash, listAccountVisits } from '../../customer-accounts/index.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
/** microsecond text of a timestamptz, for keyset cursors (a JS Date would round to the millisecond) */
const US = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The audit actions of the P-06 account commands (platform_audit_log, entity `customer_account`). */
export const CUSTOMER_ACCOUNT_ACTIONS: Readonly<Record<CustomerAccountCommand, string>> = {
  suspend: 'customer.suspend',
  reactivate: 'customer.reactivate',
  revoke_sessions: 'customer.sessions_revoke',
};
/** … and the same facts in the account's own customer_audit_log (system actor `platform`). */
const CUSTOMER_LOG_ACTIONS: Readonly<Record<CustomerAccountCommand, string>> = {
  suspend: 'customer.account.suspended',
  reactivate: 'customer.account.reactivated',
  revoke_sessions: 'customer.sessions.revoked',
};

interface AccountRow {
  id: string;
  phone_e164: string | null;
  display_name: string | null;
  locale: 'ar' | 'en';
  status: PlatformCustomerStatus;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_at_us: string;
  vehicles_count: number;
  live_sessions: number;
}

const ACCOUNT_SELECT = (now: string) => `
  SELECT a.id, a.phone_e164, a.display_name, a.locale, a.status, a.deleted_at, a.created_at, a.updated_at,
         ${US('a.created_at')} AS created_at_us,
         (SELECT count(*)::int FROM customer_vehicles v WHERE v.account_id = a.id AND v.removed_at IS NULL)
           AS vehicles_count,
         (SELECT count(*)::int FROM customer_account_sessions s
           WHERE s.account_id = a.id AND s.revoked_at IS NULL AND s.refresh_expires_at > ${now}) AS live_sessions
    FROM customer_accounts a`;

/**
 * One account as the platform lists it (P-06): the phone masked only (V2-D12; DEC-526), never a token, a code or a
 * card. A deleted account (C-20) has no phone and no name left (DEC-508).
 */
function accountSummary(a: AccountRow) {
  return {
    id: a.id,
    display_name: a.display_name,
    phone_masked: a.phone_e164 ? maskPhone(a.phone_e164) : null,
    status: a.status,
    locale: a.locale,
    vehicles_count: a.vehicles_count,
    live_sessions: a.live_sessions,
    created_at: iso(a.created_at)!,
    deleted_at: iso(a.deleted_at),
  };
}
export type PlatformCustomerSummary = ReturnType<typeof accountSummary>;

const notFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'customer_account' });

/**
 * P-06 «العملاء» (V2-024, docs/v2/02 §2; DEC-526 … DEC-528): the platform reads a customer account (support and
 * finance, `platform.customer_read`) and suspends, reactivates or signs it out everywhere with a recorded reason
 * (`platform.customer_manage`). The platform reads across operators here only through the account's own links
 * (`listAccountVisits`, DEC-504) and the payments POINT collected; every read of one person's data is itself
 * audited (`customer.search`, `customer.view`, DEC-526). Commands lock the account row first (`FOR NO KEY UPDATE`,
 * after the platform idempotency key; DEC-462, DEC-497) and write platform_audit_log and the account's
 * customer_audit_log in their transaction. No L1–L10 row of V1 is locked or written.
 */
@Injectable()
export class PlatformCustomersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly cursors: ListCursorCodec,
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /**
   * `GET /v1/platform/customers`: an exact phone search (the deleted account's keyed hash too, so support can answer
   * «had this number an account», DEC-508) or the newest accounts, newest first, phones masked. A search by phone
   * reads one person: it is audited (`customer.search`, the match count, never the number).
   */
  async list(actor: PlatformActorContext, q: PlatformCustomersQuery, client: ClientInfo) {
    let phone: string | null = null;
    if (q.phone !== undefined) {
      phone = normalizeSaudiMobile(q.phone);
      if (!phone) throw new AppError('PHONE_INVALID', { field: 'phone' });
    }
    const scope = `platform-customers|${phone ?? ''}|${q.status ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const now = this.clock.now();
    const params: unknown[] = [now];
    const where: string[] = [];
    if (phone) {
      params.push(phone, deletedPhoneHash(this.env.CODE_PEPPER, phone));
      where.push(`(a.phone_e164 = $2 OR a.phone_hash = $3)`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`a.status = $${params.length}`);
    }
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const read = (db: Q) =>
      db.query<AccountRow>(
        `${ACCOUNT_SELECT('$1')} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
        params,
      );
    if (!phone) {
      const rows = (await read(this.db)).rows;
      return pageOf(rows, q.limit, accountSummary, (r) =>
        this.cursors.encode(scope, [r.created_at_us, r.id]),
      );
    }
    return this.db.transaction(async (tx) => {
      const rows = (await read(tx)).rows;
      await platformAudit(tx, {
        actor: { type: 'platform_user', id: actor.userId, role: actor.role },
        action: 'customer.search',
        entityType: 'customer_account',
        entityId: rows.length === 1 ? rows[0]!.id : null,
        requestId: client.requestId,
        ip: client.ip ?? null,
        userAgent: client.userAgent ?? null,
        metadata: { by: 'phone', matches: Math.min(rows.length, q.limit) },
      });
      return pageOf(rows, q.limit, accountSummary, (r) =>
        this.cursors.encode(scope, [r.created_at_us, r.id]),
      );
    });
  }

  /**
   * `GET /v1/platform/customers/{accountId}`: the account, its consents with their versions, vehicles, visits (the
   * minimal fields of `listAccountVisits`), sessions (counts and devices, never a token, hash or push token), saved
   * cards (brand and last four digits), online payments and the platform's own history on it. Audited
   * (`customer.view`).
   */
  async detail(actor: PlatformActorContext, accountId: string, client: ClientInfo) {
    if (!UUID.test(accountId)) throw notFound();
    return this.db.transaction(async (tx) => {
      const a = await accountRow(tx, accountId, tx.now);
      if (!a) throw notFound();
      const texts = consentTexts(this.env);
      const consents = await tx.rows<{
        kind: string;
        version: string;
        granted: boolean;
        created_at: Date;
      }>(
        `SELECT kind, version, granted, created_at FROM customer_account_consents
          WHERE account_id = $1 ORDER BY id DESC LIMIT 100`,
        [accountId],
      );
      const vehicles = await tx.rows<{
        id: string;
        plate_country: string;
        plate_digits: string | null;
        plate_letters_ar: string | null;
        plate_raw: string | null;
        vehicle_make: string | null;
        vehicle_model: string | null;
        vehicle_color: string | null;
        vehicle_type: string | null;
        created_at: Date;
        removed_at: Date | null;
      }>(
        `SELECT id, plate_country, plate_digits, plate_letters_ar, plate_raw, vehicle_make, vehicle_model,
                vehicle_color, vehicle_type, created_at, removed_at
           FROM customer_vehicles WHERE account_id = $1
          ORDER BY (removed_at IS NULL) DESC, created_at DESC, id LIMIT 50`,
        [accountId],
      );
      const sessions = await tx.rows<{
        id: string;
        device_id: string;
        platform: 'ios' | 'android';
        created_at: Date;
        last_seen_at: Date | null;
        refresh_expires_at: Date;
        revoked_at: Date | null;
        revoked_reason: string | null;
        push_enabled: boolean;
      }>(
        `SELECT id, device_id, platform, created_at, last_seen_at, refresh_expires_at, revoked_at, revoked_reason,
                (push_token IS NOT NULL) AS push_enabled
           FROM customer_account_sessions WHERE account_id = $1
          ORDER BY created_at DESC, id LIMIT 20`,
        [accountId],
      );
      const sessionCounts = await tx.one<{ total: number; devices: number }>(
        `SELECT count(*)::int AS total, count(DISTINCT device_id)::int AS devices
           FROM customer_account_sessions WHERE account_id = $1`,
        [accountId],
      );
      const cards = await tx.rows<{
        id: string;
        brand: string | null;
        last4: string | null;
        expires_month: number | null;
        expires_year: number | null;
        is_default: boolean;
        created_at: Date;
        removed_at: Date | null;
      }>(
        `SELECT id, brand, last4, expires_month, expires_year, is_default, created_at, removed_at
           FROM customer_payment_methods WHERE account_id = $1
          ORDER BY (removed_at IS NULL) DESC, created_at DESC, id LIMIT 20`,
        [accountId],
      );
      const payments = await tx.rows<{
        id: string;
        purpose: string;
        status: string;
        amount_halalas: number;
        vat_halalas: number;
        refunded_halalas: number;
        card_brand: string | null;
        card_last4: string | null;
        org_id: string | null;
        org_name_ar: string | null;
        venue_id: string | null;
        venue_name_ar: string | null;
        ticket_id: string | null;
        created_at: Date;
        paid_at: Date | null;
      }>(
        `SELECT p.id, p.purpose, p.status, p.amount_halalas::float8 AS amount_halalas,
                p.vat_halalas::float8 AS vat_halalas, p.refunded_halalas::float8 AS refunded_halalas, p.card_brand,
                p.card_last4, p.org_id, o.name_ar AS org_name_ar, p.venue_id, v.name_ar AS venue_name_ar,
                p.ticket_id, p.created_at, p.paid_at
           FROM online_payments p
           LEFT JOIN organizations o ON o.id = p.org_id
           LEFT JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
          WHERE p.account_id = $1 ORDER BY p.created_at DESC, p.id DESC LIMIT 20`,
        [accountId],
      );
      const visits = await listAccountVisits(tx, accountId, { limit: 20 });
      const history = await tx.rows<{
        action: string;
        reason: string | null;
        metadata: Record<string, unknown>;
        occurred_at: Date;
        actor_id: string | null;
        actor_name: string | null;
      }>(
        `SELECT l.action, l.reason, l.metadata, l.occurred_at, l.actor_id, pu.full_name AS actor_name
           FROM platform_audit_log l LEFT JOIN platform_users pu ON pu.id = l.actor_id
          WHERE l.entity_type = 'customer_account' AND l.entity_id = $1 AND l.action = ANY($2::text[])
          ORDER BY l.occurred_at DESC, l.id DESC LIMIT 50`,
        [accountId, Object.values(CUSTOMER_ACCOUNT_ACTIONS)],
      );
      await platformAudit(tx, {
        actor: { type: 'platform_user', id: actor.userId, role: actor.role },
        action: 'customer.view',
        entityType: 'customer_account',
        entityId: accountId,
        requestId: client.requestId,
        ip: client.ip ?? null,
        userAgent: client.userAgent ?? null,
      });
      return {
        ...accountSummary(a),
        updated_at: iso(a.updated_at)!,
        consents: {
          current: CUSTOMER_PROFILE_CONSENT_KINDS.map((kind) => {
            const last = consents.find((c) => c.kind === kind);
            return {
              kind,
              current_version: texts.versions[kind],
              answered_version: last?.version ?? null,
              granted: last ? last.granted : null,
              up_to_date: last?.version === texts.versions[kind],
              answered_at: iso(last?.created_at),
            };
          }),
          history: consents.map((c) => ({
            kind: c.kind,
            version: c.version,
            granted: c.granted,
            created_at: iso(c.created_at)!,
          })),
        },
        vehicles: vehicles.map((v) => ({
          id: v.id,
          plate_display:
            v.plate_country === 'SA'
              ? saudiPlateDisplay({ digits: v.plate_digits, letters_ar: v.plate_letters_ar }) || null
              : (v.plate_raw ?? null),
          make: v.vehicle_make,
          model: v.vehicle_model,
          color: v.vehicle_color,
          type: v.vehicle_type,
          created_at: iso(v.created_at)!,
          removed_at: iso(v.removed_at),
        })),
        visits: visits.map((v) => ({
          ticket_id: v.ticket_id,
          org: { id: v.org_id, name_ar: v.operator_name_ar },
          venue: { id: v.venue_id, name_ar: v.venue_name_ar },
          status: v.status,
          open: v.open,
          channel: v.channel,
          plate_display: v.plate_display,
          entitlement: v.entitlement,
          received_at: iso(v.received_at)!,
          delivered_at: iso(v.delivered_at),
        })),
        sessions: {
          live: a.live_sessions,
          total: sessionCounts.total,
          devices: sessionCounts.devices,
          items: sessions.map((s) => ({
            id: s.id,
            platform: s.platform,
            /** the last four characters of the app's install id, to tell two devices apart */
            device_hint: s.device_id.slice(-4),
            live: s.revoked_at === null && s.refresh_expires_at.getTime() > tx.now.getTime(),
            push_enabled: s.push_enabled,
            created_at: iso(s.created_at)!,
            last_seen_at: iso(s.last_seen_at),
            revoked_at: iso(s.revoked_at),
            revoked_reason: s.revoked_reason,
          })),
        },
        payment_methods: cards.map((c) => ({
          id: c.id,
          brand: c.brand,
          last4: c.last4,
          expires_month: c.expires_month,
          expires_year: c.expires_year,
          is_default: c.is_default,
          created_at: iso(c.created_at)!,
          removed_at: iso(c.removed_at),
        })),
        payments: payments.map((p) => ({
          id: p.id,
          purpose: p.purpose,
          status: p.status,
          amount_halalas: p.amount_halalas,
          vat_halalas: p.vat_halalas,
          refunded_halalas: p.refunded_halalas,
          card_brand: p.card_brand,
          card_last4: p.card_last4,
          org: p.org_id ? { id: p.org_id, name_ar: p.org_name_ar } : null,
          venue: p.venue_id ? { id: p.venue_id, name_ar: p.venue_name_ar } : null,
          ticket_id: p.ticket_id,
          created_at: iso(p.created_at)!,
          paid_at: iso(p.paid_at),
        })),
        history: history.map((h) => ({
          action: h.action,
          reason: h.reason,
          from_status: (h.metadata?.from_status as string | undefined) ?? null,
          to_status: (h.metadata?.to_status as string | undefined) ?? null,
          revoked_sessions: (h.metadata?.revoked_sessions as number | undefined) ?? null,
          occurred_at: iso(h.occurred_at)!,
          actor: h.actor_id ? { id: h.actor_id, full_name: h.actor_name } : null,
        })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------- commands

  /**
   * suspend (active → suspended), reactivate (suspended → active) or revoke_sessions (every live session ends with
   * `platform_revoked`), each with a reason of 3+ characters (REASON_REQUIRED). A suspended account keeps its
   * sessions: the customer guard, the refresh and the sign-in refuse it with AUTH_ACCOUNT_DISABLED and the entry pass
   * with PASS_INVALID, until it is reactivated (DEC-527). A deleted account takes no command
   * (INVALID_STATE_TRANSITION).
   */
  async command(
    tx: Tx,
    actor: PlatformActorContext,
    accountId: string,
    command: CustomerAccountCommand,
    body: { reason?: string | null | undefined },
    client: ClientInfo,
  ) {
    const reason = (body.reason ?? '').trim();
    if (reason.length < PLATFORM_REASON_MIN)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: PLATFORM_REASON_MIN });
    if (!UUID.test(accountId)) throw notFound();
    const locked = await tx.maybeOne<{ status: PlatformCustomerStatus }>(
      `SELECT status FROM customer_accounts WHERE id = $1 FOR NO KEY UPDATE`,
      [accountId],
    );
    if (!locked) throw notFound();
    const rule = CUSTOMER_ACCOUNT_TRANSITIONS[command];
    if (!(rule.from as readonly string[]).includes(locked.status))
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity: 'customer_account',
        current_status: locked.status,
        allowed_from: [...rule.from],
      });
    let revoked = 0;
    if (rule.to) {
      await tx.query(`UPDATE customer_accounts SET status = $2 WHERE id = $1`, [accountId, rule.to]);
    } else {
      const r = await tx.query(
        `UPDATE customer_account_sessions
            SET revoked_at = $2, revoked_reason = $3, push_token = NULL, reauth_hash = NULL, reauth_expires_at = NULL
          WHERE account_id = $1 AND revoked_at IS NULL`,
        [accountId, tx.now, PLATFORM_REVOKED_SESSION_REASON],
      );
      revoked = r.rowCount ?? 0;
    }
    const metadata = rule.to
      ? { from_status: locked.status, to_status: rule.to }
      : { revoked_sessions: revoked, status: locked.status };
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: CUSTOMER_ACCOUNT_ACTIONS[command],
      entityType: 'customer_account',
      entityId: accountId,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      reason,
      metadata,
    });
    await customerAudit(tx, {
      actor: { type: 'system', name: 'platform' },
      action: CUSTOMER_LOG_ACTIONS[command],
      entityType: 'customer_account',
      entityId: accountId,
      accountId,
      requestId: client.requestId,
      metadata: { ...metadata, platform_user_id: actor.userId },
    });
    const a = await accountRow(tx, accountId, tx.now);
    return { account: accountSummary(a!), revoked_sessions: revoked };
  }
}

async function accountRow(q: Q, accountId: string, now: Date): Promise<AccountRow | null> {
  const r = await q.query<AccountRow>(`${ACCOUNT_SELECT('$2')} WHERE a.id = $1`, [accountId, now]);
  return r.rows[0] ?? null;
}
