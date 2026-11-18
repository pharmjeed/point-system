import {
  COMPLAINT_TRANSITIONS,
  complaintReference,
  complaintSeqOf,
  type ComplaintCategory,
  type ComplaintStatus,
  type PlatformComplaintStatusBody,
  type PlatformComplaintsQuery,
} from '@point/shared';
import type { CustomerComplaint, CustomerComplaintCreateBody } from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { maskPhone } from '../../../core/logging/redact.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ComplaintRow {
  id: string;
  ref_seq: number;
  account_id: string;
  category: ComplaintCategory;
  body: string;
  ticket_id: string | null;
  subscription_id: string | null;
  org_id: string | null;
  venue_id: string | null;
  status: ComplaintStatus;
  resolution_note: string | null;
  handled_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  venue_name_ar: string | null;
  venue_name_en: string | null;
}

const SELECT = `SELECT c.id, c.ref_seq, c.account_id, c.category, c.body, c.ticket_id, c.subscription_id, c.org_id,
       c.venue_id, c.status, c.resolution_note, c.handled_by, c.version, c.created_at, c.updated_at,
       v.name_ar AS venue_name_ar, v.name_en AS venue_name_en
  FROM customer_complaints c
  LEFT JOIN venues v ON v.id = c.venue_id AND v.org_id = c.org_id`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function customerView(c: ComplaintRow): CustomerComplaint {
  return {
    complaint_id: c.id,
    reference: complaintReference(c.ref_seq),
    category: c.category,
    status: c.status,
    body: c.body,
    ticket_id: c.ticket_id,
    subscription_id: c.subscription_id,
    venue_name_ar: c.venue_name_ar,
    venue_name_en: c.venue_name_en,
    resolution_note: c.resolution_note,
    created_at: iso(c.created_at)!,
    updated_at: iso(c.updated_at)!,
  };
}

/**
 * C-21 / C-22 «الشكاوى» (V2-037; DEC-603; annex clauses 5 and 6 «تسجل الشكاوى برقم مرجعي … عبر التطبيق»): the
 * account's complaints and a new one, with its reference at once. A complaint may name one of the account's own visits
 * (through the operator's `customers` row linked to it) or subscriptions; its venue and operator come from them so the
 * platform knows where it happened. The text is the customer's: it is never written to an audit log.
 */
export class CustomerComplaints {
  async list(q: Q, accountId: string): Promise<CustomerComplaint[]> {
    const r = await q.query<ComplaintRow>(
      `${SELECT} WHERE c.account_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
      [accountId],
    );
    return r.rows.map(customerView);
  }

  async one(q: Q, accountId: string, id: string): Promise<CustomerComplaint> {
    const r = UUID.test(id)
      ? await q.query<ComplaintRow>(`${SELECT} WHERE c.id = $1 AND c.account_id = $2`, [id, accountId])
      : { rows: [] };
    if (!r.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'complaint' });
    return customerView(r.rows[0]);
  }

  async create(
    tx: Tx,
    actor: CustomerActorContext,
    body: CustomerComplaintCreateBody,
    client: ClientInfo,
  ): Promise<CustomerComplaint> {
    let where: { org_id: string; venue_id: string } | null = null;
    if (body.ticket_id) {
      where = await tx.maybeOne<{ org_id: string; venue_id: string }>(
        `SELECT t.org_id, t.venue_id FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
          WHERE t.id = $1 AND c.customer_account_id = $2`,
        [body.ticket_id, actor.accountId],
      );
      if (!where) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'visit' });
    }
    if (body.subscription_id) {
      const s = await tx.maybeOne<{ org_id: string; venue_id: string }>(
        `SELECT org_id, venue_id FROM subscriptions WHERE id = $1 AND account_id = $2`,
        [body.subscription_id, actor.accountId],
      );
      if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'subscription' });
      if (where && where.org_id !== s.org_id)
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'subscription_id', issue: 'other_operator' }],
        });
      where = where ?? s;
    }
    const row = await tx.one<{ id: string }>(
      `INSERT INTO customer_complaints (account_id, category, body, ticket_id, subscription_id, org_id, venue_id,
                                        created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [
        actor.accountId,
        body.category,
        body.body,
        body.ticket_id ?? null,
        body.subscription_id ?? null,
        where?.org_id ?? null,
        where?.venue_id ?? null,
        tx.now,
      ],
    );
    const created = await this.one(tx, actor.accountId, row.id);
    const metadata = {
      reference: created.reference,
      category: body.category,
      ticket_id: body.ticket_id ?? null,
      subscription_id: body.subscription_id ?? null,
      venue_id: where?.venue_id ?? null,
    };
    await customerAudit(tx, {
      actor: { type: 'customer', accountId: actor.accountId },
      accountId: actor.accountId,
      action: 'customer.complaint.create',
      entityType: 'complaint',
      entityId: row.id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata,
    });
    await platformAudit(tx, {
      actor: { type: 'system', id: null, name: 'customer' },
      action: 'complaint.create',
      entityType: 'complaint',
      entityId: row.id,
      orgId: null,
      requestId: client.requestId,
      metadata,
    });
    return created;
  }
}

interface PlatformRow extends ComplaintRow {
  phone_e164: string | null;
  operator_name_ar: string | null;
}

function platformView(c: PlatformRow) {
  return {
    complaint_id: c.id,
    reference: complaintReference(c.ref_seq),
    category: c.category,
    status: c.status,
    body: c.body,
    account_id: c.account_id,
    // V2-D12 / P-06: a customer is shown masked in the console
    phone_masked: c.phone_e164 ? maskPhone(c.phone_e164) : null,
    ticket_id: c.ticket_id,
    subscription_id: c.subscription_id,
    org_id: c.org_id,
    operator_name_ar: c.operator_name_ar,
    venue_id: c.venue_id,
    venue_name_ar: c.venue_name_ar,
    resolution_note: c.resolution_note,
    allowed_next: COMPLAINT_TRANSITIONS[c.status],
    created_at: iso(c.created_at)!,
    updated_at: iso(c.updated_at)!,
  };
}

const PLATFORM_SELECT = `SELECT c.id, c.ref_seq, c.account_id, c.category, c.body, c.ticket_id, c.subscription_id,
       c.org_id, c.venue_id, c.status, c.resolution_note, c.handled_by, c.version, c.created_at, c.updated_at,
       v.name_ar AS venue_name_ar, v.name_en AS venue_name_en, a.phone_e164, o.name_ar AS operator_name_ar
  FROM customer_complaints c
  JOIN customer_accounts a ON a.id = c.account_id
  LEFT JOIN venues v ON v.id = c.venue_id AND v.org_id = c.org_id
  LEFT JOIN organizations o ON o.id = c.org_id`;

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
 * P-13 «الشكاوى» (V2-037; DEC-604; `platform.complaint_manage`, every platform role): the complaints of every
 * operator's venues (POINT's record, V2-D12 — the operator is not given them), by status, category or reference, and
 * the status moves of `COMPLAINT_TRANSITIONS` with the note the customer reads, audited in platform_audit_log.
 */
