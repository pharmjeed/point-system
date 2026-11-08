import { CUSTOMER_HOME_NEARBY_MAX, type CustomerHome } from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { nearbyLocations, type LocationDeps } from './locations.js';
import { listAccountVisits } from './visits.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * `GET /v1/customer/home` (C-06, DEC-482): the visit in progress, live subscriptions and nearby locations in one
 * read. The visit is the latest open one of {@link listAccountVisits} (V2-014, DEC-504: the tickets of the account's
 * linked `customers` rows, V2-D12) — never the key slot or the spot (R3). Subscriptions arrive with V2-03x: the list
 * is empty until then.
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
  const [visit] = await listAccountVisits(q, accountId, { openOnly: true, limit: 1 });
  return {
    display_name: account?.display_name ?? null,
    current_visit: visit
      ? {
          ticket_id: visit.ticket_id,
          venue_id: visit.venue_id,
          venue_name_ar: visit.venue_name_ar,
          venue_name_en: visit.venue_name_en,
          status: visit.status,
          plate_display: visit.plate_display,
          received_at: visit.received_at.toISOString(),
        }
      : null,
    subscriptions: [],
    nearby_locations: await nearbyLocations(q, deps, from, CUSTOMER_HOME_NEARBY_MAX),
    vehicles_count: account?.vehicles ?? 0,
  };
}
