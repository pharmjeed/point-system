/**
 * Settings schemas with the defaults of canon §12.
 *
 * Stored shape: the dotted canon keys are nested objects inside the jsonb columns
 * (`dispatch.single_offer_ttl_s` → `{ "dispatch": { "single_offer_ttl_s": 30 } }`), exactly as the
 * `VenueSettings`/`OrgSettings` schemas of docs/07_openapi.yaml. `venues.settings` and
 * `organizations.settings` default to `'{}'` in docs/06_schema.sql, so missing keys are completed
 * from the defaults on read; unknown keys are rejected at every level (strict).
 *
 * Ranges come from docs/07_openapi.yaml where it defines them; keys it does not cover
 * (`ops.*`, `alerts.*`, `push.*`, `wa.*`) are positive integers.
 */
import { z } from 'zod';
import type { MediaKind, PaymentMethod } from './canon/enums.js';
import { MediaKindSchema, ParkingModeSchema, PaymentMethodSchema, PricingModeSchema } from './canon/enums.js';

const int = () => z.number().int();
const positiveInt = () => int().min(1);

function uniqueItems(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

// ---------------------------------------------------------------------------------------------
// Venue settings (`venues.settings`)
// ---------------------------------------------------------------------------------------------

const venueDispatchSchema = z
  .strictObject({
    /** Single-offer reminder (5 … ttl − 5). */
    single_offer_reminder_s: int().min(5).max(115).default(15),
    /** Single-offer expiry. */
    single_offer_ttl_s: int().min(10).max(120).default(30),
    /** One reminder for an open broadcast. */
    broadcast_reminder_s: int().min(10).max(300).default(30),
    /** Escalation to the supervisor from queue entry without acceptance. */
    unaccepted_escalation_s: int().min(20).max(900).default(60),
    /** Alert for a next task waiting too long. */
    next_task_wait_alert_s: int().min(60).max(3600).default(300),
    /** Alert the supervisor when a driver is available while the oldest request is a reserved next task. */
    idle_driver_alert: z.boolean().default(true),
    /** Grace for an accept arriving after `expires_at` because of network delay. */
    accept_grace_ms: int().min(0).max(5000).default(1500),
    /** Put drivers with an uncertain connection last in the single-offer order. */
    offline_drivers_last: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.single_offer_reminder_s > v.single_offer_ttl_s - 5) {
      ctx.addIssue({
        code: 'custom',
        path: ['single_offer_reminder_s'],
        message: 'single_offer_reminder_s must be at most single_offer_ttl_s - 5',
      });
    }
  });

const venueHandoverSchema = z.strictObject({
  /** Handover code validity from readiness. */
  code_ttl_min: int().min(5).default(30),
  /** Code attempts before locking. */
  max_attempts: int().min(3).max(10).default(5),
  /** Resend limit. */
  max_resends: int().min(0).max(10).default(3),
});

const venueReadySchema = z.strictObject({
  /** Alert for a ready vehicle not collected. */
  uncollected_alert_min: int().min(2).max(60).default(10),
});

const venueIntakeSchema = z.strictObject({
  /** Alert for an intake draft left without submission. */
  draft_abandoned_alert_min: int().min(1).default(10),
});

const venueInspectionSchema = z.strictObject({
  /** Mandatory inspection photos. */
  required_photos: z
    .array(MediaKindSchema)
    .refine(uniqueItems, 'required_photos must not repeat a kind')
    .default((): MediaKind[] => ['photo_front', 'photo_rear', 'photo_left', 'photo_right']),
  /** Extra photos. */
  max_extra_photos: int().min(0).max(20).default(8),
});

const venueLinkSchema = z.strictObject({
  /** QR link code validity. */
  qr_ttl_min: int().min(2).max(60).default(10),
});

const venueParkingSchema = z.strictObject({
  /** `assigned_spots` · `free_text` · `mixed` */
  mode: ParkingModeSchema.default('mixed'),
});

const venueKeysSchema = z.strictObject({
  /** A key slot is mandatory when parking. */
  require_slot: z.boolean().default(true),
});

const venuePricingSchema = z
  .strictObject({
    /** Default for new events. */
    default_mode: PricingModeSchema.default('included'),
    /** Default fee in halalas (SAR × 100). */
    default_fee_halalas: int().min(0).default(0),
    /** Collection methods. */
    allowed_methods: z
      .array(PaymentMethodSchema)
      .refine(uniqueItems, 'allowed_methods must not repeat a method')
      .default((): PaymentMethod[] => ['cash', 'pos']),
  })
  .superRefine((v, ctx) => {
    // The defaults seed new events, so they obey ck_events_fee_zero_unless_per_vehicle and
    // ck_events_per_vehicle_fee_positive of docs/06_schema.sql.
    if (v.default_mode === 'included' && v.default_fee_halalas !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_fee_halalas'],
        message: 'default_fee_halalas must be 0 when default_mode is included',
      });
    }
    if (v.default_mode === 'per_vehicle' && v.default_fee_halalas <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_fee_halalas'],
        message: 'default_fee_halalas must be positive when default_mode is per_vehicle',
      });
    }
  });

