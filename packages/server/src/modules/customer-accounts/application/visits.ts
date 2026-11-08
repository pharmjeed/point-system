import { OPEN_TICKET_STATUSES, type TicketEntitlement, type TicketStatus } from '@point/shared';
import {
  saudiPlateDisplay,
  type CustomerVisitDetail,
  type CustomerVisitSummary,
} from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ObjectStorage } from '../../media/index.js';
import { PHOTO_CACHE_CONTROL } from '../../media/index.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * One visit of a customer account (V2-014, DEC-504): the minimal fields the customer sees of a ticket of one of the
 * account's linked `customers` rows (V2-D12) — never the key tag, the key slot, the spot, the staff, the handover
 * code or the operator's notes (R3). C-12/C-16 (V2-015) are built on top of this.
 */
export interface AccountVisit {
  ticket_id: string;
  org_id: string;
  venue_id: string;
  venue_name_ar: string;
  venue_name_en: string | null;
  /** «تشغيل: …» (V2-D01) */
  operator_name_ar: string;
  operator_name_en: string | null;
  status: TicketStatus;
  open: boolean;
  channel: 'whatsapp' | 'paper' | 'app';
  plate_display: string | null;
  customer_vehicle_id: string | null;
  entitlement: TicketEntitlement;
  received_at: Date;
  delivered_at: Date | null;
  // V2-015 (C-16)
  payment_status: 'not_required' | 'due' | 'collected' | 'waived';
  fee_halalas: number;
  rated: boolean;
}

interface VisitRow {
  ticket_id: string;
  org_id: string;
  venue_id: string;
  venue_name_ar: string;
  venue_name_en: string | null;
  operator_name_ar: string;
  operator_name_en: string | null;
  status: TicketStatus;
  channel: 'whatsapp' | 'paper' | 'app';
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_raw: string | null;
  customer_vehicle_id: string | null;
  entitlement: TicketEntitlement;
  received_at: Date;
  delivered_at: Date | null;
  payment_status: AccountVisit['payment_status'];
  fee_halalas: string | number;
  rated: boolean;
}

export interface AccountVisitsOptions {
  /** only visits not yet delivered (`current_visit` of C-06) */
  openOnly?: boolean;
  limit?: number;
  /** keyset page of C-16: visits strictly older than this one (same order as the list) */
  before?: { receivedAt: Date; ticketId: string } | null;
  /** one ticket of the account (C-12) */
  ticketId?: string;
}

const VISIT_SELECT = `SELECT t.id AS ticket_id, t.org_id, t.venue_id, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en,
            o.name_ar AS operator_name_ar, o.name_en AS operator_name_en, t.status, t.channel,
            t.plate_country, t.plate_digits, t.plate_letters_ar, t.plate_raw, t.customer_vehicle_id, t.entitlement,
            COALESCE(t.submitted_at, t.created_at) AS received_at, t.delivered_at, t.payment_status, t.fee_halalas,
            EXISTS (SELECT 1 FROM customer_visit_ratings r WHERE r.ticket_id = t.id AND r.org_id = t.org_id) AS rated
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
       JOIN venues v ON v.id = t.venue_id AND v.org_id = t.org_id
       JOIN organizations o ON o.id = t.org_id`;

const OPEN = new Set<string>(OPEN_TICKET_STATUSES);

function toVisit(v: VisitRow): AccountVisit {
  return {
    ticket_id: v.ticket_id,
    org_id: v.org_id,
    venue_id: v.venue_id,
    venue_name_ar: v.venue_name_ar,
    venue_name_en: v.venue_name_en,
    operator_name_ar: v.operator_name_ar,
    operator_name_en: v.operator_name_en,
    status: v.status,
    open: OPEN.has(v.status),
    channel: v.channel,
    plate_display:
      v.plate_country === 'SA'
        ? saudiPlateDisplay({ digits: v.plate_digits, letters_ar: v.plate_letters_ar }) || null
        : (v.plate_raw ?? null),
    customer_vehicle_id: v.customer_vehicle_id,
    entitlement: v.entitlement,
    received_at: v.received_at,
    delivered_at: v.delivered_at,
    payment_status: v.payment_status,
    fee_halalas: Number(v.fee_halalas),
    rated: v.rated,
  };
}

/**
 * The visits of a customer account across operators, newest first (V2-014, DEC-504). The only read that crosses
 * operators, by design and for the customer only: it is keyed by the account (`customers.customer_account_id`) and
 * served on the account's own Bearer session, so a customer sees their own visits and nothing else; an operator never
 * calls it and still sees only its own tickets (09 §1 rule 4, the operator-isolation suites). Voided tickets (a wrong
 * intake corrected by a supervisor) are not visits. Every join stays on the ticket's own org_id.
 */
