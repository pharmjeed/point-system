/**
 * `GET /v1/customer/pass` (C-11, V2-013, DEC-500): what the app caches in secure storage to draw the rotating QR
 * with no network (V2-D14). The token format and the pure generator/verifier are in ./pass.ts.
 */
import { z } from 'zod';
import { PASS_STEP_S, PASS_TOKEN_PREFIX } from './pass.js';

const iso = z.iso.datetime({ offset: true });

/** A vehicle the customer may choose on C-11 (no key, no spot, no visit data). */
export const CustomerPassVehicleSchema = z.object({
  vehicle_id: z.uuid(),
  plate_display: z.string(),
  vehicle_make: z.string().nullable(),
  vehicle_color: z.string().nullable(),
  /** DEC-642: the car drawn next to the plate; optional so a pass cached before it still parses */
  vehicle_type: z.string().nullable().optional(),
});
export type CustomerPassVehicle = z.infer<typeof CustomerPassVehicleSchema>;

/** `GET /v1/customer/pass` → `data`. */
export const CustomerPassSchema = z.object({
  /** The token format of ./pass.ts (`P1.<account>.<vehicle>.<step>.<mac>`). */
  scheme: z.literal(PASS_TOKEN_PREFIX),
  account_id: z.uuid(),
  /** 32 bytes, base64url: kept in the device's secure storage only, never logged or shown. */
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  step_seconds: z.literal(PASS_STEP_S),
  /** The server clock when the response was built: the app keeps `server_time − device time` to correct its steps. */
  server_time: iso,
  /** When the secret was last rotated. */
  rotated_at: iso,
  /** Fetch again (online) after this instant: the server rotates the secret once it is older than its period. */
  refresh_after: iso,
  vehicles: z.array(CustomerPassVehicleSchema),
});
export type CustomerPass = z.infer<typeof CustomerPassSchema>;
