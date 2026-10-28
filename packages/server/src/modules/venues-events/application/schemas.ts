import {
  EventStatusSchema,
  PaymentMethodSchema,
  PricingModeSchema,
  SetupStatusSchema,
  venueSettingsSchema,
} from '@point/shared';
import { z } from 'zod';

/**
 * Request schemas of canon §9.5 (shapes from 07_openapi.yaml). Bodies are strict (unknown fields rejected,
 * VALIDATION_FAILED); query strings ignore unknown parameters.
 */

const id = () => z.guid();
const version = () => z.number().int().min(1);
const int32 = () => z.number().int().min(-2147483648).max(2147483647);
const isoDateTime = () => z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------------------------

const limit = z.coerce.number().int().min(1).max(200).default(50);
const cursor = z.string().min(1).max(2048).optional();
const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const many = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item)])
    .transform((v) => (Array.isArray(v) ? v : [v]) as z.output<T>[])
    .optional();

export const ListVenuesQuery = z.object({ status: SetupStatusSchema.optional(), limit, cursor });
export type ListVenuesQuery = z.output<typeof ListVenuesQuery>;

/**
 * Layout lists (`venue.layout_read`). `active_only=true` is the pick-list mode (D-08): only active zones, boards,
 * spots of active zones and slots of active boards; it is always on for drivers (DEC-33, PNT-018 AC4).
 */
export const ListZonesQuery = z.object({ active_only: flag });
export type ListZonesQuery = z.output<typeof ListZonesQuery>;

export const ListSpotsQuery = z.object({
  zone_id: id().optional(),
  available_only: flag,
  active_only: flag,
  limit,
  cursor,
});
export type ListSpotsQuery = z.output<typeof ListSpotsQuery>;

export const ListKeyBoardsQuery = z.object({ active_only: flag });
export type ListKeyBoardsQuery = z.output<typeof ListKeyBoardsQuery>;

export const ListEventsQuery = z
  .object({
    status: many(EventStatusSchema),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit,
    cursor,
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'to must not be before from' });
export type ListEventsQuery = z.output<typeof ListEventsQuery>;

// ---------------------------------------------------------------------------------------------
// venues and settings
// ---------------------------------------------------------------------------------------------

export const CreateVenueBody = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{2,8}$/, 'code must be 2–8 characters A–Z or 0–9'),
  name_ar: text(200),
  name_en: text(200).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(120).optional(),
  timezone: z.string().refine(isTimeZone, 'unknown IANA time zone').default('Asia/Riyadh'),
});
export type CreateVenueBody = z.output<typeof CreateVenueBody>;

export const UpdateVenueBody = z.strictObject({
  expected_version: version(),
  name_ar: text(200).optional(),
  name_en: z.string().trim().max(200).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  status: SetupStatusSchema.optional(),
});
export type UpdateVenueBody = z.output<typeof UpdateVenueBody>;

/** `settings` is validated with the shared canon §12 schema (strict, defaults completed). */
export const PutVenueSettingsBody = z.strictObject({
  expected_version: version(),
  settings: venueSettingsSchema,
});
export type PutVenueSettingsBody = z.output<typeof PutVenueSettingsBody>;

// ---------------------------------------------------------------------------------------------
// dispatch pools, zones, spots, boards, slots (no `version` column: no expected_version)
// ---------------------------------------------------------------------------------------------

export const CreateDispatchPoolBody = z.strictObject({ name: text(60) });
export type CreateDispatchPoolBody = z.output<typeof CreateDispatchPoolBody>;

export const UpdateDispatchPoolBody = z.strictObject({
  name: text(60).optional(),
  status: SetupStatusSchema.optional(),
  is_default: z.boolean().optional(),
});
export type UpdateDispatchPoolBody = z.output<typeof UpdateDispatchPoolBody>;

export const CreateParkingZoneBody = z.strictObject({ name: text(60), sort_order: int32().optional() });
export type CreateParkingZoneBody = z.output<typeof CreateParkingZoneBody>;

export const UpdateParkingZoneBody = z.strictObject({
  name: text(60).optional(),
  sort_order: int32().optional(),
  status: SetupStatusSchema.optional(),
});
export type UpdateParkingZoneBody = z.output<typeof UpdateParkingZoneBody>;

const labelRange = z.strictObject({
  prefix: z.string().max(10).optional(),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});
const labelList = z.array(z.string().max(20)).max(500);

export const CreateParkingSpotsBody = z.strictObject({
  zone_id: id(),
  labels: labelList.optional(),
  range: labelRange.optional(),
});
export type CreateParkingSpotsBody = z.output<typeof CreateParkingSpotsBody>;

export const CreateKeySlotsBody = z.strictObject({
  labels: labelList.optional(),
  range: labelRange.optional(),
});
export type CreateKeySlotsBody = z.output<typeof CreateKeySlotsBody>;

export const UpdateLabelledBody = z.strictObject({
  label: text(20).optional(),
  status: SetupStatusSchema.optional(),
});
export type UpdateLabelledBody = z.output<typeof UpdateLabelledBody>;

export const CreateKeyBoardBody = z.strictObject({ name: text(60) });
export type CreateKeyBoardBody = z.output<typeof CreateKeyBoardBody>;

// ---------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------

const eventFields = {
  name_ar: text(120),
  host_name: z.string().trim().max(120).nullable().optional(),
  event_date: z.iso.date(),
  starts_at: isoDateTime().nullable().optional(),
  ends_at: isoDateTime().nullable().optional(),
  dispatch_pool_id: id().optional(),
  pricing_mode: PricingModeSchema,
  fee_halalas: z.number().int().min(0).optional(),
  allowed_payment_methods: z.array(PaymentMethodSchema).min(1).optional(),
};

export const CreateEventBody = z.strictObject(eventFields);
export type CreateEventBody = z.output<typeof CreateEventBody>;

export const UpdateEventBody = z.strictObject({
  name_ar: eventFields.name_ar.optional(),
  host_name: eventFields.host_name,
  event_date: eventFields.event_date.optional(),
  starts_at: eventFields.starts_at,
  ends_at: eventFields.ends_at,
  dispatch_pool_id: eventFields.dispatch_pool_id,
  pricing_mode: eventFields.pricing_mode.optional(),
  fee_halalas: eventFields.fee_halalas,
  allowed_payment_methods: eventFields.allowed_payment_methods,
  expected_version: version(),
});
export type UpdateEventBody = z.output<typeof UpdateEventBody>;

export const VersionOnlyBody = z.strictObject({ expected_version: version().optional() });
export type VersionOnlyBody = z.output<typeof VersionOnlyBody>;

/** `reason` length is checked by the handler so that a missing/short reason is REASON_REQUIRED (08 §4.16). */
export const CancelEventBody = z.strictObject({
  reason: z.string().max(500).nullable().optional(),
  expected_version: version().optional(),
});
export type CancelEventBody = z.output<typeof CancelEventBody>;