/** `venues.settings` — keys and defaults of canon §12, in canon order. */
export const venueSettingsSchema = z.strictObject({
  dispatch: venueDispatchSchema.prefault({}),
  handover: venueHandoverSchema.prefault({}),
  ready: venueReadySchema.prefault({}),
  intake: venueIntakeSchema.prefault({}),
  inspection: venueInspectionSchema.prefault({}),
  link: venueLinkSchema.prefault({}),
  parking: venueParkingSchema.prefault({}),
  keys: venueKeysSchema.prefault({}),
  pricing: venuePricingSchema.prefault({}),
});
/** Venue settings after parsing (every key present). */
export type VenueSettings = z.output<typeof venueSettingsSchema>;
/** Venue settings as stored or sent (any key may be missing). */
export type VenueSettingsInput = z.input<typeof venueSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Organization settings (`organizations.settings`)
// ---------------------------------------------------------------------------------------------

/** The editable part of `security.*` (DEC-39); `pin_length` is fixed (DEC-09). */
const orgSecurityEditableShape = {
  /** Supervisor MFA (admins and the owner always require it). */
  supervisor_mfa_required: z.boolean(),
  driver_session_hours: positiveInt(),
  staff_session_hours: positiveInt(),
  /** Then a 15-minute lock. */
  max_login_attempts: int().min(3),
  /** Idle timeout of owner and admin sessions. */
  admin_idle_minutes: int().min(5),
  /** Full-phone reveal limit per user. */
  reveal_phone_per_hour: positiveInt(),
};

const orgHeartbeatShape = {
  interval_s: int().min(5),
  uncertain_after_s: int().min(10),
  offline_after_s: int().min(30),
};

function heartbeatOrder(
  v: { interval_s: number; uncertain_after_s: number; offline_after_s: number },
  ctx: z.RefinementCtx,
): void {
  if (!(v.interval_s < v.uncertain_after_s && v.uncertain_after_s < v.offline_after_s)) {
    ctx.addIssue({
      code: 'custom',
      path: ['uncertain_after_s'],
      message: 'heartbeat requires interval_s < uncertain_after_s < offline_after_s',
    });
  }
}

const orgSecuritySchema = z.strictObject({
  supervisor_mfa_required: orgSecurityEditableShape.supervisor_mfa_required.default(true),
  driver_session_hours: orgSecurityEditableShape.driver_session_hours.default(14),
  staff_session_hours: orgSecurityEditableShape.staff_session_hours.default(12),
  /** Fixed in V1 (DEC-09); not editable from the UI. */
  pin_length: z.literal(6).default(6),
  max_login_attempts: orgSecurityEditableShape.max_login_attempts.default(5),
  admin_idle_minutes: orgSecurityEditableShape.admin_idle_minutes.default(30),
  reveal_phone_per_hour: orgSecurityEditableShape.reveal_phone_per_hour.default(20),
});

const orgHeartbeatSchema = z
  .strictObject({
    interval_s: orgHeartbeatShape.interval_s.default(15),
    uncertain_after_s: orgHeartbeatShape.uncertain_after_s.default(45),
    offline_after_s: orgHeartbeatShape.offline_after_s.default(120),
  })
  .superRefine(heartbeatOrder);

const orgRetentionSchema = z.strictObject({
  // Proposed values until the owner approves them (Q-06).
  photos_days: positiveInt().default(90),
  wa_messages_days: positiveInt().default(180),
  tickets_months: positiveInt().default(36),
  audit_months: positiveInt().default(60),
  /** Raw webhook bodies after processing. */
  wa_raw_days: positiveInt().default(7),
  analytics_months: positiveInt().default(24),
  /**
   * Not a canon §12 key: `RetentionPolicy.approved_by_owner` of docs/07_openapi.yaml, whose
   * description stores it in `organizations.settings.retention`. Optional, no default.
   */
  approved_by_owner: z.boolean().optional(),
});

const orgOpsSchema = z.strictObject({
  /** Age of the oldest pending outbox event before an `outbox_lag` alert. */
  outbox_lag_alert_s: positiveInt().default(30),
});

const orgAlertsSchema = z.strictObject({
  /** Repeat interval of the supervisor escalation sound. */
  escalation_repeat_s: positiveInt().default(60),
  escalation_max_repeats: positiveInt().default(3),
});

const orgPushSchema = z.strictObject({
  /** Before a `push_failed_repeatedly` alert. */
  max_consecutive_failures: positiveInt().default(3),
});

