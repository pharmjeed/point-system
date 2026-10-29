import type { OrgSettings, RetentionPolicy } from '@/api/types';
import { s13, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { toLatinDigits } from '@/lib/digits';

/**
 * S-13 settings forms (PNT-091): organization settings (`security.*` without `pin_length`, `heartbeat.*`;
 * DEC-39, DEC-66) and the retention policy, with the bounds of 07 `OrgSettings` / `RetentionPolicy` and
 * @point/shared (`RETENTION_POLICY_LIMITS`) and the rule `interval_s < uncertain_after_s < offline_after_s`
 * (DEC-65) checked inline before sending. The server checks again; its VALIDATION_FAILED `details.fields`
 * (dotted paths such as `heartbeat.uncertain_after_s`) land on the same inputs.
 */

export type SecurityKey = Exclude<keyof OrgSettings['security'], 'supervisor_mfa_required'>;
export type HeartbeatKey = keyof OrgSettings['heartbeat'];

export const SECURITY_BOUNDS: Record<SecurityKey, { min: number; max?: number }> = {
  driver_session_hours: { min: 1 },
  staff_session_hours: { min: 1 },
  max_login_attempts: { min: 3 },
  admin_idle_minutes: { min: 5 },
  reveal_phone_per_hour: { min: 1 },
};

export const HEARTBEAT_BOUNDS: Record<HeartbeatKey, { min: number; max?: number }> = {
  interval_s: { min: 5 },
  uncertain_after_s: { min: 10 },
  offline_after_s: { min: 30 },
};

export const SECURITY_KEYS = Object.keys(SECURITY_BOUNDS) as SecurityKey[];
export const HEARTBEAT_KEYS = Object.keys(HEARTBEAT_BOUNDS) as HeartbeatKey[];

/** Form values are the typed strings (any digit script), so a half-typed value is never lost. */
export interface OrgSettingsForm {
  supervisor_mfa_required: boolean;
  security: Record<SecurityKey, string>;
  heartbeat: Record<HeartbeatKey, string>;
}

export const formFromSettings = (s: OrgSettings): OrgSettingsForm => ({
  supervisor_mfa_required: s.security.supervisor_mfa_required,
  security: Object.fromEntries(SECURITY_KEYS.map((k) => [k, String(s.security[k])])) as Record<
    SecurityKey,
    string
  >,
  heartbeat: Object.fromEntries(HEARTBEAT_KEYS.map((k) => [k, String(s.heartbeat[k])])) as Record<
    HeartbeatKey,
    string
  >,
});

/** A whole number from a typed value («١٥» → 15); null when not one. */
export function parseWhole(value: string): number | null {
  const s = toLatinDigits(value).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** The error text of one bounded integer field, or null. */
export function boundError(value: string, bounds: { min: number; max?: number }): string | null {
  const v = parseWhole(value);
  if (v === null) return staff.wholeNumber;
  if (v < bounds.min) return fmt(staff.minValue, { n: bounds.min });
  if (bounds.max != null && v > bounds.max) return fmt(staff.maxValue, { n: bounds.max });
  return null;
}

/** Field errors keyed by the API's dotted path (`security.max_login_attempts`, `heartbeat.interval_s`). */
export function validateOrgSettings(form: OrgSettingsForm): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const k of SECURITY_KEYS) {
    const e = boundError(form.security[k], SECURITY_BOUNDS[k]);
    if (e) errors[`security.${k}`] = e;
  }
  for (const k of HEARTBEAT_KEYS) {
    const e = boundError(form.heartbeat[k], HEARTBEAT_BOUNDS[k]);
    if (e) errors[`heartbeat.${k}`] = e;
  }
  const i = parseWhole(form.heartbeat.interval_s);
  const u = parseWhole(form.heartbeat.uncertain_after_s);
  const o = parseWhole(form.heartbeat.offline_after_s);
  if (i !== null && u !== null && o !== null && !(i < u && u < o)) {
    // same field as the server's refinement (packages/shared settings `heartbeatOrder`)
    errors['heartbeat.uncertain_after_s'] ??= s13.org.heartbeatRule;
    if (!(u < o)) errors['heartbeat.offline_after_s'] ??= s13.org.heartbeatRule;
    if (!(i < u)) errors['heartbeat.interval_s'] ??= s13.org.heartbeatRule;
  }
  return errors;
}

/** The PUT body (07 `OrgSettings`): every editable key, numbers, no `pin_length`. */
export function orgSettingsBody(form: OrgSettingsForm): OrgSettings {
  const num = (v: string) => parseWhole(v) ?? 0;
  return {
    security: {
      supervisor_mfa_required: form.supervisor_mfa_required,
      driver_session_hours: num(form.security.driver_session_hours),
      staff_session_hours: num(form.security.staff_session_hours),
      max_login_attempts: num(form.security.max_login_attempts),
      admin_idle_minutes: num(form.security.admin_idle_minutes),
      reveal_phone_per_hour: num(form.security.reveal_phone_per_hour),
    },
    heartbeat: {
      interval_s: num(form.heartbeat.interval_s),
      uncertain_after_s: num(form.heartbeat.uncertain_after_s),
      offline_after_s: num(form.heartbeat.offline_after_s),
    },
  };
}

// ---------------------------------------------------------------- retention policy

export type RetentionKey = Exclude<keyof RetentionPolicy, 'approved_by_owner' | 'updated_at'>;

/** 100 years at most (@point/shared `RETENTION_POLICY_LIMITS`: 36 500 days, 1 200 months). */
export const RETENTION_BOUNDS: Record<RetentionKey, { min: number; max: number }> = {
  photos_days: { min: 1, max: 36_500 },
  wa_messages_days: { min: 1, max: 36_500 },
  tickets_months: { min: 1, max: 1_200 },
  audit_months: { min: 1, max: 1_200 },
  wa_raw_days: { min: 1, max: 36_500 },
  analytics_months: { min: 1, max: 1_200 },
};

export const RETENTION_KEYS = Object.keys(RETENTION_BOUNDS) as RetentionKey[];

export function validateRetention(form: Record<RetentionKey, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const k of RETENTION_KEYS) {
    const e = boundError(form[k], RETENTION_BOUNDS[k]);
    if (e) errors[k] = e;
  }
  return errors;
}

export const retentionBody = (form: Record<RetentionKey, string>) =>
  Object.fromEntries(RETENTION_KEYS.map((k) => [k, parseWhole(form[k]) ?? 0])) as Record<
    RetentionKey,
    number
  >;
