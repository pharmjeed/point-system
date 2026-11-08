import { randomUUID } from 'node:crypto';
import { metrics } from '@point/server';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_IDS, createTestApp, type SeedUserKey, type TestApp } from './harness.js';
import { ORIGIN } from './test-env.js';

const U = SEED_IDS.users;
const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const POOL_R = SEED_IDS.pools['POOL-R'];
const EVT = SEED_IDS.events['EVT-R1'];

interface Row {
  name: string;
  occurred_at: Date;
  received_at: Date;
  org_id: string;
  venue_id: string | null;
  event_id: string | null;
  dispatch_pool_id: string | null;
  actor_role: string | null;
  actor_id: string | null;
  ticket_id: string | null;
  task_id: string | null;
  app_version: string | null;
  properties: Record<string, unknown>;
}

const REASONS = [
  'invalid_event',
  'unknown_name',
  'denied_property',
  'invalid_properties',
  'pii_value',
  'out_of_window',
  'unknown_reference',
  'offer_already_seen',
] as const;

async function rejectedCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of (await metrics.analyticsRejected.get()).values)
    if (v.labels.source === 'client') out[String(v.labels.reason)] = v.value;
  return Object.fromEntries(REASONS.map((r) => [r, out[r] ?? 0]));
}

const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(REASONS.map((r) => [r, (b[r] ?? 0) - (a[r] ?? 0)]).filter(([, n]) => n !== 0));

/**
 * PNT-090 — `POST /v1/telemetry` (15 §9) through the real route: the allow-list per event, the batch
 * bounds, the session enrichment, the per-device rate and the offer sighting dedupe (15 §9.4).
 */