const orgWaSchema = z.strictObject({
  /** Send ceiling for the number (below the provider limit). */
  global_mps: positiveInt().default(60),
  /** Per-recipient message bucket. */
  pair_bucket_capacity: positiveInt().default(6),
  /** Per-recipient bucket refill. */
  pair_refill_s: positiveInt().default(6),
  /** Wait for `delivered` of the previous message of the same ticket. */
  ordering_gate_max_wait_s: positiveInt().default(8),
  send_max_attempts: positiveInt().default(5),
  /** Throttle of the W-09 status reply. */
  status_reply_throttle_s: positiveInt().default(20),
  /** Throttle of the W-10 guidance reply. */
  guidance_reply_throttle_min: positiveInt().default(10),
  /** Validity of the «طلب السيارة» button token from creation. */
  action_token_ttl_h: positiveInt().default(72),
});

/** `organizations.settings` — keys and defaults of canon §12, in canon order. */
export const orgSettingsSchema = z.strictObject({
  security: orgSecuritySchema.prefault({}),
  heartbeat: orgHeartbeatSchema.prefault({}),
  retention: orgRetentionSchema.prefault({}),
  ops: orgOpsSchema.prefault({}),
  alerts: orgAlertsSchema.prefault({}),
  push: orgPushSchema.prefault({}),
  wa: orgWaSchema.prefault({}),
});
/** Organization settings after parsing (every canon key present). */
export type OrgSettings = z.output<typeof orgSettingsSchema>;
/** Organization settings as stored (any key may be missing). */
export type OrgSettingsInput = z.input<typeof orgSettingsSchema>;

/**
 * Body of `PUT /v1/admin/org-settings` (`OrgSettings` in docs/07_openapi.yaml): only `security.*`
 * (without `pin_length`) and `heartbeat.*`, all keys required (DEC-39). `updated_at` is accepted
 * as echoed from `GET` and ignored by the handler.
 */
export const orgSettingsEditableSchema = z.strictObject({
  security: z.strictObject(orgSecurityEditableShape),
  heartbeat: z.strictObject(orgHeartbeatShape).superRefine(heartbeatOrder),
  updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type OrgSettingsEditable = z.output<typeof orgSettingsEditableSchema>;

// ---------------------------------------------------------------------------------------------
// Parsing, defaults and dotted-key access
// ---------------------------------------------------------------------------------------------

/** Parses `venues.settings` (`null`/`undefined` → `{}`), completing defaults. Throws a ZodError. */
export function parseVenueSettings(raw: unknown): VenueSettings {
  return venueSettingsSchema.parse(raw ?? {});
}

/** Parses `organizations.settings` (`null`/`undefined` → `{}`), completing defaults. Throws a ZodError. */
export function parseOrgSettings(raw: unknown): OrgSettings {
  return orgSettingsSchema.parse(raw ?? {});
}

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Canon §12 venue defaults (= `venueSettingsSchema.parse({})`), deeply frozen. */
export const VENUE_SETTINGS_DEFAULTS: DeepReadonly<VenueSettings> = deepFreeze(venueSettingsSchema.parse({}));

/** Canon §12 organization defaults (= `orgSettingsSchema.parse({})`), deeply frozen. */
export const ORG_SETTINGS_DEFAULTS: DeepReadonly<OrgSettings> = deepFreeze(orgSettingsSchema.parse({}));

type Leaf = string | number | boolean | null | undefined | readonly unknown[];

/** Dotted leaf keys of a settings object, e.g. `'dispatch.single_offer_ttl_s'`. */
export type DottedKey<T> = {
  [K in keyof T & string]: T[K] extends Leaf ? K : `${K}.${DottedKey<T[K]>}`;
}[keyof T & string];

/** Value type at a dotted key. */
export type DottedValue<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? DottedValue<T[Head], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never;

export type VenueSettingKey = DottedKey<VenueSettings>;
export type OrgSettingKey = DottedKey<OrgSettings>;

/** Reads a setting by its canon dotted key: `getSetting(settings, 'dispatch.single_offer_ttl_s')`. */
export function getSetting<T extends object, K extends DottedKey<T>>(settings: T, key: K): DottedValue<T, K> {
  let current: unknown = settings;
  for (const part of key.split('.')) {
    current = (current as Record<string, unknown> | undefined)?.[part];
  }
  return current as DottedValue<T, K>;
}

/** Flattens nested settings to canon dotted keys (arrays are leaves; `undefined` values are skipped). */
export function flattenSettings(settings: object, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenSettings(value, dotted));
    } else {
      out[dotted] = value;
    }
  }
  return out;
}

/** Every canon §12 venue key, in canon order. */
export const VENUE_SETTING_KEYS = Object.keys(
  flattenSettings(VENUE_SETTINGS_DEFAULTS),
) as readonly VenueSettingKey[];

/** Every canon §12 organization key, in canon order. */
export const ORG_SETTING_KEYS = Object.keys(
  flattenSettings(ORG_SETTINGS_DEFAULTS),
) as readonly OrgSettingKey[];
