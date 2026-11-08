import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ChannelStatusPayloadSchema,
  IncidentUpdatedPayloadSchema,
  PUSH_BODIES,
  PUSH_CLOSED_VARIANTS,
  PUSH_NOTIFICATION_TYPES,
  PUSH_TTL_S,
  PushPayloadSchema,
  REALTIME_CLIENT_PAYLOAD_SCHEMAS,
  REALTIME_PAYLOAD_SCHEMAS,
  SyncRequiredPayloadSchema,
  TicketSummarySchema,
  TicketUpdatedPayloadSchema,
  escalationBody,
  pushTag,
  pushTitle,
  pushTopic,
  realtimeEnvelopeSchema,
} from '../src/index.js';
import { backticks, readDoc, section, tableRows } from './docs.js';

const doc = readDoc('14_Notification_Matrix_Templates.md');
const TASK = '4f0c2a7e-91d3-4b8a-a1f2-0c6e5d9b3a17';
const OFFER = '9b1e6c2d-3f4a-4e5b-8c7d-2a1b0f9e8d76';

/** The payload example of 14 §6.2 (the documented JSON, brand as configured). */
const example = {
  v: 1,
  kind: 'offer',
  tag: `task:${TASK}`,
  title: 'بوينت — طلب إحضار',
  body: 'تذكرة 125 — افتح التطبيق للقبول',
  ticket_no: 125,
  task_id: TASK,
  offer_id: OFFER,
  url: '/d',
  renotify: true,
  silent: false,
  sent_at: '2026-10-27T19:20:00Z',
  expires_at: '2026-10-27T19:20:30Z',
};

// PNT-072 AC1: the push payload cannot carry a phone, a plate, a key/spot position or a code (DEC-23).
describe('Web Push payload contract (14 §6.2, DEC-23)', () => {
  it('accepts the 14 §6.2 example', () => {
    expect(PushPayloadSchema.parse(example)).toEqual(example);
  });

  it.each([
    ['phone', '+966551234567'],
    ['customer_phone', '+966551234567'],
    ['phone_masked', '05•••••567'],
    ['plate', '1234 ب ح د'],
    ['plate_digits', '1234'],
    ['key_slot', '12'],
    ['key_slot_id', TASK],
    ['current_spot', 'A-07'],
    ['code', '483920'],
    ['claim_code', '483920'],
    ['customer_name', 'x'],
    ['wa_id', '966551234567'],
  ])('rejects any extra field — %s', (key, value) => {
    expect(PushPayloadSchema.safeParse({ ...example, [key]: value }).success).toBe(false);
  });

  it('has no field whose name describes personal or custody data', () => {
    const keys = Object.keys(PushPayloadSchema.shape);
    expect(keys).toEqual([
      'v',
      'kind',
      'tag',
      'title',
      'body',
      'ticket_no',
      'task_id',
      'offer_id',
      'url',
      'renotify',
      'silent',
      'sent_at',
      'expires_at',
    ]);
    for (const k of keys) expect(k).not.toMatch(/phone|plate|key|spot|slot|code|customer|name|wa_/);
  });

  it('only the canon §5.7 kinds, task/alert tags and the two click targets', () => {
    for (const kind of ['test', 'sound', 'offer_reminder'])
      expect(PushPayloadSchema.safeParse({ ...example, kind }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...example, tag: 'ticket:125' }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...example, url: '/tickets/abc' }).success).toBe(false);
    expect(pushTag({ taskId: TASK })).toBe(`task:${TASK}`);
    expect(pushTag({ alertId: OFFER })).toBe(`alert:${OFFER}`);
    expect(pushTopic(TASK)).toBe('4f0c2a7e91d34b8aa1f20c6e5d9b3a17');
    expect(pushTopic(TASK)).toHaveLength(32);
  });
});

