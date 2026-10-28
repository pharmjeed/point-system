/**
 * PNT-005 AC2: `venueSettingsSchema.parse({})` / `orgSettingsSchema.parse({})` return exactly the
 * defaults of canon §12, read from docs/00_Glossary_Canon.md.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ORG_SETTINGS_DEFAULTS,
  VENUE_SETTINGS_DEFAULTS,
  flattenSettings,
  getSetting,
  orgSettingsEditableSchema,
  orgSettingsSchema,
  parseOrgSettings,
  parseVenueSettings,
  venueSettingsSchema,
} from '../src/index.js';
import type { OrgSettingKey, VenueSettingKey } from '../src/index.js';
import { backticks, readDoc, section, tableRows } from './docs.js';

/** Default cell of §12: a number, a boolean, or a backtick value (JSON array or string). */
function parseDefault(cell: string): unknown {
  const tick = backticks(cell)[0];
  if (tick !== undefined && cell.trimStart().startsWith('`')) {
    return tick.startsWith('[') ? JSON.parse(tick) : tick;
  }
  const m = /^(true|false|\d+)/.exec(cell.trim());
  if (!m?.[1]) throw new Error(`Unparsable default: ${cell}`);
  return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
}

function canonDefaults(): { venue: Record<string, unknown>; org: Record<string, unknown> } {
  const lines = section(readDoc('00_Glossary_Canon.md'), '## 12.');
  const orgStart = lines.findIndex((l) => l.includes('`organizations.settings`'));
  const toMap = (part: string[]) =>
    Object.fromEntries(
      tableRows(part).map((r) => [backticks(r[0] ?? '')[0] ?? '', parseDefault(r[1] ?? '')]),
    );
  return { venue: toMap(lines.slice(0, orgStart)), org: toMap(lines.slice(orgStart)) };
}

/** Dotted keys → nested object (the stored shape). */
function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1] ?? ''] = value;
  }
  return out;
}

const canon = canonDefaults();

describe('AC2 — defaults equal canon §12 exactly', () => {
  it('reads all 21 venue keys and 28 organization keys from the canon', () => {
    expect(Object.keys(canon.venue)).toHaveLength(21);
    expect(Object.keys(canon.org)).toHaveLength(28);
  });

  it('venueSettingsSchema.parse({}) equals the canon venue defaults', () => {
    expect(venueSettingsSchema.parse({})).toStrictEqual(nest(canon.venue));
    expect(flattenSettings(venueSettingsSchema.parse({}))).toStrictEqual(canon.venue);
  });

  it('orgSettingsSchema.parse({}) equals the canon organization defaults', () => {
    expect(orgSettingsSchema.parse({})).toStrictEqual(nest(canon.org));
    expect(flattenSettings(orgSettingsSchema.parse({}))).toStrictEqual(canon.org);
  });

  it('keys come out in canon order', () => {
    expect(Object.keys(flattenSettings(venueSettingsSchema.parse({})))).toEqual(Object.keys(canon.venue));
    expect(Object.keys(flattenSettings(orgSettingsSchema.parse({})))).toEqual(Object.keys(canon.org));
  });

  it('exported defaults and parse helpers agree', () => {
    expect(VENUE_SETTINGS_DEFAULTS).toStrictEqual(venueSettingsSchema.parse({}));
    expect(ORG_SETTINGS_DEFAULTS).toStrictEqual(orgSettingsSchema.parse({}));
    expect(parseVenueSettings(null)).toStrictEqual(VENUE_SETTINGS_DEFAULTS);
    expect(parseOrgSettings(undefined)).toStrictEqual(ORG_SETTINGS_DEFAULTS);
    expect(Object.isFrozen(VENUE_SETTINGS_DEFAULTS.inspection.required_photos)).toBe(true);
  });

  it('every parse returns fresh arrays (defaults are not shared)', () => {
    const a = venueSettingsSchema.parse({});
    a.inspection.required_photos.push('photo_extra');
    expect(venueSettingsSchema.parse({}).inspection.required_photos).toHaveLength(4);
  });
});