export async function listAccountVisits(
  q: Q,
  accountId: string,
  opts: AccountVisitsOptions = {},
): Promise<AccountVisit[]> {
  const statuses: string[] = opts.openOnly
    ? [...OPEN_TICKET_STATUSES]
    : [...OPEN_TICKET_STATUSES, 'delivered'];
  const r = await q.query<VisitRow>(
    `${VISIT_SELECT}
      WHERE c.customer_account_id = $1 AND t.status = ANY($2)
        AND ($4::uuid IS NULL OR t.id = $4::uuid)
        AND ($5::timestamptz IS NULL OR (COALESCE(t.submitted_at, t.created_at), t.id) < ($5::timestamptz, $6::uuid))
      ORDER BY COALESCE(t.submitted_at, t.created_at) DESC, t.id DESC
      LIMIT $3`,
    [
      accountId,
      statuses,
      Math.min(Math.max(opts.limit ?? 50, 1), 200),
      opts.ticketId ?? null,
      opts.before?.receivedAt ?? null,
      opts.before?.ticketId ?? null,
    ],
  );
  return r.rows.map(toVisit);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A visit of another account, a voided ticket, an unknown or malformed id: the same not-found (08 §1.3 rule 4). */
export const visitNotFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'customer_visit' });

/** The account's visit of that ticket, or RESOURCE_NOT_FOUND (C-12, DEC-516). */
export async function findAccountVisit(q: Q, accountId: string, ticketId: string): Promise<AccountVisit> {
  if (!UUID.test(ticketId)) throw visitNotFound();
  const [v] = await listAccountVisits(q, accountId, { ticketId, limit: 1 });
  if (!v) throw visitNotFound();
  return v;
}

// ---------------------------------------------------------------------------------------------
// C-16 page cursor and the summary
// ---------------------------------------------------------------------------------------------

export function encodeVisitCursor(v: Pick<AccountVisit, 'received_at' | 'ticket_id'>): string {
  return Buffer.from(`${v.received_at.toISOString()}|${v.ticket_id}`, 'utf8').toString('base64url');
}

export function decodeVisitCursor(cursor: string | undefined): { receivedAt: Date; ticketId: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms) || !id || !UUID.test(id))
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'cursor', issue: 'invalid' }] });
  return { receivedAt: new Date(ms), ticketId: id };
}

export function visitSummary(v: AccountVisit): CustomerVisitSummary {
  return {
    ticket_id: v.ticket_id,
    venue_id: v.venue_id,
    venue_name_ar: v.venue_name_ar,
    venue_name_en: v.venue_name_en,
    operator_name_ar: v.operator_name_ar,
    operator_name_en: v.operator_name_en,
    status: v.status,
    open: v.open,
    channel: v.channel,
    plate_display: v.plate_display,
    received_at: v.received_at.toISOString(),
    delivered_at: v.delivered_at ? v.delivered_at.toISOString() : null,
    duration_min: v.delivered_at
      ? Math.max(0, Math.floor((v.delivered_at.getTime() - v.received_at.getTime()) / 60_000))
      : null,
    payment: { entitlement: v.entitlement, payment_status: v.payment_status, fee_halalas: v.fee_halalas },
    rated: v.rated,
  };
}

