/**
 * V2-015 / V2-016 in the app (node): the client and the fake backend for C-12/C-16/C-13 and the push registration,
 * the C-12/C-16 view models, the push routing and permission rules, and the customer socket client on a fake
 * Socket.IO (DEC-516 … DEC-520).
 */
import {
  CustomerVisitDetailSchema,
  type CustomerVisitDetail,
  type CustomerVisitUpdated,
} from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { FAKE_VISIT_STEPS_MS } from '../src/api/fake/visits';
import { pushRoute, pushSettingState, shouldOfferPush } from '../src/features/push';
import { codeSecondsLeft, helpLink, paymentLine, visitRow, visitView } from '../src/features/visit';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { fakeVisitEvents, socketVisitEvents } from '../src/realtime/visitEvents';
import { onboard, setup } from './helpers';

const DEMO = '+966500000099';
const DEMO_TICKET = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';

async function demo() {
  const ctx = setup({ demoVisitPhones: [DEMO] });
  await onboard(ctx, DEMO);
  return ctx;
}

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, code: e.code, details: e.details };
    throw e;
  }
  throw new Error('expected a rejection');
};

describe('V2-015 — the visit through the client and the fake backend', () => {
  it('C-16 lists the visit; C-12 shows it parked with «اطلب السيارة»; home opens it', async () => {
    const ctx = await demo();
    const page = await ctx.api.visits();
    expect(page.items.map((v) => v.ticket_id)).toEqual([DEMO_TICKET]);
    const v = await ctx.api.visit(DEMO_TICKET);
    expect(CustomerVisitDetailSchema.parse(v)).toBeTruthy();
    expect(v).toMatchObject({
      status: 'parked',
      request: { can_request: true },
      handover: { method: 'app_code' },
    });
    expect((await ctx.api.home()).current_visit?.ticket_id).toBe(DEMO_TICKET);
    expect(await rejects(ctx.api.visit('00000000-0000-4000-8000-000000000000'))).toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('request: requested once (the same key replays, another key is already active), then moves along the clock', async () => {
    const ctx = await demo();
    const events: CustomerVisitUpdated[] = [];
    ctx.backend.visits.subscribe((await ctx.api.me()).id, (e) => void events.push(e));
    const r = await ctx.api.requestVisit(DEMO_TICKET, 'req-key-1');
    expect(r.outcome).toBe('requested');
    expect(r.visit.status).toBe('requested');
    expect((await ctx.api.requestVisit(DEMO_TICKET, 'req-key-1')).outcome).toBe('requested');
    expect(await rejects(ctx.api.requestVisit(DEMO_TICKET, 'req-key-2'))).toMatchObject({
      status: 409,
      code: 'RETRIEVAL_ALREADY_ACTIVE',
    });
    expect(events.map((e) => e.status)).toEqual(['requested']);
    // not ready: no code
    expect(await rejects(ctx.api.handoverCode(DEMO_TICKET))).toMatchObject({ code: 'HANDOVER_NOT_READY' });
    ctx.clock.advance(FAKE_VISIT_STEPS_MS.ready);
    ctx.backend.visits.tick();
    expect(events.map((e) => e.status)).toEqual(['requested', 'ready']);
    const ready = await ctx.api.visit(DEMO_TICKET);
    expect(ready.handover.code_available).toBe(true);
    const code = await ctx.api.handoverCode(DEMO_TICKET);
    expect(code.code).toMatch(/^[0-9]{6}$/);
    // rating: only after the delivery, once
    expect(await rejects(ctx.api.rateVisit(DEMO_TICKET, { stars: 5 }))).toMatchObject({
      code: 'CUSTOMER_VISIT_NOT_DELIVERED',
    });
    ctx.backend.visits.deliver(DEMO_TICKET);
    expect((await ctx.api.visit(DEMO_TICKET)).can_rate).toBe(true);
    expect(await ctx.api.rateVisit(DEMO_TICKET, { stars: 4, note: '  ممتاز ' })).toMatchObject({
      stars: 4,
      note: 'ممتاز',
    });
    expect(await rejects(ctx.api.rateVisit(DEMO_TICKET, { stars: 3 }))).toMatchObject({
      code: 'CUSTOMER_VISIT_ALREADY_RATED',
    });
    expect(await rejects(ctx.api.requestVisit(DEMO_TICKET))).toMatchObject({ code: 'TICKET_CLOSED' });
    expect((await ctx.api.visits()).items[0]).toMatchObject({ rated: true, open: false });
  });

  it('early request while parking (DEC-13): recorded, converted when parked', async () => {
    const ctx = await demo();
    const accountId = (await ctx.api.me()).id;
    const now = ctx.clock.now();
    ctx.backend.visits.add({
      ticketId: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      accountId,
      venue: await ctx.api.location((await ctx.api.home()).nearby_locations[0]!.venue_id),
      status: 'parking',
      plate: null,
      vehicleMake: null,
      vehicleColor: null,
      receivedAt: now + 1,
      parkedAt: null,
      parksAt: now + 60_000,
      requestedAt: null,
      acceptedAt: null,
      startedAt: null,
      readyAt: null,
      deliveredAt: null,
    });
    const r = await ctx.api.requestVisit('9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(r).toMatchObject({ outcome: 'requested_early', visit: { request: { pending_early: true } } });
    ctx.clock.advance(60_000);
    expect((await ctx.api.visit('9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).status).toBe('requested');
  });

  it('push registration: the token is never echoed; sign-out drops it', async () => {
    const ctx = await demo();
    const token = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
    const d = await ctx.api.registerDevice({ provider: 'expo', push_token: token });
    expect(d).toMatchObject({ push_registered: true, provider: 'expo' });
    expect(JSON.stringify(d)).not.toContain(token);
    expect(ctx.backend.pushTokens()).toEqual([token]);
    expect(await ctx.api.registerDevice({ provider: 'expo', push_token: null })).toMatchObject({
      push_registered: false,
    });
    await ctx.api.registerDevice({ provider: 'expo', push_token: token });
    await ctx.api.logout();
    expect(ctx.backend.pushTokens()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const base: CustomerVisitDetail = {
  ticket_id: DEMO_TICKET,
  venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a01',
  venue_name_ar: 'برج الأعمال',
  venue_name_en: 'Business Tower',
  operator_name_ar: 'ركن',
  operator_name_en: 'Rukn',
  status: 'parked',
  open: true,
  channel: 'app',
  plate_display: '1234 ب ح د',
  received_at: '2026-11-07T09:00:00.000Z',
  delivered_at: null,
  duration_min: null,
  payment: {
    entitlement: 'none',
    payment_status: 'due',
    fee_halalas: 2000,
    payable_in_app: true,
    online_payment: null,
  },
  rated: false,
  timeline: [
    { step: 'received', at: '2026-11-07T09:00:00.000Z' },
    { step: 'parked', at: '2026-11-07T09:05:00.000Z' },
    { step: 'requested', at: null },
    { step: 'accepted', at: null },
    { step: 'on_the_way', at: null },
    { step: 'ready', at: null },
    { step: 'delivered', at: null },
  ],
  request: { can_request: true, pending_early: false, requested_at: null },
  handover: { method: 'app_code', code_available: false, code_expires_at: null },
  photos: [],
  rating: null,
  can_rate: false,
  vehicle_make: 'toyota',
  vehicle_color: 'white',
};

describe('C-12 / C-16 view models', () => {
  it('parked: received and parked done, the request offered, the fee due at handover (Riyadh times)', () => {
    const v = visitView(base, ar, 'ar');
    expect(v.steps.map((s) => [s.step, s.state])).toEqual([
      ['received', 'done'],
      ['parked', 'done'],
    ]);
    expect(v.steps[0]!.time).toContain('12:00');
    expect(v).toMatchObject({ canRequest: true, showCode: false, waiting: null, vehicle: 'تويوتا · أبيض' });
    expect(v.payment).toContain('20.00');
    expect(visitView(base, en, 'en')).toMatchObject({
      venue: 'Business Tower',
      operator: 'Operated by Rukn',
    });
  });

  it('on the way, ready with the code, a WhatsApp visit without it, delivered with the rating', () => {
    const moving: CustomerVisitDetail = {
      ...base,
      status: 'retrieving',
      request: { can_request: false, pending_early: false, requested_at: '2026-11-07T10:00:00.000Z' },
      timeline: base.timeline.map((s) =>
        s.step === 'requested' || s.step === 'accepted' || s.step === 'on_the_way'
          ? { ...s, at: '2026-11-07T10:00:00.000Z' }
          : s,
      ),
    };
    const v = visitView(moving, ar, 'ar');
    expect(v.steps.map((s) => [s.step, s.state])).toEqual([
      ['received', 'done'],
      ['parked', 'done'],
      ['requested', 'done'],
      ['accepted', 'done'],
      ['on_the_way', 'done'],
      ['ready', 'current'],
    ]);
    expect(v.waiting).toBe(ar.visit.waiting.onTheWay);
    const ready = {
      ...moving,
      status: 'ready' as const,
      handover: { ...moving.handover, code_available: true },
    };
    expect(visitView(ready, ar, 'ar')).toMatchObject({ showCode: true, handoverNote: null });
    const wa = {
      ...ready,
      channel: 'whatsapp' as const,
      handover: { method: 'whatsapp' as const, code_available: false, code_expires_at: null },
    };
    expect(visitView(wa, ar, 'ar').handoverNote).toBe(ar.visit.code.whatsapp);
    const done = { ...base, status: 'delivered' as const, open: false, can_rate: true };
    expect(visitView(done, ar, 'ar')).toMatchObject({ canRate: true, canRequest: true });
  });

  it('payment lines, the visits row, the code countdown and the help link', () => {
    expect(
      paymentLine(
        {
          entitlement: 'event_included',
          payment_status: 'not_required',
          fee_halalas: 0,
          payable_in_app: false,
          online_payment: null,
        },
        ar,
      ),
    ).toBe(ar.visit.payment.included);
    expect(
      paymentLine(
        {
          entitlement: 'none',
          payment_status: 'not_required',
          fee_halalas: 0,
          payable_in_app: false,
          online_payment: null,
        },
        ar,
      ),
    ).toBeNull();
    const row = visitRow(
      {
        ...base,
        status: 'delivered',
        open: false,
        duration_min: 95,
        delivered_at: '2026-11-07T10:35:00.000Z',
        rated: true,
      },
      ar,
      'ar',
    );
    expect(row.facts.join(' ')).toContain('95');
    expect(row.facts).toContain(ar.visits.rated);
    expect(row.subtitle).toContain('7/11/2026');
    expect(codeSecondsLeft('2026-11-07T10:00:30.000Z', Date.parse('2026-11-07T10:00:00.000Z'))).toBe(30);
    expect(codeSecondsLeft('2026-11-07T10:00:00.000Z', Date.parse('2026-11-07T10:01:00.000Z'))).toBe(0);
    expect(helpLink(null, ar)).toBeNull();
    expect(helpLink('966500000000', ar)).toMatch(/^https:\/\/wa\.me\/966500000000\?text=/);
  });
});

describe('V2-016 — push routing and the permission moment', () => {
  it('a tapped notification opens C-12 of its visit; anything else is ignored', () => {
    expect(pushRoute({ type: 'visit', kind: 'car_ready', visit_id: DEMO_TICKET })).toEqual({
      pathname: '/visit/[ticketId]',
      params: { ticketId: DEMO_TICKET },
    });
    expect(pushRoute({ type: 'visit', kind: 'car_ready', visit_id: 'x' })).toBeNull();
    expect(pushRoute({ url: 'https://evil.example' })).toBeNull();
    expect(pushRoute(null)).toBeNull();
  });

  it('asked once on C-12 with a visit open, never at launch; C-19 shows the state', () => {
    const s = { available: true, permission: 'undetermined' as const, offered: false, visitOpen: true };
    expect(shouldOfferPush(s)).toBe(true);
    expect(shouldOfferPush({ ...s, offered: true })).toBe(false);
    expect(shouldOfferPush({ ...s, visitOpen: false })).toBe(false);
    expect(shouldOfferPush({ ...s, permission: 'granted' })).toBe(false);
    expect(shouldOfferPush({ ...s, available: false })).toBe(false);
    expect(pushSettingState({ available: false, permission: 'granted', registered: true })).toBe(
      'unavailable',
    );
    expect(pushSettingState({ available: true, permission: 'denied', registered: false })).toBe('blocked');
    expect(pushSettingState({ available: true, permission: 'granted', registered: true })).toBe('on');
    expect(pushSettingState({ available: true, permission: 'granted', registered: false })).toBe('off');
  });
});

// ---------------------------------------------------------------------------------------------

/** A Socket.IO stand-in: records the handshake options and lets the test fire server events. */
function fakeIo() {
  const sockets: Array<{
    url: string;
    opts: Record<string, any>;
    handlers: Map<string, (x?: unknown) => void>;
    closed: boolean;
  }> = [];
  const io = ((url: string, opts: Record<string, any>) => {
    const s = { url, opts, handlers: new Map<string, (x?: unknown) => void>(), closed: false };
    sockets.push(s);
    return {
      on(ev: string, fn: (x?: unknown) => void) {
        s.handlers.set(ev, fn);
        return this;
      },
      removeAllListeners() {
        s.handlers.clear();
      },
      close() {
        s.closed = true;
      },
    };
  }) as any;
  return { io, sockets };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('V2-015 — the customer socket client', () => {
  it('connects to /customer with the Bearer token, reads again on connect, forwards visit.updated, reconnects with a fresh token', async () => {
    const { io, sockets } = fakeIo();
    let n = 0;
    const timers: Array<() => void> = [];
    const events = socketVisitEvents({
      baseUrl: 'https://api.example/',
      accessToken: async () => `pca.token-${++n}`,
      io,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    const seen: CustomerVisitUpdated[] = [];
    let resyncs = 0;
    const off = events.subscribe({ onVisit: (e) => void seen.push(e), onResync: () => void resyncs++ });
    await flush();
    expect(sockets[0]).toMatchObject({
      url: 'https://api.example/customer',
      opts: { path: '/ws', transports: ['websocket'], extraHeaders: { Authorization: 'Bearer pca.token-1' } },
    });
    sockets[0]!.handlers.get('connect')!();
    expect(resyncs).toBe(1);
    sockets[0]!.handlers.get('visit.updated')!({
      id: 'e1',
      type: 'visit.updated',
      occurred_at: '2026-11-07T09:00:00.000Z',
      payload: { ticket_id: DEMO_TICKET, status: 'ready', open: true },
    });
    // a malformed frame is ignored
    sockets[0]!.handlers.get('visit.updated')!({ payload: { ticket_id: 'x' } });
    expect(seen).toEqual([{ ticket_id: DEMO_TICKET, status: 'ready', open: true }]);
    // the connection drops: a new handshake with a fresh token after the backoff
    sockets[0]!.handlers.get('disconnect')!();
    expect(timers).toHaveLength(1);
    timers[0]!();
    await flush();
    expect(sockets[1]!.opts.extraHeaders).toEqual({ Authorization: 'Bearer pca.token-2' });
    // the server ends the session: no more reconnection
    sockets[1]!.handlers.get('session.revoked')!();
    expect(sockets[1]!.closed).toBe(true);
    off();
  });

  it('fake mode: the backend’s events of the signed-in account', async () => {
    const ctx = await demo();
    const events = fakeVisitEvents({
      subscribe: ctx.backend.visits.subscribeByToken,
      tick: ctx.backend.visits.tick,
      accessToken: () => ctx.api.accessToken(),
      intervalMs: 60_000,
    });
    const seen: string[] = [];
    const off = events.subscribe({ onVisit: (e) => void seen.push(e.status) });
    await flush();
    await ctx.api.requestVisit(DEMO_TICKET);
    expect(seen).toEqual(['requested']);
    off();
  });
});
