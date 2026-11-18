import { CUSTOMER_PUSH_KINDS, CustomerPushDataSchema } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_VISIT_PUSH_KINDS,
  CustomerPushSimulator,
  CustomerPushTransportError,
  customerPushContent,
  customerPushIntents,
  DEVICE_NOT_REGISTERED,
  ExpoPushSender,
} from '../src/modules/customer-accounts/index.js';

/**
 * V2-016 (DEC-519, DEC-520): the customer push rules and the lock-screen payload, and the Expo Push API adapter on a
 * fake fetch (the provider is never reached from tests).
 */
const TICKET = '018f3c1e-7b2a-7c4d-9e1f-0a1b2c3d4e5f';
const brand = { ar: 'علامة العميل', en: 'Customer brand' };
const venue = { ar: 'قاعة الريم', en: 'Al Reem Hall' };

describe('customer push content (docs/v2/01 §3, DEC-23)', () => {
  it('a generic title and body per kind, the venue named in «استلمنا سيارتك» only, opaque data', () => {
    expect(CUSTOMER_VISIT_PUSH_KINDS).toEqual([
      'car_received',
      'request_accepted',
      'car_ready',
      'pickup_reminder',
    ]);
    const ar = CUSTOMER_VISIT_PUSH_KINDS.map((kind) =>
      customerPushContent({ kind, locale: 'ar', ticketId: TICKET, brand, venue }),
    );
    expect(ar.map((c) => c.body)).toEqual([
      'استلمنا سيارتك في قاعة الريم',
      'سائقنا في طريقه إلى سيارتك',
      'سيارتك جاهزة عند البوابة',
      'سيارتك ما زالت بانتظارك',
    ]);
    expect(new Set(ar.map((c) => c.title))).toEqual(new Set([brand.ar]));
    const en = customerPushContent({ kind: 'car_received', locale: 'en', ticketId: TICKET, brand, venue });
    expect(en).toMatchObject({ title: brand.en, body: 'We have your car at Al Reem Hall' });
    expect(
      customerPushContent({
        kind: 'car_received',
        locale: 'en',
        ticketId: TICKET,
        brand,
        venue: { ar: 'قاعة', en: null },
      }).body,
    ).toBe('We have your car at قاعة');
    for (const c of [...ar, en]) {
      expect(Object.keys(c).sort()).toEqual(['body', 'data', 'title']);
      expect(CustomerPushDataSchema.parse(c.data)).toEqual({
        type: 'visit',
        kind: c.data.kind,
        visit_id: TICKET,
      });
      expect(`${c.title} ${c.body}`).not.toMatch(/[0-9]/);
    }
    // a venue name never reaches the other kinds
    for (const c of ar.slice(1)) expect(c.body).not.toContain(venue.ar);
  });

  it('the subscription kinds are reserved: never built before V4', () => {
    for (const kind of CUSTOMER_PUSH_KINDS.filter((k) => !CUSTOMER_VISIT_PUSH_KINDS.includes(k)))
      expect(() => customerPushContent({ kind, locale: 'ar', ticketId: TICKET, brand, venue })).toThrow(
        'reserved',
      );
  });

  it('the push data refuses anything beyond its three opaque keys', () => {
    expect(() =>
      CustomerPushDataSchema.parse({ type: 'visit', kind: 'car_ready', visit_id: TICKET, plate: '1234' }),
    ).toThrow();
  });
});