/** `GET /v1/customer/visits` (C-16): newest first, keyset pages. */
export async function listCustomerVisits(
  q: Q,
  accountId: string,
  query: { cursor?: string | undefined; limit: number },
): Promise<{ items: CustomerVisitSummary[]; nextCursor: string | null }> {
  const before = decodeVisitCursor(query.cursor);
  const rows = await listAccountVisits(q, accountId, { limit: query.limit + 1, before });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(visitSummary),
    nextCursor: rows.length > query.limit && last ? encodeVisitCursor(last) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// C-12: the visit in detail
// ---------------------------------------------------------------------------------------------

export interface VisitDetailDeps {
  storage: ObjectStorage;
  now: Date;
  /** MEDIA_READ_URL_TTL_S, capped at 300 s (09 §6.3) */
  ttlS: number;
}

interface DetailRow {
  parked_at: Date | null;
  pending_retrieval_at: Date | null;
  active_cycle_id: string | null;
  paper_serial: string | null;
  vehicle_make: string | null;
  vehicle_color: string | null;
}

interface CycleRow {
  id: string;
  requested_at: Date;
  assigned_at: Date | null;
  assigned_waiting_at: Date | null;
  started_at: Date | null;
  ready_at: Date | null;
  delivered_at: Date | null;
  closed_at: Date | null;
}

interface LiveCodeRow {
  expires_at: Date;
  locked_at: Date | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/**
 * `GET /v1/customer/visits/{ticketId}` (C-12, DEC-516/DEC-517): the live state, the timeline of the current (or last)
 * cycle, what «اطلب السيارة» would do now, how the car is handed over (and whether the code is shown now), the
 * inspection photos as presigned links, the payment summary and the rating. Never the key slot, the spot or the code.
 */
export async function customerVisitDetail(
  q: Q,
  deps: VisitDetailDeps,
  visit: AccountVisit,
): Promise<CustomerVisitDetail> {
  const t = (
    await q.query<DetailRow>(
      `SELECT parked_at, pending_retrieval_at, active_cycle_id, paper_serial, vehicle_make, vehicle_color
         FROM tickets WHERE id = $1 AND org_id = $2`,
      [visit.ticket_id, visit.org_id],
    )
  ).rows[0]!;
  const cycle = (
    await q.query<CycleRow>(
      `SELECT id, requested_at, assigned_at, assigned_waiting_at, started_at, ready_at, delivered_at, closed_at
         FROM retrieval_cycles WHERE ticket_id = $1 AND org_id = $2
        ORDER BY (closed_at IS NULL) DESC, cycle_no DESC LIMIT 1`,
      [visit.ticket_id, visit.org_id],
    )
  ).rows[0];
  // a closed cycle that did not deliver (canceled, reparked) is history: the timeline restarts at «parked»
  const current = cycle && (cycle.closed_at === null || cycle.delivered_at) ? cycle : null;
  const live =
    visit.status === 'ready' && t.active_cycle_id
      ? (
          await q.query<LiveCodeRow>(
            `SELECT expires_at, locked_at FROM claim_codes
              WHERE cycle_id = $1 AND org_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL
                AND code_ciphertext IS NOT NULL`,
            [t.active_cycle_id, visit.org_id],
          )
        ).rows[0]
      : undefined;
  const photos = await q.query<{ id: string; kind: string; storage_key: string; content_type: string }>(
    `SELECT id, kind, storage_key, content_type FROM media_assets
      WHERE ticket_id = $1 AND org_id = $2 AND upload_status = 'uploaded' AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [visit.ticket_id, visit.org_id],
  );
  const rating = (
    await q.query<{ stars: number; note: string | null; created_at: Date }>(
      `SELECT stars, note, created_at FROM customer_visit_ratings WHERE ticket_id = $1 AND org_id = $2`,
      [visit.ticket_id, visit.org_id],
    )
  ).rows[0];

  const ttl = Math.min(Math.max(Math.trunc(deps.ttlS), 1), 300);
  const signed = [];
  for (const p of photos.rows) {
    const s = await deps.storage.presignDownload(p.storage_key, {
      expiresInS: ttl,
      now: deps.now,
      contentType: p.content_type,
      cacheControl: PHOTO_CACHE_CONTROL,
    });
    signed.push({
      kind: p.kind as CustomerVisitDetail['photos'][number]['kind'],
      url: s.url,
      expires_at: s.expiresAt.toISOString(),
    });
  }

  const parking = visit.status === 'received' || visit.status === 'parking' || visit.status === 'reparking';
  const canRequest =
    (visit.status === 'parked' && !t.active_cycle_id) ||
    (parking && !t.active_cycle_id && !t.pending_retrieval_at);
  const method: CustomerVisitDetail['handover']['method'] =
    visit.channel === 'app' ? 'app_code' : visit.channel === 'whatsapp' ? 'whatsapp' : 'staff';
  const codeAvailable =
    method === 'app_code' && !!live && !live.locked_at && live.expires_at.getTime() > deps.now.getTime();

  return {
    ...visitSummary(visit),
    timeline: [
      { step: 'received', at: visit.received_at.toISOString() },
      { step: 'parked', at: iso(t.parked_at) },
      { step: 'requested', at: iso(current?.requested_at ?? t.pending_retrieval_at) },
      { step: 'accepted', at: iso(current?.assigned_at ?? current?.assigned_waiting_at) },
      { step: 'on_the_way', at: iso(current?.started_at) },
      { step: 'ready', at: iso(current?.ready_at) },
      { step: 'delivered', at: iso(visit.delivered_at) },
    ],
    request: {
      can_request: canRequest,
      pending_early: !!t.pending_retrieval_at && !t.active_cycle_id,
      requested_at: iso(
        t.active_cycle_id && current && current.closed_at === null
          ? current.requested_at
          : t.pending_retrieval_at,
      ),
    },
    handover: {
      method,
      code_available: codeAvailable,
      code_expires_at: codeAvailable ? iso(live!.expires_at) : null,
    },
    photos: signed,
    rating: rating
      ? {
          ticket_id: visit.ticket_id,
          stars: rating.stars,
          note: rating.note,
          rated_at: rating.created_at.toISOString(),
        }
      : null,
    can_rate: visit.status === 'delivered' && !rating,
    vehicle_make: t.vehicle_make,
    vehicle_color: t.vehicle_color,
  };
}
