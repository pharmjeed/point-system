import { randomUUID } from 'node:crypto';
import { seedKeySlotId, seedSpotId } from '@point/db/seed';
import { createSessionCookie, setSupervisorMfaRequired } from '@point/server/testing';
import { PERMISSION_MATRIX, ROUTES, type Permission, type Role } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, CSRF, SEED_IDS, type TestApp } from './harness.js';

// PNT-018…020: route → permission (canon §10 / 09 §4.5) for every implemented §9.5 route and every role, the
// Idempotency-Key rule (canon §9 ✓), venue scope (SCOPE_VENUE_DENIED) and non-disclosure (404) for id routes.
describe('venues-events routes: permissions, idempotency and scope', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const NOT_IN_SCOPE_OF_THESE_TICKETS = new Set([
    '/v1/events/{eventId}/start-closing',
    '/v1/events/{eventId}/reconciliation',
    '/v1/events/{eventId}/close',
    '/v1/events/{eventId}/operations',
  ]);
  const routes = ROUTES.filter((r) => r.section === '9.5' && !NOT_IN_SCOPE_OF_THESE_TICKETS.has(r.path));

  const params: Record<string, string> = {
    venueId: SEED_IDS.venues.RMS,
    poolId: SEED_IDS.pools['POOL-R'],
    zoneId: SEED_IDS.zones.RMS.A,
    spotId: seedSpotId('A-01'),
    boardId: SEED_IDS.keyBoards.RMS,
    slotId: seedKeySlotId('RMS', 1),
    eventId: SEED_IDS.events['EVT-R1'],
    shiftId: SEED_IDS.shifts['SHF-R'],
  };
  const fill = (path: string, p: Record<string, string> = params) =>
    path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const v = p[name];
      if (!v) throw new Error(`no value for ${name}`);
      return v;
    });
  const actors: Record<Role, string> = { owner: 'OWN1', admin: 'ADM1', supervisor: 'SUP-R', driver: 'DRV1' };

  async function call(
    method: string,
    path: string,
    as: string,
    body: unknown = {},
    key: string | null = 'auto',
  ) {
    if (method === 'GET') return t.get(path, as);
    return t.command(method.toLowerCase() as 'post' | 'put' | 'patch', path, {
      as,
      body,
      ...(key === 'auto' ? {} : { key }),
    });
  }

  it('covers the 29 routes of PNT-018…020', () => {
    expect(routes).toHaveLength(29);
  });

  it('every route answers PERMISSION_DENIED exactly for the roles canon §10 does not grant (positive and negative per route)', async () => {
    const problems: string[] = [];
    for (const route of routes) {
      const permission = route.permission as Permission;
      for (const role of Object.keys(actors) as Role[]) {
        const granted = PERMISSION_MATRIX[permission][role] === 'yes';
        // a strict body with an unknown field: an allowed caller passes the guard and stops at validation
        const r = await call(route.method, fill(route.path), actors[role], { __probe: 1 });
        const denied = r.status === 403 && r.body.error?.code === 'PERMISSION_DENIED';
        if (granted && denied) problems.push(`${route.method} ${route.path}: ${role} denied`);
        if (!granted && !denied) problems.push(`${route.method} ${route.path}: ${role} got ${r.status}`);
        if (!granted && denied && r.body.error.details.permission !== permission) {
          problems.push(
            `${route.method} ${route.path}: details.permission ${r.body.error.details.permission}`,
          );
        }
        if (granted && route.method !== 'GET' && r.status !== 422) {
          problems.push(
            `${route.method} ${route.path}: ${role} expected the probe to fail validation, got ${r.status}`,
          );
        }
        if (granted && route.method === 'GET' && r.status !== 200) {
          problems.push(`${route.method} ${route.path}: ${role} got ${r.status} ${r.body.error?.code}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('venue.layout_read is granted to every role; the driver is limited by scope instead', () => {
    for (const role of Object.keys(actors) as Role[])
      expect(PERMISSION_MATRIX['venue.layout_read'][role]).toBe('yes');
  });

  it('every ✓ route without Idempotency-Key → 428 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const commands = routes.filter((r) => r.method !== 'GET');
    expect(commands.every((r) => r.idempotent)).toBe(true);
    for (const route of commands) {
      const r = await call(route.method, fill(route.path), 'ADM1', {}, null);
      expect({ route: `${route.method} ${route.path}`, status: r.status, code: r.body.error?.code }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 428,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }
  });

  it('unsafe methods without the CSRF headers are PERMISSION_DENIED (reason csrf)', async () => {
    const r = await t
      .http()
      .post('/v1/venues')
      .set('Cookie', await t.sessionFor('ADM1'))
      .set('Idempotency-Key', 'csrf-probe-0001')
      .send({ code: 'CSRF', name_ar: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'csrf' } });
    const ok = await t
      .http()
      .post('/v1/venues')
      .set(CSRF)
      .set('Cookie', await t.sessionFor('ADM1'))
      .set('Idempotency-Key', 'csrf-probe-0002')
      .send({ code: 'CSRF', name_ar: 'x' });
    expect(ok.status).toBe(201);
  });

  it('without a session every route is 401 AUTH_UNAUTHENTICATED', async () => {
    for (const route of routes.slice(0, 6)) {
      const req = t.http()[route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch'](fill(route.path));
      const r = await (route.method === 'GET'
        ? req
        : req.set(CSRF).set('Idempotency-Key', randomUUID()).send({}));
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('AUTH_UNAUTHENTICATED');
    }
  });

  it('session guards apply to these routes: revoked, expired, MFA setup and secret change', async () => {
    const path = `/v1/venues/${SEED_IDS.venues.RMS}`;
    const as = async (cookie: string) => t.http().get(path).set('Cookie', cookie);

    const revoked = await createSessionCookie(t.db, SEED_IDS.users['SUP-RL'], { now: t.clock.now() });
    await t.db.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'admin' WHERE id = $1`, [
      revoked.sessionId,
    ]);
    const r1 = await as(revoked.cookie);
    expect(r1.status).toBe(401);
    expect(r1.body.error).toMatchObject({ code: 'AUTH_SESSION_REVOKED', details: { reason: 'admin' } });

    const expired = await createSessionCookie(t.db, SEED_IDS.users['SUP-RL'], {
      now: new Date(t.clock.now().getTime() - 3 * 3600_000),
      hours: 1,
    });
    expect((await as(expired.cookie)).body.error.code).toBe('AUTH_SESSION_EXPIRED');

    const fresh = await createSessionCookie(t.db, SEED_IDS.users['SUP-RL'], { now: t.clock.now() });
    await setSupervisorMfaRequired(t.db, SEED_IDS.org, true);
    try {
      const r3 = await as(fresh.cookie);
      expect(r3.status).toBe(403);
      expect(r3.body.error.code).toBe('AUTH_MFA_SETUP_REQUIRED');
    } finally {
      await setSupervisorMfaRequired(t.db, SEED_IDS.org, false);
    }
    await t.db.query(`UPDATE users SET must_change_secret = true WHERE id = $1`, [SEED_IDS.users['SUP-RL']]);
    try {
      const r4 = await as(fresh.cookie);
      expect(r4.status).toBe(403);
      expect(r4.body.error.code).toBe('AUTH_SECRET_CHANGE_REQUIRED');
    } finally {
      await t.db.query(`UPDATE users SET must_change_secret = false WHERE id = $1`, [
        SEED_IDS.users['SUP-RL'],
      ]);
    }
    expect((await as(fresh.cookie)).status).toBe(200);
  });

  it('a {venueId} outside the supervisor scope → 403 SCOPE_VENUE_DENIED on every route the supervisor may call', async () => {
    const LYL = SEED_IDS.venues.LYL;
    const valid: Record<string, unknown> = {
      'POST /v1/venues/{venueId}/events': {
        name_ar: 'حفل',
        event_date: '2026-10-30',
        pricing_mode: 'included',
      },
      'POST /v1/venues/{venueId}/shifts': { starts_at: '2026-10-30T15:00:00Z' },
    };
    const venueRoutes = routes.filter(
      (r) =>
        r.path.startsWith('/v1/venues/{venueId}') &&
        PERMISSION_MATRIX[r.permission as Permission].supervisor === 'yes',
    );
    expect(venueRoutes.length).toBe(10);
    for (const route of venueRoutes) {
      const body = valid[`${route.method} ${route.path}`] ?? {};
      const r = await call(route.method, fill(route.path, { venueId: LYL }), 'SUP-R', body);
      expect({ route: route.path, method: route.method, status: r.status, code: r.body.error?.code }).toEqual(
        {
          route: route.path,
          method: route.method,
          status: 403,
          code: 'SCOPE_VENUE_DENIED',
        },
      );
      expect(r.body.error.details).toEqual({ venue_id: LYL });
      const inScope = await call(route.method, fill(route.path, { venueId: LYL }), 'SUP-RL', body);
      expect(inScope.body.error?.code).not.toBe('SCOPE_VENUE_DENIED');
    }
  });

  it('an event or shift of another venue is 404 RESOURCE_NOT_FOUND for the supervisor (non-disclosure)', async () => {
    const event = SEED_IDS.events['EVT-L1'];
    const shift = SEED_IDS.shifts['SHF-L'];
    const cases: [string, string, unknown, string][] = [
      ['GET', `/v1/events/${event}`, undefined, 'event'],
      ['PATCH', `/v1/events/${event}`, { expected_version: 1, name_ar: 'x' }, 'event'],
      ['POST', `/v1/events/${event}/open`, {}, 'event'],
      ['POST', `/v1/events/${event}/cancel`, { reason: 'اختبار النطاق' }, 'event'],
      ['POST', `/v1/shifts/${shift}/open`, {}, 'shift'],
      ['POST', `/v1/shifts/${shift}/close`, {}, 'shift'],
    ];
    for (const [method, path, body, resource] of cases) {
      const r = await call(method, path, 'SUP-R', body);
      expect({ path, status: r.status, error: r.body.error?.code, details: r.body.error?.details }).toEqual({
        path,
        status: 404,
        error: 'RESOURCE_NOT_FOUND',
        details: { resource },
      });
    }
    const state = await t.db.query(`SELECT status, version FROM events WHERE id = $1`, [event]);
    expect(state.rows[0]).toEqual({ status: 'open', version: 1 });
  });

  it('resources of another organization are invisible: 404 with the resource name, never 403', async () => {
    const org = randomUUID();
    const venue = randomUUID();
    const pool = randomUUID();
    const zone = randomUUID();
    const spot = randomUUID();
    const board = randomUUID();
    const slot = randomUUID();
    const event = randomUUID();
    const shift = randomUUID();
    const owner = SEED_IDS.users.OWN1; // FK only
    await t.db.query(`INSERT INTO organizations (id, name_ar) VALUES ($1, 'مؤسسة أخرى')`, [org]);
    await t.db.query(`INSERT INTO venues (id, org_id, code, name_ar) VALUES ($1, $2, 'OTH', 'قاعة أخرى')`, [
      venue,
      org,
    ]);
    await t.db.query(
      `INSERT INTO dispatch_pools (id, org_id, venue_id, name, is_default) VALUES ($1, $2, $3, 'x', true)`,
      [pool, org, venue],
    );
    await t.db.query(`INSERT INTO parking_zones (id, org_id, venue_id, name) VALUES ($1, $2, $3, 'Z')`, [
      zone,
      org,
      venue,
    ]);
    await t.db.query(
      `INSERT INTO parking_spots (id, org_id, venue_id, zone_id, label) VALUES ($1, $2, $3, $4, 'Z-1')`,
      [spot, org, venue, zone],
    );
    await t.db.query(`INSERT INTO key_boards (id, org_id, venue_id, name) VALUES ($1, $2, $3, 'K')`, [
      board,
      org,
      venue,
    ]);
    await t.db.query(
      `INSERT INTO key_slots (id, org_id, venue_id, key_board_id, label) VALUES ($1, $2, $3, $4, '1')`,
      [slot, org, venue, board],
    );
    await t.db.query(
      `INSERT INTO events (id, org_id, venue_id, dispatch_pool_id, name_ar, event_date, created_by)
       VALUES ($1, $2, $3, $4, 'حفل', '2026-10-30', $5)`,
      [event, org, venue, pool, owner],
    );
    await t.db.query(
      `INSERT INTO shifts (id, org_id, venue_id, dispatch_pool_id, starts_at, created_by) VALUES ($1, $2, $3, $4, now(), $5)`,
      [shift, org, venue, pool, owner],
    );

    const cases: [string, string, unknown, string][] = [
      ['GET', `/v1/venues/${venue}`, undefined, 'venue'],
      ['GET', `/v1/venues/${venue}/settings`, undefined, 'venue'],
      ['GET', `/v1/venues/${venue}/parking-spots`, undefined, 'venue'],
      ['PATCH', `/v1/venues/${venue}`, { expected_version: 1, name_ar: 'x' }, 'venue'],
      ['PATCH', `/v1/dispatch-pools/${pool}`, { name: 'y' }, 'dispatch_pool'],
      ['PATCH', `/v1/parking-zones/${zone}`, { name: 'y' }, 'parking_zone'],
      ['PATCH', `/v1/parking-spots/${spot}`, { label: 'y' }, 'parking_spot'],
      ['POST', `/v1/key-boards/${board}/slots`, { labels: ['2'] }, 'key_board'],
      ['PATCH', `/v1/key-slots/${slot}`, { label: 'y' }, 'key_slot'],
      ['GET', `/v1/events/${event}`, undefined, 'event'],
      ['POST', `/v1/events/${event}/open`, {}, 'event'],
      ['POST', `/v1/shifts/${shift}/open`, {}, 'shift'],
    ];
    for (const [method, path, body, resource] of cases) {
      const r = await call(method, path, 'ADM1', body);
      expect({ path, status: r.status, details: r.body.error?.details }).toEqual({
        path,
        status: 404,
        details: { resource },
      });
    }
    const list = await t.get('/v1/venues?limit=200', 'OWN1');
    expect(list.body.data.map((v: { id: string }) => v.id)).not.toContain(venue);
  });
});
