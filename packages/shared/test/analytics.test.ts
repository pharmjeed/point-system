/**
 * PNT-090: the analytics catalog equals docs/15_Event_Tracking_Plan.md §7 (server) and §8 (client),
 * every domain event of canon §7.1 has exactly one analytics name (15 §15 item 1), and no property
 * schema accepts a key of the §3 denylist (15 §15 item 2, PNT-090 AC1).
 */
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_PII_DENYLIST,
  CLIENT_TELEMETRY_NAMES,
  CLIENT_TELEMETRY_PROPERTIES,
  DOMAIN_EVENT_TYPES,
  SERVER_ANALYTICS_NAMES,
  SERVER_ANALYTICS_PROPERTIES,
  TELEMETRY_LIMITS,
  TelemetryBatchSchema,
  analyticsName,
  clientTelemetrySchema,
  findPiiValues,
  parseTelemetryEvent,
  retentionPolicyEditableSchema,
  serverAnalyticsSchema,
} from '../src/index.js';
import { backticks, readDoc, section, stripParens, tableRows } from './docs.js';

interface DocRow {
  name: string;
  keys: string[];
  enums: Map<string, string[]>;
}

function parseCell(name: string, cell: string): DocRow {
  const keys = backticks(stripParens(cell)).filter((k) => k !== 'null');
  const enums = new Map<string, string[]>();
  for (const m of cell.matchAll(/`([a-z_]+)` enum\(([^)]*)\)/g)) enums.set(m[1]!, m[2]!.split('/'));
  return { name, keys, enums };
}

const plan = readDoc('15_Event_Tracking_Plan.md');
const serverRows = tableRows(section(plan, '## 7.')).map((r) =>
  parseCell(backticks(r[0] ?? '')[0] ?? '', r[1] ?? ''),
);
const clientRows = tableRows(section(plan, '## 8.')).map((r) =>
  parseCell(backticks(r[0] ?? '')[0] ?? '', r[2] ?? ''),
);

const enumValues = (schema: unknown): string[] | null => {
  // unwrap optional/nullable to the inner enum
  let s = schema as { unwrap?: () => unknown; options?: string[]; _zod?: { def?: { type?: string } } };
  for (let i = 0; i < 4 && s && !s.options && s.unwrap; i++) s = s.unwrap() as typeof s;
  return s?.options ?? null;
};