describe('customer push intents', () => {
  const ticket = { ticket_id: TICKET };
  it('maps the four visit events; nothing else pushes', () => {
    expect(
      customerPushIntents({ type: 'ticket.intake_submitted', payload: { ticket, channel: 'app' } }),
    ).toEqual([{ kind: 'car_received', ticketId: TICKET, ref: TICKET }]);
    expect(
      customerPushIntents({ type: 'ticket.intake_submitted', payload: { ticket, channel: 'whatsapp' } }),
    ).toEqual([]);
    for (const type of ['ticket.assigned', 'ticket.assigned_waiting'])
      expect(customerPushIntents({ type, payload: { ticket, cycle_id: 'c1' } })).toEqual([
        { kind: 'request_accepted', ticketId: TICKET, ref: 'c1' },
      ]);
    expect(customerPushIntents({ type: 'ticket.ready', payload: { ticket, cycle_id: 'c1' } })).toEqual([
      { kind: 'car_ready', ticketId: TICKET, ref: 'c1' },
    ]);
    expect(
      customerPushIntents({
        type: 'alert.raised',
        payload: { type: 'ready_not_collected', ticket_id: TICKET, alert_id: 'a1' },
      }),
    ).toEqual([{ kind: 'pickup_reminder', ticketId: TICKET, ref: 'a1' }]);
    for (const type of [
      'ticket.retrieval_requested',
      'ticket.retrieving',
      'ticket.delivered',
      'handover.code_issued',
    ])
      expect(customerPushIntents({ type, payload: { ticket, cycle_id: 'c1', ticket_id: TICKET } })).toEqual(
        [],
      );
    expect(
      customerPushIntents({
        type: 'alert.raised',
        payload: { type: 'task_stuck', ticket_id: TICKET, alert_id: 'a' },
      }),
    ).toEqual([]);
  });
});

describe('ExpoPushSender (Expo Push API) on a fake fetch', () => {
  const message = {
    to: 'ExponentPushToken[abcdefghijklmnop]',
    title: brand.ar,
    body: 'سيارتك جاهزة عند البوابة',
    data: { type: 'visit' as const, kind: 'car_ready' as const, visit_id: TICKET },
  };
  const fake = (status: number, body: unknown, seen: { url: string; init: RequestInit }[]) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('sends the documented message shape, with the access token only when one is configured', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const s = new ExpoPushSender({
      timeoutMs: 1000,
      accessToken: async () => null,
      fetch: fake(200, { data: [{ status: 'ok', id: 'r-1' }] }, seen),
    });
    expect(await s.send([message])).toEqual([{ status: 'ok', id: 'r-1' }]);
    expect(seen[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual([
      { ...message, sound: 'default', priority: 'high', channelId: 'visits' },
    ]);
    const withToken = new ExpoPushSender({
      timeoutMs: 1000,
      accessToken: async () => 'expo-access',
      fetch: fake(
        200,
        { data: { 'r-1': { status: 'error', details: { error: DEVICE_NOT_REGISTERED } } } },
        seen,
      ),
    });
    expect(await withToken.receipts(['r-1'])).toEqual({
      'r-1': { status: 'error', error: DEVICE_NOT_REGISTERED },
    });
    expect(seen[1]!.url).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect((seen[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer expo-access');
  });

  it('maps an error ticket, and a rate limit or outage to a retryable transport error', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const refused = new ExpoPushSender({
      timeoutMs: 1000,
      accessToken: async () => null,
      fetch: fake(200, { data: [{ status: 'error', details: { error: DEVICE_NOT_REGISTERED } }] }, seen),
    });
    expect(await refused.send([message])).toEqual([{ status: 'error', error: DEVICE_NOT_REGISTERED }]);
    for (const status of [429, 503]) {
      const s = new ExpoPushSender({
        timeoutMs: 1000,
        accessToken: async () => null,
        fetch: fake(status, {}, seen),
      });
      await expect(s.send([message])).rejects.toMatchObject({ retryable: true });
    }
    const bad = new ExpoPushSender({
      timeoutMs: 1000,
      accessToken: async () => null,
      fetch: fake(400, {}, seen),
    });
    await expect(bad.send([message])).rejects.toBeInstanceOf(CustomerPushTransportError);
  });

  it('the simulator records, refuses a dead token and answers receipts', async () => {
    const sim = new CustomerPushSimulator();
    const [t1] = await sim.send([message]);
    expect(t1).toMatchObject({ status: 'ok' });
    sim.unregister(message.to);
    expect(await sim.send([message])).toEqual([{ status: 'error', error: DEVICE_NOT_REGISTERED }]);
    expect(sim.sent).toHaveLength(1);
    expect(await sim.receipts([(t1 as { id: string }).id, 'unknown'])).toEqual({
      [(t1 as { id: string }).id]: { status: 'ok' },
    });
  });
});