export class PlatformComplaints {
  constructor(private readonly db: Database) {}

  async list(q: PlatformComplaintsQuery) {
    const offset = decodeCursor(q.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) {
      params.push(q.status);
      where.push(`c.status = $${params.length}`);
    }
    if (q.category) {
      params.push(q.category);
      where.push(`c.category = $${params.length}`);
    }
    if (q.q) {
      const seq = complaintSeqOf(q.q) ?? (/^\d{1,12}$/.test(q.q.trim()) ? Number(q.q.trim()) : null);
      params.push(seq ?? -1);
      where.push(`c.ref_seq = $${params.length}`);
    }
    params.push(q.limit + 1, offset);
    const rows = (
      await this.db.query<PlatformRow>(
        `${PLATFORM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return {
      data: rows.slice(0, q.limit).map(platformView),
      next_cursor: rows.length > q.limit ? encodeCursor(offset + q.limit) : null,
    };
  }

  async detail(id: string, q: Q = this.db) {
    const r = UUID.test(id)
      ? (await q.query<PlatformRow>(`${PLATFORM_SELECT} WHERE c.id = $1`, [id])).rows[0]
      : undefined;
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'complaint' });
    const timeline = (
      await q.query<{
        action: string;
        occurred_at: Date;
        actor_role: string | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT action, occurred_at, actor_role, metadata FROM platform_audit_log
          WHERE entity_type = 'complaint' AND entity_id = $1 ORDER BY occurred_at, id`,
        [id],
      )
    ).rows;
    return {
      ...platformView(r),
      timeline: timeline.map((t) => ({
        action: t.action,
        occurred_at: iso(t.occurred_at)!,
        actor_role: t.actor_role,
        to_status: (t.metadata?.to_status as string | undefined) ?? null,
      })),
    };
  }

  async setStatus(
    tx: Tx,
    actor: PlatformActorContext,
    id: string,
    body: PlatformComplaintStatusBody,
    client: ClientInfo,
  ) {
    if (!UUID.test(id)) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'complaint' });
    const c = await tx.maybeOne<{ id: string; status: ComplaintStatus; version: number }>(
      `SELECT id, status, version FROM customer_complaints WHERE id = $1 FOR NO KEY UPDATE`,
      [id],
    );
    if (!c) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'complaint' });
    if (!COMPLAINT_TRANSITIONS[c.status].includes(body.status))
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'complaint',
        entity_id: c.id,
        current_status: c.status,
        command: `complaint.${body.status}`,
        allowed_from: Object.entries(COMPLAINT_TRANSITIONS)
          .filter(([, to]) => to.includes(body.status))
          .map(([from]) => from),
      });
    if (/[0-9]{13,}/.test(body.note))
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'note', issue: 'card_number' }] });
    await tx.query(
      `UPDATE customer_complaints SET status = $3, resolution_note = $4, handled_by = $5, version = version + 1
        WHERE id = $1 AND version = $2`,
      [c.id, c.version, body.status, body.note, actor.userId],
    );
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action: `complaint.${body.status}`,
      entityType: 'complaint',
      entityId: c.id,
      orgId: null,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { from_status: c.status, to_status: body.status },
    });
    return this.detail(c.id, tx);
  }
}