describe('Web Push copy equals 14 §6.3', () => {
  const rows = tableRows(section(doc, '### 6.3'));
  const byKind = new Map(rows.map((r) => [backticks(r[0] ?? '')[0], r]));

  it('covers exactly the push kinds', () => {
    expect([...byKind.keys()].sort()).toEqual([...PUSH_NOTIFICATION_TYPES].sort());
  });

  it.each(['offer', 'broadcast', 'reminder', 'next_due'] as const)('%s: title and body', (kind) => {
    const row = byKind.get(kind)!;
    expect(pushTitle(kind, 'بوينت')).toBe(row[1]);
    const n = Number(/تذكرة (\d+)/.exec(row[2] ?? '')?.[1]);
    expect(PUSH_BODIES[kind](n)).toBe(row[2]);
  });

  it('escalation and closed titles; the four quiet replacement texts', () => {
    expect(pushTitle('escalation', 'بوينت')).toBe(byKind.get('escalation')![1]);
    expect(pushTitle('closed', 'بوينت')).toBe(byKind.get('closed')![1]);
    const quoted = [...(byKind.get('closed')![2] ?? '').matchAll(/«([^»]+)»/g)].map((m) => m[1]);
    expect(PUSH_CLOSED_VARIANTS.map((v) => PUSH_BODIES.closed[v](125))).toEqual(quoted);
  });

  it('escalation bodies name the ticket number only (no venue, driver or customer)', () => {
    for (const t of ['no_drivers_on_duty', 'request_unaccepted', 'handover_code_locked']) {
      const body = escalationBody(t, 125);
      expect(body).toContain('125');
      expect(body.replace('125', '')).not.toMatch(/\d/);
    }
    for (const t of ['wa_channel_down', 'outbox_lag', 'wa_webhook_silent', 'anything_else'])
      expect(escalationBody(t, null)).not.toMatch(/\d/);
    expect(escalationBody('no_drivers_on_duty', null)).not.toMatch(/\d/);
  });

  it('TTL header per kind (14 §6.2)', () => {
    const ttlRow = tableRows(section(doc, '### 6.2')).find((r) => r[0] === '`TTL`')![1] ?? '';
    expect(ttlRow).toContain('≤ 30');
    expect(PUSH_TTL_S).toEqual({
      offer: 30,
      broadcast: 60,
      reminder: 60,
      next_due: 300,
      closed: 300,
      escalation: 600,
    });
  });
});

const VENUE = '00000000-0000-4000-8000-000200000001';
const EVENT = '00000000-0000-4000-8000-000700000001';
const summary = {
  id: TASK,
  display_number: 125,
  event_id: EVENT,
  event_name_ar: 'حفل',
  venue_id: VENUE,
  venue_name_ar: 'قاعة',
  status: 'parked',
  channel: 'paper',
  plate: {
    country: 'SA',
    digits: '1234',
    letters_ar: 'ب ح د',
    letters_en: 'B J D',
    raw: null,
    display: '1234 ب ح د',
  },
  vehicle: { make: 'تويوتا', color: 'أبيض' },
  wa_link_status: 'none',
  payment_status: 'not_required',
  requested_at: null,
  created_at: '2026-10-27T16:00:00.000Z',
  version: 4,
};