describe('server analytics events (15 §7)', () => {
  it('every canon §7.1 domain event has one analytics name: the type with the dot replaced', () => {
    expect(SERVER_ANALYTICS_NAMES).toHaveLength(DOMAIN_EVENT_TYPES.length);
    expect(new Set(SERVER_ANALYTICS_NAMES).size).toBe(DOMAIN_EVENT_TYPES.length);
    expect(analyticsName('ticket.parked')).toBe('ticket_parked');
    expect(analyticsName('task.broadcast_opened')).toBe('task_broadcast_opened');
    expect(analyticsName('cash.handover_recorded')).toBe('cash_handover_recorded');
    expect(Object.keys(SERVER_ANALYTICS_PROPERTIES).sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });

  it('the catalog of 15 §7 lists exactly these names', () => {
    expect(serverRows).toHaveLength(71);
    expect(serverRows.reduce((n, r) => n + r.enums.size, 0)).toBeGreaterThan(40);
    expect(serverRows.map((r) => r.name).sort()).toEqual([...SERVER_ANALYTICS_NAMES].sort());
  });

  it('property keys and enum values equal the 15 §7 tables', () => {
    const problems: string[] = [];
    for (const type of DOMAIN_EVENT_TYPES) {
      const row = serverRows.find((r) => r.name === analyticsName(type));
      if (!row) {
        problems.push(`${type}: no row in 15 §7`);
        continue;
      }
      const shape = SERVER_ANALYTICS_PROPERTIES[type] as Record<string, unknown>;
      const keys = Object.keys(shape).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...row.keys].sort()))
        problems.push(`${type}: keys ${keys.join(',')} ≠ doc ${row.keys.join(',')}`);
      for (const [key, values] of row.enums) {
        const actual = enumValues(shape[key]);
        if (!actual || JSON.stringify([...actual].sort()) !== JSON.stringify([...values].sort()))
          problems.push(`${type}.${key}: ${actual?.join('/')} ≠ doc ${values.join('/')}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no schema contains a denylisted key and every schema is strict', () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      for (const key of Object.keys(SERVER_ANALYTICS_PROPERTIES[type]))
        expect(ANALYTICS_PII_DENYLIST as readonly string[]).not.toContain(key);
      const schema = serverAnalyticsSchema(type);
      expect(schema.safeParse({}).success).toBe(true);
      for (const denied of ANALYTICS_PII_DENYLIST)
        expect(schema.safeParse({ [denied]: 'x' }).success, `${type} accepts ${denied}`).toBe(false);
    }
  });

  it('values are closed: an out-of-list enum, free text or a fraction is refused', () => {
    const s = serverAnalyticsSchema('ticket.delivered');
    expect(s.safeParse({ verification_method: 'code', cycle_no: 1, ticket_lifetime_s: 3600 }).success).toBe(
      true,
    );
    expect(s.safeParse({ verification_method: 'manual_reconcile' }).success).toBe(false);
    expect(s.safeParse({ cycle_no: 1.5 }).success).toBe(false);
    expect(s.safeParse({ cycle_no: -1 }).success).toBe(false);
    expect(
      serverAnalyticsSchema('cash.handover_recorded').safeParse({ difference_halalas: -500 }).success,
    ).toBe(true);
    expect(
      serverAnalyticsSchema('wa.message_status_changed').safeParse({ error_code: '131026' }).success,
    ).toBe(true);
    expect(serverAnalyticsSchema('wa.message_status_changed').safeParse({ error_code: 'bad' }).success).toBe(
      false,
    );
  });
});

describe('client measurements (15 §8)', () => {
  it('names and properties equal the 15 §8 table and never collide with server names', () => {
    expect(clientRows).toHaveLength(16);
    expect(clientRows.reduce((n, r) => n + r.enums.size, 0)).toBeGreaterThan(20);
    expect(clientRows.map((r) => r.name).sort()).toEqual([...CLIENT_TELEMETRY_NAMES].sort());
    for (const name of CLIENT_TELEMETRY_NAMES) expect(SERVER_ANALYTICS_NAMES).not.toContain(name);
    const problems: string[] = [];
    for (const row of clientRows) {
      const shape = (CLIENT_TELEMETRY_PROPERTIES as Record<string, Record<string, unknown>>)[row.name]!;
      const keys = Object.keys(shape).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...row.keys].sort()))
        problems.push(`${row.name}: keys ${keys.join(',')} ≠ doc ${row.keys.join(',')}`);
      for (const [key, values] of row.enums) {
        const actual = enumValues(shape[key]);
        if (!actual || JSON.stringify([...actual].sort()) !== JSON.stringify([...values].sort()))
          problems.push(`${row.name}.${key}: ${actual?.join('/')} ≠ doc ${values.join('/')}`);
      }
      for (const key of keys) expect(ANALYTICS_PII_DENYLIST as readonly string[]).not.toContain(key);
    }
    expect(problems).toEqual([]);
  });

  const ev = (
    name: string,
    properties: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    name,
    occurred_at: '2026-10-27T17:02:11.120Z',
    properties,
    ...extra,
  });

  it('accepts the 15 §9.1 example', () => {
    const r = parseTelemetryEvent(
      ev(
        'audio_test_completed',
        { result: 'heard', audio_api: 'web_audio', context: 'duty_start' },
        { seq: 41, screen: 'D-03', task_id: null },
      ),
    );
    expect(r.ok).toBe(true);
  });

  it('AC1 allow-list: phones, plates, codes and key positions are refused', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['audio_test_completed', { result: 'heard', phone: '+966551234567' }],
      ['audio_test_completed', { result: 'heard', phone_e164: '+966551234567' }],
      ['app_started', { platform: 'ios', plate_digits: '1234' }],
      ['app_started', { platform: 'ios', plate: 'ABC 1234' }],
      ['offer_card_seen', { offer_id: '0193a7e0-0000-7000-8000-000000000001', code: '123456' }],
      ['offer_card_seen', { offer_id: '0193a7e0-0000-7000-8000-000000000001', claim_code: '123456' }],
      ['sync_completed', { sync_reason: 'manual', key_slot_id: '0193a7e0-0000-7000-8000-000000000002' }],
      ['sync_completed', { sync_reason: 'manual', key_slot_label: 'A-12' }],
      ['sync_completed', { sync_reason: 'manual', parking_spot_id: '0193a7e0-0000-7000-8000-000000000003' }],
      ['sync_completed', { sync_reason: 'manual', spot_note: 'beside the gate' }],
      ['sync_completed', { sync_reason: 'manual', key_tag: '55' }],
      ['ui_error_shown', { error_code: 'VALIDATION_FAILED', reason: 'free text' }],
    ];
    for (const [name, props] of cases) {
      const r = parseTelemetryEvent(ev(name, props));
      expect(r.ok, `${name} ${Object.keys(props).join(',')}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('denied_property');
    }
  });

  it('refuses unknown names, unknown keys, out-of-list values and PII-looking values', () => {
    expect(parseTelemetryEvent(ev('made_up_event')).ok).toBe(false);
    expect(parseTelemetryEvent(ev('made_up_event'))).toMatchObject({ reason: 'unknown_name' });
    expect(parseTelemetryEvent(ev('app_started', { colour: 'blue' }))).toMatchObject({
      reason: 'invalid_properties',
    });
    expect(parseTelemetryEvent(ev('audio_test_completed', { result: 'loud' }))).toMatchObject({
      reason: 'invalid_properties',
    });
    // a phone smuggled into a version field is refused by the pattern, an id by the uuid check
    expect(parseTelemetryEvent(ev('app_update_applied', { from_version: '+966551234567' })).ok).toBe(false);
    expect(parseTelemetryEvent(ev('offer_card_seen', { offer_id: '0551234567' })).ok).toBe(false);
    expect(parseTelemetryEvent(ev('app_update_applied', { from_version: '123456' }))).toMatchObject({
      reason: 'pii_value',
    });
    expect(parseTelemetryEvent({ name: 'app_started' })).toMatchObject({ reason: 'invalid_event' });
    expect(parseTelemetryEvent(ev('app_started', {}, { screen: 'W-05' })).ok).toBe(false);
  });

  it('client schemas are strict', () => {
    for (const name of CLIENT_TELEMETRY_NAMES)
      expect(clientTelemetrySchema(name).safeParse({ extra_key: 1 }).success).toBe(false);
  });
});

