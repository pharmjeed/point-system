import { CUSTOMER_HOME_NEARBY_MAX, type CustomerHome } from '@point/shared/customer';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { nearbyLocations, type LocationDeps } from './locations.js';
import { listAccountVisits } from './visits.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * `GET /v1/customer/home` (C-06, DEC-482): the visit in progress, live subscriptions and nearby locations in one
 * read. The visit is the latest open one of {@link listAccountVisits} (V2-014, DEC-504: the tickets of the account's
 * linked `customers` rows, V2-D12) — never the key slot or the spot (R3). The subscriptions are the account's live
 * ones (V2-032: pending payment, active, past due, frozen), newest first; C-14 has their full shape.
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
  const subscriptions = (
    await q.query<{
      id: string;
      venue_id: string;
      venue_name_ar: string;
      venue_name_en: string | null;
      status: CustomerHome['subscriptions'][number]['status'];
      billing_cycle: 'monthly' | 'yearly';
      current_period_end: Date | null;
      cancel_at_period_end: boolean;
    }>(
      `SELECT s.id, s.venue_id, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en, s.status, s.billing_cycle,
              s.current_period_end, s.cancel_at_period_end
         FROM subscriptions s JOIN venues v ON v.id = s.venue_id AND v.org_id = s.org_id
        WHERE s.account_id = $1 AND s.status IN ('pending_payment','active','past_due','frozen')
        ORDER BY s.created_at DESC, s.id`,
      [accountId],
    )
  ).rows;
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
    subscriptions: subscriptions.map((s) => ({
      subscription_id: s.id,
      venue_id: s.venue_id,
      venue_name_ar: s.venue_name_ar,
      venue_name_en: s.venue_name_en,
      status: s.status,
      billing_cycle: s.billing_cycle,
      current_period_end: s.current_period_end ? s.current_period_end.toISOString() : null,
      cancel_at_period_end: s.cancel_at_period_end,
    })),
    nearby_locations: await nearbyLocations(q, deps, from, CUSTOMER_HOME_NEARBY_MAX),
    vehicles_count: account?.vehicles ?? 0,
  };
}