describe('realtime payload contracts (07 §4.3)', () => {
  it('the client variants drop an unknown top-level key instead of failing the frame (review:8); the server ones stay strict', () => {
    const ok = { ...summary, cause: 'ticket.parked' };
    const later = { ...ok, some_future_field: 'x' };
    expect(TicketUpdatedPayloadSchema.safeParse(later).success).toBe(false);
    expect(REALTIME_CLIENT_PAYLOAD_SCHEMAS['ticket.updated'].parse(later)).toEqual(ok);
    expect(REALTIME_CLIENT_PAYLOAD_SCHEMAS['ticket.updated'].safeParse({ ...ok, version: 0 }).success).toBe(
      false,
    );
    expect(REALTIME_CLIENT_PAYLOAD_SCHEMAS['sync.required'].parse({ reason: 'scope_changed', x: 1 })).toEqual(
      {
        reason: 'scope_changed',
      },
    );
    expect(Object.keys(REALTIME_CLIENT_PAYLOAD_SCHEMAS).sort()).toEqual(
      Object.keys(REALTIME_PAYLOAD_SCHEMAS).sort(),
    );
  });

  it('ticket.updated = TicketSummary + cause; fields outside 09 §5.1 fail', () => {
    expect(TicketSummarySchema.parse(summary)).toEqual(summary);
    const ok = { ...summary, cause: 'ticket.parked' };
    expect(TicketUpdatedPayloadSchema.parse(ok)).toEqual(ok);
    expect(TicketUpdatedPayloadSchema.safeParse(summary).success).toBe(false); // no cause
    expect(TicketUpdatedPayloadSchema.safeParse({ ...ok, cause: 'ticket.unknown' }).success).toBe(false);
    for (const [k, v] of [
      ['customer', { phone_masked: '05•••••567' }],
      ['key_tag', 'K-7'],
      ['current_key_slot', { id: TASK, label: '12' }],
      ['current_spot', { id: TASK, label: 'A-07' }],
      ['paper_serial', 'A-0457'],
      ['claim_code', null],
    ] as const)
      expect(TicketUpdatedPayloadSchema.safeParse({ ...ok, [k]: v }).success, k).toBe(false);
    expect(
      TicketUpdatedPayloadSchema.safeParse({
        ...ok,
        cause: 'wa.message_status_changed',
        message: { id: OFFER, purpose: 'W-01', status: 'delivered', status_rank: 2 },
        wa_link_pending: {
          link_code_id: OFFER,
          inbound_phone_masked: '05•••••567',
          received_at: summary.created_at,
        },
      }).success,
    ).toBe(true);
  });

  it('sync.required, channel.status and incident.updated', () => {
    expect(SyncRequiredPayloadSchema.safeParse({ reason: 'scope_changed' }).success).toBe(true);
    expect(
      SyncRequiredPayloadSchema.safeParse({
        cause: 'event.opened',
        reason: 'event_status_changed',
        scope: 'events',
        event_id: EVENT,
      }).success,
    ).toBe(true);
    expect(SyncRequiredPayloadSchema.safeParse({ reason: 'x', scope: 'everything' }).success).toBe(false);
    expect(
      ChannelStatusPayloadSchema.safeParse({
        cause: 'wa.channel_health_changed',
        whatsapp: 'down',
        changed_at: '2026-10-27T16:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      ChannelStatusPayloadSchema.safeParse({
        cause: 'wa.channel_health_changed',
        whatsapp: 'broken',
        changed_at: 'x',
      }).success,
    ).toBe(false);
    const incident = {
      id: TASK,
      venue_id: VENUE,
      event_id: EVENT,
      ticket_id: null,
      type: 'key_missing',
      status: 'open',
      severity: 'high',
      description: 'مفتاح مفقود',
      opened_by: { id: OFFER, full_name: 'مشرف' },
      owner: null,
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      closed_at: null,
      version: 1,
      created_at: '2026-10-27T16:00:00.000Z',
      updated_at: '2026-10-27T16:00:00.000Z',
      cause: 'incident.opened',
    };
    expect(IncidentUpdatedPayloadSchema.safeParse(incident).success).toBe(true);
    expect(IncidentUpdatedPayloadSchema.safeParse({ ...incident, cause: 'incident.closed' }).success).toBe(
      false,
    );
    expect(Object.keys(REALTIME_PAYLOAD_SCHEMAS).sort()).toEqual(
      ['channel.status', 'incident.updated', 'sync.required', 'ticket.updated'].sort(),
    );
  });

  it('the socket frame of 07 §4.2, with a typed payload', () => {
    const schema = realtimeEnvelopeSchema('ticket.updated', TicketUpdatedPayloadSchema);
    const frame = {
      id: OFFER,
      type: 'ticket.updated',
      occurred_at: '2026-10-29T21:05:19.300Z',
      org_id: '00000000-0000-4000-8000-000100000001',
      venue_id: VENUE,
      dispatch_pool_id: '00000000-0000-4000-8000-000300000001',
      event_id: EVENT,
      aggregate: { type: 'ticket', id: TASK, version: 4 },
      actor: { type: 'system', id: null },
      payload: { ...summary, cause: 'ticket.parked' },
    };
    expect(schema.parse(frame)).toEqual(frame);
    expect(schema.safeParse({ ...frame, type: 'task.updated' }).success).toBe(false);
    expect(schema.safeParse({ ...frame, extra: 1 }).success).toBe(false);
    const channel = realtimeEnvelopeSchema('channel.status', z.any());
    expect(
      channel.safeParse({
        ...frame,
        type: 'channel.status',
        aggregate: { type: 'whatsapp_channel', id: TASK, version: null },
      }).success,
    ).toBe(true);
  });
});