describe('venue settings behaviour', () => {
  it('completes a partial stored value from the defaults', () => {
    const s = parseVenueSettings({ dispatch: { single_offer_ttl_s: 45 } });
    expect(s.dispatch.single_offer_ttl_s).toBe(45);
    expect(s.dispatch.single_offer_reminder_s).toBe(15);
    expect(s.handover).toStrictEqual({ code_ttl_min: 30, max_attempts: 5, max_resends: 3 });
  });

  it('rejects unknown keys at every level (strict)', () => {
    expect(venueSettingsSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ dispatch: { single_offer_ttl: 30 } }).success).toBe(false);
    // dotted keys are not the stored shape
    expect(venueSettingsSchema.safeParse({ 'dispatch.single_offer_ttl_s': 30 }).success).toBe(false);
  });

  it('applies the OpenAPI ranges and the reminder ≤ ttl − 5 rule', () => {
    expect(venueSettingsSchema.safeParse({ dispatch: { single_offer_ttl_s: 9 } }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ dispatch: { single_offer_reminder_s: 26 } }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ dispatch: { single_offer_reminder_s: 25 } }).success).toBe(true);
    expect(venueSettingsSchema.safeParse({ handover: { max_attempts: 11 } }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ dispatch: { accept_grace_ms: 1.5 } }).success).toBe(false);
  });

  it('validates enum-valued keys', () => {
    expect(venueSettingsSchema.safeParse({ parking: { mode: 'valet' } }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ inspection: { required_photos: ['photo_top'] } }).success).toBe(
      false,
    );
    expect(
      venueSettingsSchema.safeParse({ inspection: { required_photos: ['photo_front', 'photo_front'] } })
        .success,
    ).toBe(false);
    expect(venueSettingsSchema.safeParse({ pricing: { allowed_methods: ['card'] } }).success).toBe(false);
  });

  it('keeps the pricing defaults valid for new events (ck_events_* of the schema)', () => {
    expect(venueSettingsSchema.safeParse({ pricing: { default_fee_halalas: 2000 } }).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ pricing: { default_mode: 'per_vehicle' } }).success).toBe(false);
    expect(
      venueSettingsSchema.safeParse({ pricing: { default_mode: 'per_vehicle', default_fee_halalas: 2000 } })
        .success,
    ).toBe(true);
  });
});

describe('organization settings behaviour', () => {
  it('fixes security.pin_length at 6 (DEC-09)', () => {
    expect(orgSettingsSchema.safeParse({ security: { pin_length: 4 } }).success).toBe(false);
    expect(orgSettingsSchema.parse({ security: { pin_length: 6 } }).security.pin_length).toBe(6);
  });

  it('requires interval_s < uncertain_after_s < offline_after_s', () => {
    expect(orgSettingsSchema.safeParse({ heartbeat: { interval_s: 50 } }).success).toBe(false);
    expect(orgSettingsSchema.safeParse({ heartbeat: { offline_after_s: 40 } }).success).toBe(false);
  });

  it('accepts retention.approved_by_owner (RetentionPolicy) without adding it by default', () => {
    expect(
      orgSettingsSchema.parse({ retention: { approved_by_owner: true } }).retention.approved_by_owner,
    ).toBe(true);
    expect('approved_by_owner' in orgSettingsSchema.parse({}).retention).toBe(false);
  });

  it('the editable projection accepts only security.* (no pin_length) and heartbeat.*', () => {
    const body = {
      security: {
        supervisor_mfa_required: false,
        driver_session_hours: 14,
        staff_session_hours: 12,
        max_login_attempts: 5,
        admin_idle_minutes: 30,
        reveal_phone_per_hour: 20,
      },
      heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
    };
    expect(orgSettingsEditableSchema.safeParse(body).success).toBe(true);
    expect(
      orgSettingsEditableSchema.safeParse({ ...body, security: { ...body.security, pin_length: 6 } }).success,
    ).toBe(false);
    expect(orgSettingsEditableSchema.safeParse({ ...body, retention: {} }).success).toBe(false);
    expect(orgSettingsEditableSchema.safeParse({ security: body.security }).success).toBe(false);
  });
});

describe('getSetting', () => {
  it('reads by canon dotted key with the right type', () => {
    const venue = parseVenueSettings({});
    const ttl = getSetting(venue, 'dispatch.single_offer_ttl_s');
    expectTypeOf(ttl).toEqualTypeOf<number>();
    expect(ttl).toBe(30);
    const mode = getSetting(venue, 'parking.mode');
    expectTypeOf(mode).toEqualTypeOf<'assigned_spots' | 'free_text' | 'mixed'>();
    expect(mode).toBe('mixed');
    expect(getSetting(parseOrgSettings({}), 'wa.action_token_ttl_h')).toBe(72);
  });

  it('every canon key is a typed dotted key', () => {
    const venueKey: VenueSettingKey = 'inspection.required_photos';
    const orgKey: OrgSettingKey = 'security.pin_length';
    expect(Object.keys(canon.venue)).toContain(venueKey);
    expect(Object.keys(canon.org)).toContain(orgKey);
    for (const key of Object.keys(canon.venue)) {
      expect(getSetting(VENUE_SETTINGS_DEFAULTS, key as VenueSettingKey)).toStrictEqual(canon.venue[key]);
    }
    for (const key of Object.keys(canon.org)) {
      expect(getSetting(ORG_SETTINGS_DEFAULTS, key as OrgSettingKey)).toStrictEqual(canon.org[key]);
    }
  });
});
