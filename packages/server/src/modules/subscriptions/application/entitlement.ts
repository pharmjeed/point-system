import { isServiceDay, OPEN_TICKET_STATUSES, riyadhDate, riyadhMidnight } from '@point/shared';
import type { Tx } from '../../../core/db/tx.js';

/** The ticket fields the entitlement reads (a locked `tickets` row of the intake command). */
export interface EntitlementTicket {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  channel: string;
  customer_id: string | null;
  customer_vehicle_id: string | null;
  plate_country: string | null;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  payment_status: string;
  fee_halalas: number | string;
  entitlement: string;
  subscription_id: string | null;
  status: string;
}

export interface SubscriptionCoverage {
  subscriptionId: string;
  vehicleId: string;
}

export type CoverageResult =
  | { covered: true; coverage: SubscriptionCoverage }
  | {
      covered: false;
      reason:
        | 'no_account'
        | 'no_subscription'
        | 'vehicle_not_covered'
        | 'open_ticket'
        // V2-036 (DEC-592): a counted-day term not begun, a day that does not serve, the day's visit already covered
        | 'not_started'
        | 'not_service_day'
        | 'daily_limit';
    };

/**
 * Rule 1 of docs/v2/04 §2 (V2-033, DEC-535): the account's `active` subscription at this venue covering this vehicle,
 * with no other open ticket of that vehicle. The account is the one the operator's `customers` row of the ticket is
 * linked to (V2-D12, DEC-504: an app intake links it; a WhatsApp or paper ticket only when that row was linked by an
 * earlier pass intake at this operator — the app's pass is how a subscriber is recognized). The vehicle is matched
 * by `customer_vehicle_id` for an app ticket that carries it, else by the plate (country, digits and Arabic letters,
 * normalized at the source) among the subscription's covered vehicles still in the account. The subscription row is
 * read FOR SHARE: a renewal, a cancel or a freeze running at the same moment is serialized with the intake.
 */
export async function subscriptionCoverage(tx: Tx, t: EntitlementTicket): Promise<CoverageResult> {
  if (!t.customer_id) return { covered: false, reason: 'no_account' };
  const account = await tx.maybeOne<{ account_id: string | null }>(
    `SELECT customer_account_id AS account_id FROM customers WHERE id = $1 AND org_id = $2`,
    [t.customer_id, t.org_id],
  );
  if (!account?.account_id) return { covered: false, reason: 'no_account' };
  const sub = await tx.maybeOne<{
    id: string;
    current_period_start: Date | null;
    term_kind: string;
    service_weekdays_mask: number | null;
    daily_visit_limit: number | null;
  }>(
    `SELECT s.id, s.current_period_start, p.term_kind, p.service_weekdays_mask, p.daily_visit_limit
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id AND p.org_id = s.org_id
      WHERE s.account_id = $1 AND s.venue_id = $2 AND s.org_id = $3 AND s.status = 'active'
      FOR SHARE OF s`,
    [account.account_id, t.venue_id, t.org_id],
  );
  if (!sub) return { covered: false, reason: 'no_subscription' };
  // 04 §7 (DEC-592; annex clauses 1, 2): a counted-day term covers from its first counted day, on its service
  // weekdays only, and one visit cycle per Riyadh day — a second one that day is a normal visit of the venue
  const today = riyadhDate(tx.now);
  if (sub.current_period_start && sub.current_period_start > tx.now)
    return { covered: false, reason: 'not_started' };
  if (
    sub.term_kind === 'service_days' &&
    sub.service_weekdays_mask !== null &&
    !isServiceDay(today, sub.service_weekdays_mask)
  )
    return { covered: false, reason: 'not_service_day' };
  if (sub.daily_visit_limit !== null) {
    const used = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM tickets
        WHERE org_id = $1 AND subscription_id = $2 AND id <> $3 AND status <> 'voided' AND created_at >= $4`,
      [t.org_id, sub.id, t.id, riyadhMidnight(today)],
    );
    if (used.n >= sub.daily_visit_limit) return { covered: false, reason: 'daily_limit' };
  }
  const vehicle = await tx.maybeOne<{
    id: string;
    plate_digits: string | null;
    plate_letters_ar: string | null;
  }>(
    t.customer_vehicle_id
      ? `SELECT cv.id, cv.plate_digits, cv.plate_letters_ar
           FROM subscription_vehicles sv JOIN customer_vehicles cv ON cv.id = sv.customer_vehicle_id
          WHERE sv.subscription_id = $1 AND sv.removed_at IS NULL AND cv.removed_at IS NULL AND cv.id = $2`
      : `SELECT cv.id, cv.plate_digits, cv.plate_letters_ar
           FROM subscription_vehicles sv JOIN customer_vehicles cv ON cv.id = sv.customer_vehicle_id
          WHERE sv.subscription_id = $1 AND sv.removed_at IS NULL AND cv.removed_at IS NULL
            AND cv.plate_country = $2 AND cv.plate_digits = $3 AND cv.plate_letters_ar = $4
          ORDER BY sv.added_at LIMIT 1`,
    t.customer_vehicle_id
      ? [sub.id, t.customer_vehicle_id]
      : [sub.id, t.plate_country ?? 'SA', t.plate_digits, t.plate_letters_ar],
  );
  if (!vehicle) return { covered: false, reason: 'vehicle_not_covered' };
  // one open ticket per covered vehicle at a time (V2-D06): this vehicle by its account id anywhere at this operator,
  // or by its plate at this venue (a paper or WhatsApp intake of the same car)
  const other = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tickets
      WHERE org_id = $1 AND id <> $2 AND status = ANY($3)
        AND (customer_vehicle_id = $4
             OR (venue_id = $5 AND plate_digits = $6 AND plate_letters_ar = $7))
      LIMIT 1`,
    [
      t.org_id,
      t.id,
      OPEN_TICKET_STATUSES,
      vehicle.id,
      t.venue_id,
      vehicle.plate_digits ?? '',
      vehicle.plate_letters_ar ?? '',
    ],
  );
  if (other) return { covered: false, reason: 'open_ticket' };
  return { covered: true, coverage: { subscriptionId: sub.id, vehicleId: vehicle.id } };
}

