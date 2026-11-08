import { OPEN_TICKET_STATUSES, type TicketEntitlement, type TicketStatus } from '@point/shared';
import { saudiPlateDisplay } from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * One visit of a customer account (V2-014, DEC-504): the minimal fields the customer sees of a ticket of one of the
 * account's linked `customers` rows (V2-D12) — never the key tag, the key slot, the spot, the staff, the handover
 * code or the operator's notes (R3). Full C-12/C-16 shapes are built on top of this by V2-015/V2-016.
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
}

export interface AccountVisitsOptions {
  /** only visits not yet delivered (`current_visit` of C-06) */
  openOnly?: boolean;
  limit?: number;
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
    `SELECT t.id AS ticket_id, t.org_id, t.venue_id, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en,
            o.name_ar AS operator_name_ar, o.name_en AS operator_name_en, t.status, t.channel,
            t.plate_country, t.plate_digits, t.plate_letters_ar, t.plate_raw, t.customer_vehicle_id, t.entitlement,
            COALESCE(t.submitted_at, t.created_at) AS received_at, t.delivered_at
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
       JOIN venues v ON v.id = t.venue_id AND v.org_id = t.org_id
       JOIN organizations o ON o.id = t.org_id
      WHERE c.customer_account_id = $1 AND t.status = ANY($2)
      ORDER BY COALESCE(t.submitted_at, t.created_at) DESC, t.id
      LIMIT $3`,
    [accountId, statuses, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );
  const open = new Set<string>(OPEN_TICKET_STATUSES);
  return r.rows.map((v) => ({
    ticket_id: v.ticket_id,
    org_id: v.org_id,
    venue_id: v.venue_id,
    venue_name_ar: v.venue_name_ar,
    venue_name_en: v.venue_name_en,
    operator_name_ar: v.operator_name_ar,
    operator_name_en: v.operator_name_en,
    status: v.status,
    open: open.has(v.status),
    channel: v.channel,
    plate_display:
      v.plate_country === 'SA'
        ? saudiPlateDisplay({ digits: v.plate_digits, letters_ar: v.plate_letters_ar }) || null
        : (v.plate_raw ?? null),
    customer_vehicle_id: v.customer_vehicle_id,
    entitlement: v.entitlement,
    received_at: v.received_at,
    delivered_at: v.delivered_at,
  }));
}
