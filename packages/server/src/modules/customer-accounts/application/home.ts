import { OPEN_TICKET_STATUSES, type TicketStatus } from '@point/shared';
import { CUSTOMER_HOME_NEARBY_MAX, saudiPlateDisplay, type CustomerHome } from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { nearbyLocations, type LocationDeps } from './locations.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

interface VisitRow {
  ticket_id: string;
  venue_id: string;
  venue_name_ar: string;
  venue_name_en: string | null;
  status: TicketStatus;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_raw: string | null;
  received_at: Date;
}

/**
 * `GET /v1/customer/home` (C-06, DEC-482): the visit in progress, live subscriptions and nearby locations in one
 * read. The visit is the latest open ticket of one of the account's linked `customers` rows (V2-D12) — never the key
 * slot or the spot (R3). Subscriptions arrive with V2-03x: the list is empty until then.
 */
export async function customerHome(
  q: Q,
  deps: LocationDeps,
  accountId: string,
  from: { lat: number; lng: number } | null,
): Promise<CustomerHome> {
  const account = (
    await q.query<{ display_name: string | null; vehicles: number }>(
      `SELECT a.display_name,
              (SELECT count(*)::int FROM customer_vehicles v WHERE v.account_id = a.id AND v.removed_at IS NULL) AS vehicles
         FROM customer_accounts a WHERE a.id = $1`,
      [accountId],
    )
  ).rows[0];
  const visit = (
    await q.query<VisitRow>(
      `SELECT t.id AS ticket_id, t.venue_id, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en, t.status,
              t.plate_country, t.plate_digits, t.plate_letters_ar, t.plate_raw,
              COALESCE(t.submitted_at, t.created_at) AS received_at
         FROM tickets t
         JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
         JOIN venues v ON v.id = t.venue_id AND v.org_id = t.org_id
        WHERE c.customer_account_id = $1 AND t.status = ANY($2)
        ORDER BY COALESCE(t.submitted_at, t.created_at) DESC, t.id LIMIT 1`,
      [accountId, [...OPEN_TICKET_STATUSES]],
    )
  ).rows[0];
  return {
    display_name: account?.display_name ?? null,
    current_visit: visit
      ? {
          ticket_id: visit.ticket_id,
          venue_id: visit.venue_id,
          venue_name_ar: visit.venue_name_ar,
          venue_name_en: visit.venue_name_en,
          status: visit.status,
          plate_display:
            visit.plate_country === 'SA'
              ? saudiPlateDisplay({ digits: visit.plate_digits, letters_ar: visit.plate_letters_ar }) || null
              : (visit.plate_raw ?? null),
          received_at: visit.received_at.toISOString(),
        }
      : null,
    subscriptions: [],
    nearby_locations: await nearbyLocations(q, deps, from, CUSTOMER_HOME_NEARBY_MAX),
    vehicles_count: account?.vehicles ?? 0,
  };
}