describe('POST /v1/telemetry (telemetry.write)', () => {
  let t: TestApp;
  const devices: Record<string, string> = {};
  let displayNumber = 5000;

  beforeAll(async () => {
    t = await createTestApp();
    const owned: [string, string, boolean][] = [
      ['DRV1', U.DRV1, false],
      ['DRV1b', U.DRV1, false],
      ['DRV1c', U.DRV1, false],
      ['DRV1d', U.DRV1, false],
      ['DRV2', U.DRV2, false],
      ['revoked', U.DRV1, true],
    ];
    for (const [k, user, revoked] of owned) {
      devices[k] = randomUUID();
      await t.db.query(
        `INSERT INTO devices (id, org_id, user_id, platform, display_mode, revoked_at)
         VALUES ($1, $2, $3, 'ios', 'standalone', $4)`,
        [devices[k], ORG, user, revoked ? '2026-10-27T10:00:00Z' : null],
      );
    }
  });
  afterAll(async () => t.close());

  const post = async (as: SeedUserKey | null, body: unknown) => {
    let req = t.http().post('/v1/telemetry').set(CSRF);
    if (as) req = req.set('Cookie', await t.sessionFor(as));
    return req.send(body as object);
  };
  const at = (offsetMs = 0) => new Date(t.clock.now().getTime() + offsetMs).toISOString();
  const ev = (name: string, properties: Record<string, unknown> = {}, occurredAt = at(-1_000)) => ({
    name,
    occurred_at: occurredAt,
    properties,
  });
  const stored = async (sessionId: string) =>
    (
      await t.db.query<Row>(
        `SELECT name, occurred_at, received_at, org_id, venue_id, event_id, dispatch_pool_id, actor_role, actor_id,
                ticket_id, task_id, app_version, properties
           FROM analytics_events WHERE source = 'client' AND properties->>'client_session_id' = $1 ORDER BY id`,
        [sessionId],
      )
    ).rows;
  const count = async (sql: string, params: unknown[] = []) =>
    (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;

  async function openDuty(userId: string, assignmentId: string) {
    const id = randomUUID();
    await t.db.query(
      `INSERT INTO duty_sessions (id, org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status,
                                  connection_state, available_since, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'on_duty', 'online', $8, $8)`,
      [id, ORG, userId, SEED_IDS.shifts['SHF-R'], RMS, POOL_R, assignmentId, '2026-10-27T15:00:00Z'],
    );
    return id;
  }

  /** A parked ticket of EVT-R1 (ck_tickets_parked_holder: the vehicle is held by its spot). */
  async function ticket(): Promise<string> {
    const id = randomUUID();
    await t.db.query(
      `INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, status, channel, created_by,
                            vehicle_holder_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'parked', 'whatsapp', $7, 'spot')`,
      [id, ORG, RMS, EVT, POOL_R, displayNumber++, U['SUP-R']],
    );
    return id;
  }

  /** A retrieve task offered to `userId` (single offer, round 1). */
  async function offerTo(userId: string, dutyId: string) {
    const ticketId = await ticket();
    const cycleId = randomUUID();
    const taskId = randomUUID();
    const offerId = randomUUID();
    const now = t.clock.now().toISOString();
    await t.db.query(
      `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
                                     requested_by_user_id, request_reason)
       VALUES ($1, $2, $3, $4, 1, $5, 'staff', $6, 'test')`,
      [cycleId, ORG, RMS, ticketId, now, U['SUP-R']],
    );
    await t.db.query(
      `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at,
                          queued_at, first_offered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'retrieve', 'offered', $8, $8, $8)`,
      [taskId, ORG, RMS, POOL_R, EVT, ticketId, cycleId, now],
    );
    await t.db.query(
      `INSERT INTO task_offers (id, org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'single', 1, 'active', $5, $5::timestamptz + interval '20 seconds')`,
      [offerId, ORG, taskId, POOL_R, now],
    );
    await t.db.query(
      `INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as, notified_ws_at)
       VALUES ($1, $2, $3, 'accept', $4)`,
      [offerId, userId, dutyId, now],
    );
    return { ticketId, taskId, offerId };
  }

  it('stores a valid batch: 202 without a body, enriched from the session and the open duty, never audited', async () => {
    await openDuty(U.DRV1, SEED_IDS.assignments.DRV1);
    const ticketId = await ticket();
    const auditBefore = await count('audit_log');
    const outboxBefore = await count('outbox_events');
    const r = await post('DRV1', {
      app_version: '1.4.0',
      device_id: devices.DRV1,
      client_session_id: 'cs-valid',
      events: [
        {
          ...ev('app_started', {
            display_mode: 'standalone',
            platform: 'ios',
            browser_family: 'safari',
            browser_major: 17,
          }),
          seq: 1,
          screen: 'D-01',
        },
        {
          ...ev('sync_completed', {
            sync_reason: 'reconnect',
            duration_ms: 420,
            stale_ms: 9000,
            changed: true,
          }),
          seq: 2,
          ticket_id: ticketId,
        },
      ],
    });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');

    const rows = await stored('cs-valid');
    expect(rows.map((x) => x.name)).toEqual(['app_started', 'sync_completed']);
    for (const row of rows) {
      expect(row).toMatchObject({
        org_id: ORG,
        venue_id: RMS,
        dispatch_pool_id: POOL_R,
        actor_role: 'driver',
        actor_id: U.DRV1,
        app_version: '1.4.0',
      });
      expect(row.received_at.toISOString()).toBe(t.clock.now().toISOString());
    }
    expect(rows[0]!.occurred_at.toISOString()).toBe(new Date(t.clock.now().getTime() - 1_000).toISOString());
    expect(rows[0]!.properties).toEqual({
      display_mode: 'standalone',
      platform: 'ios',
      browser_family: 'safari',
      browser_major: 17,
      screen: 'D-01',
      client_seq: 1,
      client_session_id: 'cs-valid',
    });
    expect(rows[1]).toMatchObject({ ticket_id: ticketId, task_id: null });
    expect(rows[1]!.properties).toMatchObject({ sync_reason: 'reconnect', client_seq: 2, changed: true });

    // 09 §3: telemetry is not an audited command, and it emits nothing
    expect(await count('audit_log')).toBe(auditBefore);
    expect(await count('outbox_events')).toBe(outboxBefore);
  });

  it('takes actor and organization from the session only; a supervisor off duty has no venue', async () => {
    const r = await post('SUP-R', {
      app_version: '1.4.0',
      client_session_id: 'cs-supervisor',
      events: [ev('wake_lock_changed', { supported: true, state: 'acquired' })],
    });
    expect(r.status).toBe(202);
    const [row] = await stored('cs-supervisor');
    expect(row).toMatchObject({
      org_id: ORG,
      actor_role: 'supervisor',
      actor_id: U['SUP-R'],
      venue_id: null,
      dispatch_pool_id: null,
    });
  });

  it('drops each event outside the allow-list or the time window, keeps the others and counts the drops', async () => {
    const before = await rejectedCounts();
    const r = await post('DRV1', {
      app_version: '1.4.0',
      device_id: devices.DRV1b,
      client_session_id: 'cs-mixed',
      events: [
        ev('wake_lock_changed', { supported: true, state: 'acquired' }), // kept
        ev('wake_lock_changed', { supported: true, phone: '0551234567' }), // denied_property
        ev('connection_changed', { from: 'online', to: 'offline', plate: '1234' }), // denied_property
        ev('page_hidden_during_duty', { hidden_ms: 10, key_slot_label: 'A-1' }), // denied_property
        ev('sync_completed', { sync_reason: 'manual', code: '482913' }), // denied_property
        ev('made_up_event', {}), // unknown_name
        ev('wake_lock_changed', { supported: 'yes' }), // invalid_properties (type)
        ev('wake_lock_changed', { supported: true, note_text: 'x' }), // invalid_properties (unknown key)
        ev('ui_error_shown', { error_code: 'NOT_A_CODE' }), // invalid_properties (closed list)
        ev('app_update_applied', { from_version: '0551234567', to_version: '1.4.0' }), // pii_value (phone)
        ev('app_update_applied', { from_version: '1.3.9', to_version: '482913' }), // pii_value (6 digits)
        { name: 'wake_lock_changed', properties: {} }, // invalid_event (no occurred_at)
        { ...ev('wake_lock_changed'), org_id: ORG }, // invalid_event (strict)
        { ...ev('wake_lock_changed'), screen: 'X-99' }, // invalid_event (screen list)
        ev('wake_lock_changed', { state: 'released' }, at(-25 * 3_600_000)), // out_of_window (past)
        ev('wake_lock_changed', { state: 'released' }, at(6 * 60_000)), // out_of_window (future)
        ev('wake_lock_changed', { state: 'failed' }, at(4 * 60_000)), // kept: within +5 min
        { ...ev('wake_lock_changed'), ticket_id: randomUUID() }, // unknown_reference
        { ...ev('wake_lock_changed'), task_id: randomUUID() }, // unknown_reference
      ],
    });
    expect(r.status).toBe(202);
    const rows = await stored('cs-mixed');
    expect(rows.map((x) => x.properties)).toEqual([
      { supported: true, state: 'acquired', client_session_id: 'cs-mixed' },
      { state: 'failed', client_session_id: 'cs-mixed' },
    ]);
    expect(delta(before, await rejectedCounts())).toEqual({
      denied_property: 4,
      unknown_name: 1,
      invalid_properties: 3,
      pii_value: 2,
      invalid_event: 3,
      out_of_window: 2,
      unknown_reference: 2,
    });
    const all = JSON.stringify(
      (await t.db.query(`SELECT properties FROM analytics_events WHERE source = 'client'`)).rows,
    );
    expect(all).not.toMatch(/0551234567|482913|"phone"|"plate"|"code"|key_slot|A-1/);
  });

  it('refuses a malformed or oversized batch with VALIDATION_FAILED and stores nothing', async () => {
    const one = ev('wake_lock_changed', { state: 'acquired' });
    const cases: [string, Record<string, unknown>][] = [
      ['51 events', { app_version: '1.4.0', events: Array.from({ length: 51 }, () => one) }],
      ['no events', { app_version: '1.4.0', events: [] }],
      ['no app_version', { events: [one] }],
      ['app_version with spaces', { app_version: '1.4 beta', events: [one] }],
      ['org from the body', { app_version: '1.4.0', org_id: ORG, events: [one] }],
      ['actor from the body', { app_version: '1.4.0', actor_id: U.DRV2, events: [one] }],
      ['device id', { app_version: '1.4.0', device_id: 'abc', events: [one] }],
      ['client session id', { app_version: '1.4.0', client_session_id: 'has space', events: [one] }],
    ];
    const before = await count(`analytics_events WHERE source = 'client'`);
    for (const [label, body] of cases) {
      const r = await post('DRV1', { client_session_id: 'cs-refused', ...body });
      expect(r.status, label).toBe(422);
      expect(r.body.error.code, label).toBe('VALIDATION_FAILED');
    }
    // 15 §9.3: at most 64 KB per request (the JSON parser itself accepts more)
    const big = await post('DRV1', {
      app_version: '1.4.0',
      client_session_id: 'cs-refused',
      events: [{ ...one, properties: { pad: 'x'.repeat(70_000) } }],
    });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('VALIDATION_FAILED');
    expect(big.body.error.details.fields).toEqual([
      expect.objectContaining({ field: '(body)', issue: 'too_large' }),
    ]);
    expect(await count(`analytics_events WHERE source = 'client'`)).toBe(before);
  });

  it('refuses a device that is not the caller’s (another user’s, revoked, unknown) with VALIDATION_FAILED', async () => {
    for (const device of [devices.DRV2, devices.revoked, randomUUID()]) {
      const r = await post('DRV1', {
        app_version: '1.4.0',
        device_id: device,
        client_session_id: 'cs-foreign',
        events: [ev('wake_lock_changed', { state: 'acquired' })],
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      expect(r.body.error.details.fields).toEqual([{ field: 'device_id', issue: 'not_owned' }]);
    }
    expect(await stored('cs-foreign')).toEqual([]);
  });

  it('limits a device to 120 events a minute: RATE_LIMITED with Retry-After, accepted again later', async () => {
    const batch = (n: number) => ({
      app_version: '1.4.0',
      device_id: devices.DRV1c,
      client_session_id: 'cs-rate',
      events: Array.from({ length: n }, () => ev('wake_lock_changed', { state: 'acquired' })),
    });
    expect((await post('DRV1', batch(50))).status).toBe(202);
    t.clock.advance(10_000);
    expect((await post('DRV1', batch(50))).status).toBe(202);
    t.clock.advance(10_000);
    const limited = await post('DRV1', batch(50));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.details).toEqual({ retry_after_s: 40 });
    expect(limited.headers['retry-after']).toBe('40');
    // another device of the same user has its own allowance
    expect((await post('DRV1', { ...batch(50), device_id: devices.DRV1d })).status).toBe(202);
    // a batch of another user naming this device is refused and spends nothing of the owner's allowance
    expect((await post('DRV2', { ...batch(50), device_id: devices.DRV1c })).body.error.code).toBe(
      'VALIDATION_FAILED',
    );
    // the first 50 leave the window at +60 s: 50 + 50 fit again
    t.clock.advance(41_000);
    expect((await post('DRV1', batch(50))).status).toBe(202);
    expect(await stored('cs-rate')).toHaveLength(200);
  });

  it('records an offer sighting once (offer_recipients.seen_at, 15 §9.4) and resolves offer references', async () => {
    const dutyId = (
      await t.db.query<{ id: string }>(
        `SELECT id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
        [U.DRV1],
      )
    ).rows[0]!.id;
    const mine = await offerTo(U.DRV1, dutyId);
    const drv2Duty = await openDuty(U.DRV2, SEED_IDS.assignments.DRV2);
    const theirs = await offerTo(U.DRV2, drv2Duty);
    const seenAt = at(-2_000);
    const seen = (offerId: string, occurredAt = seenAt) =>
      ev(
        'offer_card_seen',
        { offer_id: offerId, mode: 'single', via: 'ws', receive_latency_ms: 180, eligible_as: 'accept' },
        occurredAt,
      );

    const before = await rejectedCounts();
    const r = await post('DRV1', {
      app_version: '1.4.0',
      client_session_id: 'cs-offer',
      events: [
        seen(mine.offerId),
        seen(mine.offerId, at(-1_000)), // the same sighting twice in one batch
        seen(theirs.offerId), // not a recipient
        ev('offer_card_removed', { offer_id: mine.offerId, removal_reason: 'expired', visible_ms: 20_000 }),
        ev('offer_card_removed', { offer_id: randomUUID(), removal_reason: 'expired', visible_ms: 1 }),
      ],
    });
    expect(r.status).toBe(202);
    const rows = await stored('cs-offer');
    expect(rows.map((x) => [x.name, x.task_id, x.ticket_id, x.event_id])).toEqual([
      ['offer_card_seen', mine.taskId, mine.ticketId, EVT],
      ['offer_card_removed', mine.taskId, mine.ticketId, EVT],
    ]);
    expect(rows[0]!.properties).toMatchObject({ offer_id: mine.offerId, via: 'ws', receive_latency_ms: 180 });
    expect(delta(before, await rejectedCounts())).toEqual({ offer_already_seen: 1, unknown_reference: 2 });

    const recipients = (
      await t.db.query<{ user_id: string; seen_at: Date | null }>(
        `SELECT user_id, seen_at FROM offer_recipients WHERE offer_id = ANY($1::uuid[]) ORDER BY user_id`,
        [[mine.offerId, theirs.offerId]],
      )
    ).rows;
    expect(recipients).toEqual([
      { user_id: U.DRV1, seen_at: new Date(seenAt) },
      { user_id: U.DRV2, seen_at: null },
    ]);

    // a later batch (e.g. the outbox of the PWA replayed) does not count the sighting again
    const again = await post('DRV1', {
      app_version: '1.4.0',
      client_session_id: 'cs-offer',
      events: [seen(mine.offerId)],
    });
    expect(again.status).toBe(202);
    expect(await stored('cs-offer')).toHaveLength(2);
  });

  it('records the WebSocket sighting (client.offer_seen) with seen_at in one transaction; the batch then skips it', async () => {
    await t.app.listen(0);
    const addr = t.app.getHttpServer().address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const dutyId = (
      await t.db.query<{ id: string }>(
        `SELECT id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
        [U.DRV1],
      )
    ).rows[0]!.id;
    const offer = await offerTo(U.DRV1, dutyId); // the round is created now
    t.clock.advance(1_500);
    const socket = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor('DRV1') },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      const before = await rejectedCounts();
      const emit = (payload: Record<string, unknown>) =>
        socket.timeout(2000).emitWithAck('client.offer_seen', payload) as Promise<any>;
      expect(await emit({ offer_id: offer.offerId })).toEqual({ data: { ok: true } });
      expect((await emit({ offer_id: offer.offerId, receive_latency_ms: 50 })).data.ok).toBe(true); // again
      expect((await emit({ offer_id: randomUUID() })).data.ok).toBe(true); // not an offer of DRV1

      const rows = (
        await t.db.query<Row>(
          `SELECT name, occurred_at, venue_id, event_id, dispatch_pool_id, actor_role, actor_id, ticket_id, task_id,
                  app_version, properties
             FROM analytics_events WHERE source = 'client' AND name = 'offer_card_seen' AND properties->>'offer_id' = $1`,
          [offer.offerId],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_role: 'driver',
        actor_id: U.DRV1,
        venue_id: RMS,
        dispatch_pool_id: POOL_R,
        event_id: EVT,
        ticket_id: offer.ticketId,
        task_id: offer.taskId,
        app_version: null,
      });
      // mode and eligible_as from the offer; latency = round creation → this message (no client value sent)
      expect(rows[0]!.properties).toEqual({
        offer_id: offer.offerId,
        mode: 'single',
        via: 'ws',
        receive_latency_ms: 1_500,
        eligible_as: 'accept',
      });
      expect(rows[0]!.occurred_at.toISOString()).toBe(t.clock.now().toISOString());
      const recipient = (
        await t.db.query<{ seen_at: Date }>(`SELECT seen_at FROM offer_recipients WHERE offer_id = $1`, [
          offer.offerId,
        ])
      ).rows[0]!;
      expect(recipient.seen_at.toISOString()).toBe(t.clock.now().toISOString());
      expect(delta(before, await rejectedCounts())).toEqual({ offer_already_seen: 1, unknown_reference: 1 });

      // the batch copy (sent while the socket looked down) does not record it a second time
      const batch = await post('DRV1', {
        app_version: '1.4.0',
        client_session_id: 'cs-ws',
        events: [
          ev('offer_card_seen', {
            offer_id: offer.offerId,
            mode: 'single',
            via: 'sync',
            eligible_as: 'accept',
          }),
        ],
      });
      expect(batch.status).toBe(202);
      expect(await stored('cs-ws')).toEqual([]);
    } finally {
      socket.close();
    }
  });

  it('needs a session (AUTH_UNAUTHENTICATED) and the CSRF headers', async () => {
    const body = { app_version: '1.4.0', events: [ev('wake_lock_changed', { state: 'acquired' })] };
    const anonymous = await post(null, body);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    const noCsrf = await t
      .http()
      .post('/v1/telemetry')
      .set('Cookie', await t.sessionFor('DRV1'))
      .send(body);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('PERMISSION_DENIED');
  });
});