describe('telemetry batch and PII scan', () => {
  it('bounds the batch (1…50 events) and refuses unknown top-level keys', () => {
    const one = { name: 'app_started', occurred_at: '2026-10-27T17:02:11.120Z' };
    expect(TelemetryBatchSchema.safeParse({ app_version: '1.0.3', events: [one] }).success).toBe(true);
    expect(TelemetryBatchSchema.safeParse({ app_version: '1.0.3', events: [] }).success).toBe(false);
    expect(
      TelemetryBatchSchema.safeParse({
        app_version: '1.0.3',
        events: Array.from({ length: TELEMETRY_LIMITS.maxEvents + 1 }, () => one),
      }).success,
    ).toBe(false);
    expect(TelemetryBatchSchema.safeParse({ app_version: '1.0.3', events: [one], org_id: 'x' }).success).toBe(
      false,
    );
    expect(TelemetryBatchSchema.safeParse({ events: [one] }).success).toBe(false);
  });

  it('finds phones, six-digit codes and Arabic text but not provider error codes', () => {
    expect(findPiiValues({ a: '+966551234567', b: { c: '0551234567' } })).toEqual(['a', 'b.c']);
    expect(findPiiValues({ x: '123456' })).toEqual(['x']);
    expect(findPiiValues({ error_code: '131026' })).toEqual([]);
    expect(findPiiValues({ note: 'خدش' })).toEqual(['note']);
    expect(findPiiValues({ n: 123456, ok: 'web_audio' })).toEqual([]);
  });
});

describe('retention policy body (PUT /v1/admin/retention-policy)', () => {
  const ok = {
    photos_days: 90,
    wa_messages_days: 180,
    tickets_months: 36,
    audit_months: 60,
    wa_raw_days: 7,
    analytics_months: 24,
  };
  it('requires the six keys, ≥ 1 and within 100 years, strict', () => {
    expect(retentionPolicyEditableSchema.safeParse(ok).success).toBe(true);
    expect(retentionPolicyEditableSchema.safeParse({ ...ok, photos_days: 0 }).success).toBe(false);
    expect(retentionPolicyEditableSchema.safeParse({ ...ok, audit_months: 1201 }).success).toBe(false);
    expect(retentionPolicyEditableSchema.safeParse({ ...ok, wa_raw_days: 36_501 }).success).toBe(false);
    expect(retentionPolicyEditableSchema.safeParse({ ...ok, approved_by_owner: true }).success).toBe(false);
    const { photos_days: _omit, ...missing } = ok;
    expect(retentionPolicyEditableSchema.safeParse(missing).success).toBe(false);
  });
});
