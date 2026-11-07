/**
 * `GET /v1/customer/home` — one read for C-06 (DEC-482: the screen shows the visit in progress above everything,
 * my subscriptions and the nearby locations; one round trip on launch instead of three). The visit and
 * subscription cards are deliberately small: their full shapes come with C-12 (`/v1/customer/visits`) and C-14
 * (`/v1/customer/subscriptions`).
 */
import { z } from 'zod';
import { TicketStatusSchema } from '../canon/enums.js';
import { CustomerLocationSummarySchema } from './locations.js';

const iso = z.iso.datetime({ offset: true });

/** The visit in progress (a ticket of the account not yet `delivered`/`voided`). No key slot, no spot (R3). */
export const CustomerHomeVisitSchema = z.object({
  ticket_id: z.uuid(),
  venue_id: z.uuid(),
  venue_name_ar: z.string(),
  venue_name_en: z.string().nullable(),
  status: TicketStatusSchema,
  plate_display: z.string().nullable(),
  received_at: iso,
});
export type CustomerHomeVisit = z.infer<typeof CustomerHomeVisitSchema>;

/** `subscriptions.status` (03 §4). */
export const CUSTOMER_SUBSCRIPTION_STATUSES = [
  'pending_payment',
  'active',
  'past_due',
  'canceled',
  'expired',
  'frozen',
] as const;
export const CustomerSubscriptionStatusSchema = z.enum(CUSTOMER_SUBSCRIPTION_STATUSES);

export const CustomerHomeSubscriptionSchema = z.object({
  subscription_id: z.uuid(),
  venue_id: z.uuid(),
  venue_name_ar: z.string(),
  venue_name_en: z.string().nullable(),
  status: CustomerSubscriptionStatusSchema,
  billing_cycle: z.enum(['monthly', 'yearly']),
  current_period_end: iso.nullable(),
  cancel_at_period_end: z.boolean(),
});
export type CustomerHomeSubscription = z.infer<typeof CustomerHomeSubscriptionSchema>;

/** `GET /v1/customer/home` query: the optional position orders `nearby_locations` by distance. */
export const CustomerHomeQuerySchema = z.strictObject({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});
export type CustomerHomeQuery = z.output<typeof CustomerHomeQuerySchema>;

/** Nearby locations on C-06 (the full list is C-07). */
export const CUSTOMER_HOME_NEARBY_MAX = 5;

/** `GET /v1/customer/home` → `data`. */
export const CustomerHomeSchema = z.object({
  display_name: z.string().nullable(),
  /** Shown above everything when present (01 C-06). */
  current_visit: CustomerHomeVisitSchema.nullable(),
  /** Live subscriptions (pending payment, active, past due, frozen). */
  subscriptions: z.array(CustomerHomeSubscriptionSchema),
  nearby_locations: z.array(CustomerLocationSummarySchema).max(CUSTOMER_HOME_NEARBY_MAX),
  vehicles_count: z.int().min(0),
});
export type CustomerHome = z.infer<typeof CustomerHomeSchema>;