/**
 * Applies the entitlement of rule 1 to a ticket being taken in (the pass scan and «إتمام التسجيل»; V2-033, DEC-535),
 * holding its lock (L5): covered → `entitlement = subscription`, `subscription_id`, nothing due at the handover
 * (`payment_status = not_required`, fee 0: the visit is the subscription's, `ck_tickets_subscription_not_due`);
 * no longer covered (another plate typed, the subscription ended) → back to what the event decides (`event_included`,
 * or `none` with the event's fee — the snapshot of DEC-43 taken again from the event). A ticket already paid or waived
 * is left as it is. Returns the change, or null when nothing changed.
 */
export async function applySubscriptionEntitlement(
  tx: Tx,
  t: EntitlementTicket,
): Promise<{ entitlement: string; subscription_id: string | null; before: string; reason?: string } | null> {
  if (t.status === 'delivered' || t.status === 'voided') return null;
  if (t.payment_status === 'collected' || t.payment_status === 'waived' || t.entitlement === 'app_paid')
    return null;
  const result = await subscriptionCoverage(tx, t);
  if (result.covered) {
    if (t.entitlement === 'subscription' && t.subscription_id === result.coverage.subscriptionId) return null;
    await tx.query(
      `UPDATE tickets SET entitlement = 'subscription', subscription_id = $2, payment_status = 'not_required',
              fee_halalas = 0, version = version + 1
        WHERE id = $1 AND org_id = $3`,
      [t.id, result.coverage.subscriptionId, t.org_id],
    );
    return {
      entitlement: 'subscription',
      subscription_id: result.coverage.subscriptionId,
      before: t.entitlement,
    };
  }
  if (t.entitlement !== 'subscription') return null;
  const ev = await tx.one<{ pricing_mode: string; fee_halalas: number }>(
    `SELECT pricing_mode, fee_halalas::float8 AS fee_halalas FROM events WHERE id = $1 AND org_id = $2`,
    [t.event_id, t.org_id],
  );
  const perVehicle = ev.pricing_mode === 'per_vehicle';
  await tx.query(
    `UPDATE tickets SET entitlement = $2, subscription_id = NULL, payment_status = $3, fee_halalas = $4,
            version = version + 1
      WHERE id = $1 AND org_id = $5`,
    [
      t.id,
      perVehicle ? 'none' : 'event_included',
      perVehicle ? 'due' : 'not_required',
      perVehicle ? ev.fee_halalas : 0,
      t.org_id,
    ],
  );
  return {
    entitlement: perVehicle ? 'none' : 'event_included',
    subscription_id: null,
    before: 'subscription',
    reason: result.reason,
  };
}
