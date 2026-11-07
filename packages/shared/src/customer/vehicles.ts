/**
 * The customer's vehicles (`customer_vehicles`, docs/v2/03_Data_Model.md §3): `GET/POST/DELETE
 * /v1/customer/vehicles[/{id}]` (05 §1). C-05: up to 5 vehicles, Saudi plate (letters + digits) normalised as in
 * `tickets` (07 §1.8, `normalizeSaudiPlate`). Shapes chosen in V2-011 (DEC-482).
 */
import { z } from 'zod';

/** `customer_vehicles.vehicle_type` (03 §3). */
export const CUSTOMER_VEHICLE_TYPES = ['sedan', 'suv', 'pickup', 'van', 'other'] as const;
export type CustomerVehicleType = (typeof CUSTOMER_VEHICLE_TYPES)[number];
export const CustomerVehicleTypeSchema = z.enum(CUSTOMER_VEHICLE_TYPES);

/** C-05 «حتى 5 سيارات»: one more → `CUSTOMER_VEHICLE_LIMIT` with `details.max`. */
export const CUSTOMER_VEHICLES_MAX = 5;

/**
 * Plate as typed: the server normalises it (`normalizeSaudiPlate`) and answers `PLATE_INVALID` with
 * `details.field`/`details.reason` (08) when it cannot. V2-011 accepts Saudi plates only.
 */
export const CustomerPlateInputSchema = z.strictObject({
  country: z.literal('SA').default('SA'),
  digits: z.string().max(12),
  letters_ar: z.string().max(24),
});

/** A make/colour key of 02 §8.4 (`toyota`, `white`) or the typed text for «أخرى» (DEC-350). */
const freeKey = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(40));

/** `POST /v1/customer/vehicles` body (Idempotency-Key required). A plate already in the account → `CUSTOMER_VEHICLE_DUPLICATE`. */
export const CustomerVehicleCreateBodySchema = z.strictObject({
  plate: CustomerPlateInputSchema,
  vehicle_make: freeKey.nullable().optional(),
  vehicle_model: freeKey.nullable().optional(),
  vehicle_color: freeKey.nullable().optional(),
  vehicle_type: CustomerVehicleTypeSchema.nullable().optional(),
});
export type CustomerVehicleCreateBody = z.input<typeof CustomerVehicleCreateBodySchema>;

/** The plate as stored and shown (the `Plate` schema of 07, `display` = digits then letters). */
export const CustomerPlateSchema = z.object({
  country: z.string(),
  digits: z.string().nullable(),
  letters_ar: z.string().nullable(),
  letters_en: z.string().nullable(),
  raw: z.string().nullable(),
  display: z.string(),
});
export type CustomerPlate = z.infer<typeof CustomerPlateSchema>;

export const CustomerVehicleSchema = z.object({
  id: z.uuid(),
  plate: CustomerPlateSchema,
  vehicle_make: z.string().nullable(),
  vehicle_model: z.string().nullable(),
  vehicle_color: z.string().nullable(),
  vehicle_type: CustomerVehicleTypeSchema.nullable(),
  /** A vehicle in a visit in progress cannot be removed (C-15). */
  in_active_visit: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
});
export type CustomerVehicle = z.infer<typeof CustomerVehicleSchema>;

/** `GET /v1/customer/vehicles` → `data` (oldest first; at most `CUSTOMER_VEHICLES_MAX`, so no cursor). */
export const CustomerVehicleListSchema = z.object({ items: z.array(CustomerVehicleSchema) });
export type CustomerVehicleList = z.infer<typeof CustomerVehicleListSchema>;
