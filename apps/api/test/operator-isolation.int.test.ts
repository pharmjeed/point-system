import { randomUUID } from 'node:crypto';
import type { SeedUserKey } from '@point/db/seed';
import {
  DRIVE_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROUTES,
  type Permission,
  type RouteDef,
  type Role,
} from '@point/shared';
import { raiseAlert } from '@point/server';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settle } from './customer-harness.js';
import { CSRF, newKey } from './harness.js';
import { ok, rows } from './dispatch-fixtures.js';
import { createOperatorsApp, pressFor, type Operator, type OperatorsApp } from './operators-fixture.js';
import { ORIGIN } from './test-env.js';

/**
 * V2-007 — operator isolation (docs/v2/02 §1, 09 §1 rule 4, 08 §1.3 rule 4; 17 §9.1). Two complete operators share
 * one deployment (operators-fixture.ts). Nothing of operator A may be read or written by any user of operator B:
 *
 * 1. Every route of the registry (`ROUTES`, canon §9) is classified here, so a new route fails this suite until it
 *    is covered: an id in the path, a collection (list or create, with the foreign references a body can carry), a
 *    route that only ever acts on the caller himself, or an explicit exclusion with its reason.
 * 2. Id routes: every role of B calls the route with each of A's ids. The answer is a refusal (never 2xx), one of
 *    the canon non-disclosure codes (404 `TICKET_NOT_FOUND` / `OFFER_NOT_FOUND` / `RESOURCE_NOT_FOUND`; 403
 *    `PERMISSION_DENIED` when the role lacks the permission; 403 `SCOPE_VENUE_DENIED` for a `{venueId}` the caller
 *    named), identical to the answer for an id that does not exist (B learns nothing, not even that the row
 *    exists), and the body carries no identifier of A. A's own roles get 200 on the GET routes (the ids are live).
 * 3. Lists, reports and the caller's own views: no row (no identifier) of A, with or without A's ids as filters.
 * 4. Foreign references in a body (an A spot, slot, user, venue, pool, event, ticket on a B resource): refused.
 * 5. After all of it, every org-scoped row of A is byte-for-byte what it was.
 * 6. Realtime `/ws`: B's sockets never receive a frame of A. WhatsApp: each operator's customer reply is
 *    attributed to its operator. Exports: B's file holds only B.
 */

type Actor = { key: SeedUserKey; role: Role; canDrive: boolean };
/** Operator B's attackers: every role, a two-venue supervisor, a driving supervisor and an on-duty driver. */
const ACTORS: Actor[] = [
  { key: 'OWN1', role: 'owner', canDrive: false },
  { key: 'ADM1', role: 'admin', canDrive: false },
  { key: 'SUP-RL', role: 'supervisor', canDrive: false },
  { key: 'SUP-RD', role: 'supervisor', canDrive: true },
  { key: 'DRV1', role: 'driver', canDrive: false },
];
const has = (a: Actor, p: Permission) =>
  (ROLE_PERMISSIONS[a.role] as readonly string[]).includes(p) ||
  (a.role === 'supervisor' && a.canDrive && (DRIVE_PERMISSIONS as readonly string[]).includes(p));

const NOT_FOUND = ['TICKET_NOT_FOUND', 'OFFER_NOT_FOUND', 'RESOURCE_NOT_FOUND'];
const key = (r: Pick<RouteDef, 'method' | 'path'>) => `${r.method} ${r.path}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Routes outside the operator data plane, with the reason. */
const EXCLUDED: Record<string, string> = {
  'POST /v1/auth/login': 'public, before any session: the credentials decide the operator (no id, no data)',
  'POST /v1/auth/mfa/verify': 'public: completes the caller’s own login with its single-use mfa_token',
  'GET /webhooks/whatsapp': 'Meta handshake (hub.verify_token): no operator data',
  'POST /webhooks/whatsapp':
    'signed Meta delivery: attribution to the right operator is checked by the WhatsApp test below',
  'POST /webhooks/payments/moyasar':
    'the payment gateway’s delivery (shared secret): POINT’s own payments, no operator session or id can be named (V2-021)',
  'GET /health/live': 'no data (liveness)',
  'GET /health/ready': 'no data (readiness)',
  'GET /metrics': 'internal network only, process metrics without operator data',
};

/** Collection routes (no id in the path): how each is covered. */
const COLLECTION: Record<string, 'list' | 'refs' | string> = {
  'GET /v1/me': 'list',
  'GET /v1/me/home': 'list',
  'GET /v1/tickets': 'list',
  'GET /v1/venues': 'list',
  'GET /v1/drivers': 'list',
  'GET /v1/staff': 'list',
  'GET /v1/alerts': 'list',
  'GET /v1/incidents': 'list',
  'GET /v1/reports/drivers': 'list',
  'GET /v1/reports/payments': 'list',
  'GET /v1/reports/messages': 'list',
  'GET /v1/admin/whatsapp/channel': 'list',
  'GET /v1/admin/whatsapp/templates': 'list',
  'GET /v1/admin/outbox': 'list',
  'GET /v1/admin/audit-log': 'list',
  'GET /v1/admin/retention-policy': 'list',
  'GET /v1/admin/org-settings': 'list',
  'POST /v1/tickets': 'refs',
  'POST /v1/cash-handovers': 'refs',
  'POST /v1/drivers': 'refs',
  'POST /v1/staff': 'refs',
  'POST /v1/incidents': 'refs',
  'POST /v1/exports': 'refs',
  // the caller's own session, device, duty or organization: no id and no foreign reference can be named
  'POST /v1/auth/mfa/setup': 'self: the caller’s own TOTP enrolment',
  'POST /v1/auth/mfa/confirm': 'self: the caller’s own TOTP enrolment',
  'POST /v1/auth/secret/change': 'self: the caller’s own secret',
  'POST /v1/auth/logout': 'self: the caller’s own session',
  'POST /v1/me/devices': 'self: registers the caller’s own device (a B device was created by the fixture)',
  'POST /v1/me/audio-test': 'refs',
  'POST /v1/me/duty/start': 'refs',
  'POST /v1/me/duty/break': 'self: the caller’s own duty session',
  'POST /v1/me/duty/end': 'self: the caller’s own duty session',
  'POST /v1/me/heartbeat': 'self: the caller’s own duty session',
  'POST /v1/venues': 'self: creates a venue in the caller’s organization (no foreign reference)',
  'PUT /v1/admin/whatsapp/channel': 'refs',
  'POST /v1/admin/whatsapp/templates/sync': 'self: the caller’s organization templates',
  'PUT /v1/admin/retention-policy': 'self: the caller’s organization settings',
  'PUT /v1/admin/org-settings': 'self: the caller’s organization settings',
  'POST /v1/telemetry': 'refs',
};

describe('V2-007 operator isolation: nothing of operator A is visible or writable from operator B', () => {
  let w: OperatorsApp;
  let A: Operator;
  let B: Operator;
  /** every identifier that belongs to operator A (ids of all its org-scoped rows, its org) */
  let aIds: Set<string>;
  let bIds: Set<string>;
  let orgTables: string[];
  let snapshot: Record<string, string>;

  /** Session cookie of any user id (the harness takes a seed key or, for operator B, the user's id). */
  const cookie = (userId: string) => w.sessionFor(userId as SeedUserKey);

  /** A's ids for each path parameter of the registry. */
  let PARAM: Record<string, (op: Operator) => string[]>;

  beforeAll(async () => {
    w = await createOperatorsApp();
    A = w.A;
    B = w.B;
    orgTables = (
      await rows<{ t: string }>(
        w.db,
        `SELECT c.table_name AS t FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`,
      )
    ).map((r) => r.t);
    // tables keyed by another row's id (e.g. venue_public_profiles by venue_id, V2-001) have no `id` of their own:
    // their keys are already collected from the row they extend
    const withId = new Set(
      (
        await rows<{ t: string }>(
          w.db,
          `SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id'`,
        )
      ).map((r) => r.t),
    );
    const idsOf = async (org: string) => {
      const out = new Set<string>([org]);
      for (const t of orgTables.filter((x) => withId.has(x))) {
        for (const r of await rows<{ id: string }>(
          w.db,
          `SELECT id::text AS id FROM ${t} WHERE org_id = $1`,
          [org],
        ))
          if (/^[0-9a-f-]{36}$/.test(r.id)) out.add(r.id);
      }
      return out;
    };
    aIds = await idsOf(A.org);
    bIds = await idsOf(B.org);
    PARAM = {
      deviceId: (o) => [o.r.device!],
      ticketId: (o) => [
        o.r.ticketDraft!,
        o.r.ticketParking!,
        o.r.ticketParked!,
        o.r.ticketRequested!,
        o.r.ticketReady!,
        o.r.ticketDelivered!,
        o.r.ticketVoided!,
        o.r.ticketWhatsapp!,
      ],
      mediaId: (o) => [o.r.media!],
      taskId: (o) => [o.r.taskPark!, o.r.taskOffered!, o.r.taskRetrieve!],
      cycleId: (o) => [o.r.cycle!],
      offerId: (o) => [o.r.offer!],
      paymentId: (o) => [o.r.payment!],
      eventId: (o) => [o.event, o.feeEvent, o.event2],
      venueId: (o) => [o.venue, o.venue2],
      poolId: (o) => [o.pool],
      zoneId: (o) => [o.zone],
      spotId: (o) => [o.r.spotTaken!, o.spot('A-30')],
      boardId: (o) => [o.board],
      slotId: (o) => [o.r.slotTaken!, o.slot(60)],
      shiftId: (o) => [o.shift],
      driverId: (o) => [o.user('DRV1'), o.user('DRV8')],
      transferId: (o) => [o.r.transfer!],
      sessionId: (o) => [o.r.dutySession!],
      userId: (o) => [o.user('SUP-R'), o.user('ADM1'), o.user('DRV2')],
      alertId: (o) => [o.r.alert!],
      incidentId: (o) => [o.r.incident!],
      exportId: (o) => [o.r.export!],
      outboxId: (o) => [o.r.outbox!],
    };
    // every session the suite uses exists before the snapshot (a session row is written on first use)
    for (const op of [A, B]) for (const a of ACTORS) await cookie(op.user(a.key));
  });
  afterAll(async () => w?.close());

  /**
   * One hash per org-scoped table over every row of the operator. Two kinds of rows are A's own doing during the
   * suite and left out: `auth_sessions` (last_seen_at moves with each request of A's controls) and the `audit.read`
   * rows A's owner and admin write when the mirror check reads A's audit log (09 §12: reading the log is audited).
   */
  async function fingerprint(org: string) {
    const out: Record<string, string> = {};
    for (const t of orgTables) {
      if (t === 'auth_sessions') continue;
      const own = t === 'audit_log' ? `AND NOT (action = 'audit.read' AND actor_id = ANY($2::text[]))` : '';
      const r = await rows<{ h: string }>(
        w.db,
        `SELECT md5(coalesce(string_agg(md5(x::text), ',' ORDER BY md5(x::text)), '')) AS h FROM ${t} x
          WHERE org_id = $1 ${own}`,
        t === 'audit_log' ? [org, [A.user('OWN1'), A.user('ADM1')]] : [org],
      );
      out[t] = r[0]!.h;
    }
    return out;
  }

  /** Bodies a well-formed request carries, with B's own references only: the path id is the only foreign thing. */
  const BODY: Record<string, (b: Operator) => Record<string, unknown>> = {
    'PUT /v1/me/devices/{deviceId}': () => ({
      display_mode: 'standalone',
      notification_permission: 'default',
    }),
    'PATCH /v1/tickets/{ticketId}/intake': () => ({ expected_version: 1, key_tag: 'K-ISO' }),
    'POST /v1/tickets/{ticketId}/media': () => ({
      kind: 'photo_front',
      content_type: 'image/jpeg',
      byte_size: 1000,
    }),
    'POST /v1/tickets/{ticketId}/submit-intake': () => ({ expected_version: 1 }),
    'POST /v1/tickets/{ticketId}/discard-draft': () => ({ expected_version: 1 }),
    'POST /v1/tickets/{ticketId}/void': () => ({
      expected_version: 1,
      reason: 'عزل',
      custody_returned_to_customer: true,
    }),
    'POST /v1/tickets/{ticketId}/inspection-exception': () => ({ reason: 'عزل' }),
    'POST /v1/tickets/{ticketId}/whatsapp-link': () => ({ method: 'direct' }),
    'POST /v1/tickets/{ticketId}/whatsapp-link/confirm': () => ({
      link_code_id: randomUUID(),
      matches: true,
    }),
    'PATCH /v1/tickets/{ticketId}/customer-phone': () => ({
      expected_version: 1,
      customer_phone: '0551234567',
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      reason: 'عزل',
    }),
    'POST /v1/tickets/{ticketId}/reveal-phone': () => ({ reason: 'عزل' }),
    'POST /v1/tasks/{taskId}/complete-parking': (b) => ({
      parking_spot_id: b.spot('A-29'),
      key_slot_id: b.slot(59),
    }),
    'POST /v1/tickets/{ticketId}/retrievals': () => ({ reason: 'عزل' }),
    'POST /v1/retrieval-cycles/{cycleId}/cancel': () => ({ reason: 'عزل' }),
    'POST /v1/tasks/{taskId}/key-pickup': (b) => ({ key_slot_id: b.slot(59) }),
    'POST /v1/tickets/{ticketId}/handover': () => ({
      verification: { method: 'paper_stub', paper_serial: 'X-1' },
    }),
    'POST /v1/tickets/{ticketId}/handover-exception': () => ({
      reason: 'عزل',
      identity_checks: { plate_confirmed: true, vehicle_description_confirmed: true },
    }),
    'POST /v1/tasks/{taskId}/reassign': (b) => ({ target_driver_id: b.user('DRV2'), reason: 'عزل' }),
    'POST /v1/tasks/{taskId}/release-custody': (b) => ({ key_slot_id: b.slot(59), reason: 'عزل' }),
    'POST /v1/tickets/{ticketId}/repark': () => ({ reason: 'عزل' }),
    'POST /v1/tickets/{ticketId}/custody-transfers': (b) => ({
      subject: 'vehicle',
      to_holder_type: 'driver',
      to_holder_id: b.user('DRV2'),
      reason: 'عزل',
    }),
    'POST /v1/tickets/{ticketId}/manual-reconcile': () => ({
      target_status: 'voided',
      reason: 'عزل',
      evidence: { paper_log_ref: 'LOG-1' },
    }),
    'POST /v1/tickets/{ticketId}/payments': () => ({ method: 'cash', amount_halalas: 2000 }),
    'POST /v1/payments/{paymentId}/reverse': () => ({ reason: 'عزل' }),
    'POST /v1/tickets/{ticketId}/payment-waiver': () => ({ reason: 'عزل' }),
    'PATCH /v1/venues/{venueId}': () => ({ expected_version: 1, name_ar: 'عزل' }),
    'PUT /v1/venues/{venueId}/settings': () => ({ expected_version: 1, settings: {} }),
    // V2-004: the venue public profile (O-04)
    'PUT /v1/venues/{venueId}/public-profile': () => ({
      expected_version: 0,
      category: 'mall',
      address: 'عزل',
      city: 'عزل',
      lat: 24.7,
      lng: 46.7,
      opening_hours: { always_open: true, days: {} },
      photo_ids: [],
    }),
    'POST /v1/venues/{venueId}/public-profile/photos': () => ({
      content_type: 'image/jpeg',
      byte_size: 1000,
    }),
    'POST /v1/venues/{venueId}/public-profile/submit': () => ({ expected_version: 1 }),
    'POST /v1/venues/{venueId}/dispatch-pools': () => ({ name: 'عزل' }),
    'PATCH /v1/dispatch-pools/{poolId}': () => ({ name: 'عزل' }),
    'POST /v1/venues/{venueId}/parking-zones': () => ({ name: 'ISO' }),
    'PATCH /v1/parking-zones/{zoneId}': () => ({ name: 'ISO' }),
    'POST /v1/venues/{venueId}/parking-spots': (b) => ({ zone_id: b.zone, labels: ['ISO-1'] }),
    'PATCH /v1/parking-spots/{spotId}': () => ({ status: 'inactive' }),
    'POST /v1/venues/{venueId}/key-boards': () => ({ name: 'عزل' }),
    'POST /v1/key-boards/{boardId}/slots': () => ({ labels: ['999'] }),
    'PATCH /v1/key-slots/{slotId}': () => ({ status: 'inactive' }),
    'POST /v1/venues/{venueId}/events': () => ({
      name_ar: 'عزل',
      event_date: '2026-10-28',
      starts_at: '2026-10-28T15:00:00.000Z',
      pricing_mode: 'included',
    }),
    'PATCH /v1/events/{eventId}': () => ({ expected_version: 1, name_ar: 'عزل' }),
    'POST /v1/events/{eventId}/open': () => ({ expected_version: 1 }),
    'POST /v1/events/{eventId}/start-closing': () => ({ expected_version: 1 }),
    'POST /v1/events/{eventId}/close': () => ({ expected_version: 1 }),
    'POST /v1/events/{eventId}/cancel': () => ({ expected_version: 1, reason: 'عزل' }),
    'POST /v1/venues/{venueId}/shifts': (b) => ({
      name: 'عزل',
      starts_at: '2026-10-28T15:00:00.000Z',
      dispatch_pool_id: b.pool,
    }),
    'POST /v1/shifts/{shiftId}/open': () => ({ expected_version: 1 }),
    'POST /v1/shifts/{shiftId}/close': () => ({ expected_version: 1 }),
    'PATCH /v1/drivers/{driverId}': () => ({ expected_version: 1, full_name: 'عزل' }),
    'POST /v1/drivers/{driverId}/disable': () => ({ reason: 'عزل' }),
    'POST /v1/drivers/{driverId}/assignments': (b) => ({ venue_id: b.venue, reason: 'عزل' }),
    'POST /v1/drivers/{driverId}/transfers': (b) => ({ to_venue_id: b.venue2, reason: 'عزل' }),
    'POST /v1/transfers/{transferId}/cancel': () => ({ reason: 'عزل' }),
    'POST /v1/duty-sessions/{sessionId}/force-end': () => ({ reason: 'عزل' }),
    'PATCH /v1/staff/{userId}': () => ({ expected_version: 1, full_name: 'عزل' }),
    'POST /v1/staff/{userId}/scopes': (b) => ({ grant_venue_ids: [b.venue] }),
    'POST /v1/staff/{userId}/reset-mfa': () => ({ reason: 'عزل' }),
    'POST /v1/alerts/{alertId}/resolve': () => ({ note: 'عزل' }),
    'PATCH /v1/incidents/{incidentId}': () => ({ expected_version: 1, severity: 'low' }),
  };

  async function call(
    r: Pick<RouteDef, 'method' | 'path'>,
    as: string,
    path: string,
    body?: Record<string, unknown>,
  ) {
    const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const agent = w.http();
    let req = agent[m](path).set('Cookie', await cookie(as));
    if (m === 'get') return req;
    req = req.set(CSRF).set('Idempotency-Key', newKey());
    return req.send(body ?? {});
  }

  /**
   * Identifiers of A in a response, other than the ones the caller named himself. B's own `audit.read` rows record
   * the filters B used (09 §12), A's ids among them when B asked for them: those filters are B's own input.
   */
  const leaked = (body: unknown, named: readonly string[] = []) => {
    const data = (body as { data?: unknown })?.data;
    const scanned = Array.isArray(data)
      ? {
          ...(body as object),
          data: data.map((e: any) =>
            e?.action === 'audit.read' ? { ...e, metadata: { ...e.metadata, filters: null } } : e,
          ),
        }
      : body;
    return [...new Set(JSON.stringify(scanned ?? null).match(UUID) ?? [])].filter(
      (x) => aIds.has(x) && !named.includes(x),
    );
  };

  const idRoutes = ROUTES.filter((r) => /\{\w+\}/.test(r.path));
  const fill = (path: string, id: string) => path.replace(/\{\w+\}/, id);
  const paramOf = (path: string) => /\{(\w+)\}/.exec(path)![1]!;

  it('classifies every route of the registry (a new route fails here until it is covered)', () => {
    const problems: string[] = [];
    for (const r of ROUTES) {
      const k = key(r);
      const classes = [k in EXCLUDED, k in COLLECTION, /\{\w+\}/.test(r.path) && !(k in EXCLUDED)].filter(
        Boolean,
      ).length;
      if (classes !== 1) problems.push(`${k}: ${classes === 0 ? 'not classified' : 'classified twice'}`);
      if (
        (r.permission === 'public' || r.permission === 'webhook' || r.permission === 'internal') &&
        !(k in EXCLUDED)
      )
        problems.push(`${k}: ${r.permission} route must be an explicit exclusion`);
      if ((r.path.match(/\{\w+\}/g) ?? []).length > 1) problems.push(`${k}: more than one path id`);
      if (/\{\w+\}/.test(r.path) && !(paramOf(r.path) in PARAM))
        problems.push(`${k}: no operator resource for {${paramOf(r.path)}}`);
    }
    for (const k of [...Object.keys(EXCLUDED), ...Object.keys(COLLECTION)])
      if (!ROUTES.some((r) => key(r) === k)) problems.push(`${k}: not in ROUTES (stale entry)`);
    expect(problems).toEqual([]);
    expect(idRoutes.length).toBeGreaterThanOrEqual(85);
  });

  it('A’s own roles read the GET id routes with these ids (the ids are live)', async () => {
    const failures: string[] = [];
    for (const r of idRoutes.filter((x) => x.method === 'GET')) {
      // an export is readable by its requester only (A's admin asked for it)
      const a =
        paramOf(r.path) === 'exportId' ? ACTORS[1]! : ACTORS.find((x) => has(x, r.permission as Permission))!;
      const statuses: number[] = [];
      for (const id of PARAM[paramOf(r.path)]!(A))
        statuses.push((await call(r, A.user(a.key), fill(r.path, id))).status);
      if (!statuses.includes(200)) failures.push(`${key(r)} as A ${a.key}: ${statuses.join(',')}`);
    }
    expect(failures).toEqual([]);
  });

  it('snapshots every org-scoped row of A', async () => {
    snapshot = await fingerprint(A.org);
    expect(Object.keys(snapshot).length).toBeGreaterThan(40);
  });

  it('id routes: every role of B gets the non-disclosure refusal for every id of A, the same as for no row', async () => {
    const failures: string[] = [];
    const notReached: string[] = [];
    let calls = 0;
    for (const r of idRoutes) {
      const param = paramOf(r.path);
      const body = BODY[key(r)]?.(B);
      for (const a of ACTORS) {
        const as = B.user(a.key);
        const ghost = await call(r, as, fill(r.path, randomUUID()), body);
        for (const id of PARAM[param]!(A)) {
          const res = await call(r, as, fill(r.path, id), body);
          calls++;
          const code = res.body?.error?.code as string | undefined;
          const where = `${key(r)} as B ${a.key} on A ${param} ${id}`;
          if (res.status < 400) {
            failures.push(`${where}: ${res.status} (not refused)`);
            continue;
          }
          const allowed =
            (res.status === 404 && NOT_FOUND.includes(code!)) ||
            (res.status === 403 && code === 'PERMISSION_DENIED') ||
            (res.status === 403 && code === 'SCOPE_VENUE_DENIED' && param === 'venueId');
          if (!allowed)
            notReached.push(
              `${where}: ${res.status} ${code} ${JSON.stringify(res.body?.error?.details ?? {})}`,
            );
          if (ghost.status !== res.status || ghost.body?.error?.code !== code)
            failures.push(
              `${where}: ${res.status} ${code} ≠ unknown id ${ghost.status} ${ghost.body?.error?.code}`,
            );
          const l = leaked(res.body, [id]);
          if (l.length) failures.push(`${where}: A ids in the body ${l.join(',')}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
    expect(notReached).toEqual([]);
  });

  /**
   * The shape of a response with every string and identifier blanked: A and B ran the same day, so a list or a
   * report of B has exactly the shape (lengths, counts, sums, flags) of A's — rows of A mixed into B's answer
   * would show as more rows or larger totals even where no identifier is returned. `VOLATILE` values differ
   * between two identical days for reasons of their own (a global sequence, an elapsed time).
   */
  const VOLATILE = new Set(['seq', 'waiting_seconds']);
  const mirrorShape = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(mirrorShape);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, VOLATILE.has(k) ? '<n>' : mirrorShape((v as Record<string, unknown>)[k])]),
      );
    return typeof v === 'string' ? '<s>' : v;
  };

  const DAY = 'from=2026-10-26T00:00:00Z&to=2026-10-29T00:00:00Z';
  /** Query variants of each list: the operator's own ids (mirror check) and A's ids asked by B (refused or empty). */
  const QUERIES: Record<string, (o: Operator) => string[]> = {
    'GET /v1/tickets': (o) => ['', `?event_id=${o.event}`, `?venue_id=${o.venue}`, `?open_only=true`],
    'GET /v1/drivers': (o) => ['', `?venue_id=${o.venue}`, `?venue_id=${o.venue2}`],
    'GET /v1/staff': () => ['', '?role=supervisor'],
    'GET /v1/alerts': (o) => ['', `?venue_id=${o.venue}`],
    'GET /v1/incidents': (o) => [
      '',
      `?venue_id=${o.venue}`,
      `?event_id=${o.event}`,
      `?ticket_id=${o.r.ticketParked}`,
    ],
    'GET /v1/reports/drivers': (o) => [`?${DAY}`, `?${DAY}&venue_id=${o.venue}`],
    'GET /v1/reports/payments': (o) => [
      `?${DAY}`,
      `?${DAY}&venue_id=${o.venue}`,
      `?${DAY}&event_id=${o.feeEvent}`,
    ],
    'GET /v1/reports/messages': (o) => [`?${DAY}`, `?${DAY}&venue_id=${o.venue}`],
    'GET /v1/admin/audit-log': (o) => [
      '?limit=200',
      `?entity_id=${o.r.ticketParked}`,
      `?actor_id=${o.user('SUP-R')}`,
      `?venue_id=${o.venue}`,
    ],
    'GET /v1/admin/outbox': () => ['?limit=200'],
  };
  /** Lists whose rows differ between the operators for reasons that are not a leak (see the comment of each). */
  const NO_MIRROR = new Set([
    'GET /v1/me', // the operator name and its own ids only (checked for A ids below)
    'GET /v1/admin/audit-log', // B's audit holds the refused attacks of this suite as well
    'GET /v1/admin/outbox', // idem: B's refused commands wrote nothing, but B's later timers differ in number
  ]);

  const LISTS_WITH_ROWS = new Set([
    'GET /v1/me',
    'GET /v1/me/home',
    'GET /v1/tickets',
    'GET /v1/venues',
    'GET /v1/drivers',
    'GET /v1/staff',
    'GET /v1/alerts',
    'GET /v1/incidents',
    'GET /v1/reports/drivers',
    'GET /v1/admin/whatsapp/channel',
    'GET /v1/admin/whatsapp/templates',
    'GET /v1/admin/outbox',
    'GET /v1/admin/audit-log',
  ]);

  it('lists, reports and own views: B never sees a row of A, by id or in a count, with or without A’s ids as filters', async () => {
    const failures: string[] = [];
    let calls = 0;
    for (const r of ROUTES.filter((x) => COLLECTION[key(x)] === 'list')) {
      const variants = QUERIES[key(r)] ?? (() => ['']);
      const own = variants(B);
      const mirror = variants(A);
      for (const a of ACTORS) {
        for (let i = 0; i < own.length; i++) {
          const mine = await call(r, B.user(a.key), r.path + own[i]);
          const theirs = await call(r, A.user(a.key), r.path + mirror[i]);
          const cross = /[0-9a-f]{8}-[0-9a-f]{4}-/.test(mirror[i]!)
            ? await call(r, B.user(a.key), r.path + mirror[i])
            : null;
          calls += cross ? 3 : 2;
          const where = `${key(r)}${own[i]} as B ${a.key}`;
          const l = leaked(mine.body);
          if (l.length) failures.push(`${where}: A ids ${l.join(',')}`);
          if (mine.status !== theirs.status)
            failures.push(`${where}: ${mine.status} but A gets ${theirs.status}`);
          else if (
            !NO_MIRROR.has(key(r)) &&
            JSON.stringify(mirrorShape(mine.body)) !== JSON.stringify(mirrorShape(theirs.body))
          )
            failures.push(
              `${where}: not the mirror of A's answer\n B ${JSON.stringify(mirrorShape(mine.body))}\n A ${JSON.stringify(mirrorShape(theirs.body))}`,
            );
          if (cross) {
            const named = (mirror[i]!.match(UUID) ?? []) as string[];
            const cl = leaked(cross.body, named);
            if (cl.length) failures.push(`${key(r)}${mirror[i]} as B ${a.key}: A ids ${cl.join(',')}`);
            const code = cross.body?.error?.code;
            if (cross.status === 200) {
              const data = cross.body?.data;
              const empty = Array.isArray(data) ? data.length === 0 : true;
              if (Array.isArray(data) && !empty)
                failures.push(`${key(r)}${mirror[i]} as B ${a.key}: ${data.length} rows for A's filter`);
            } else if (!['PERMISSION_DENIED', 'SCOPE_VENUE_DENIED', ...NOT_FOUND].includes(code))
              failures.push(`${key(r)}${mirror[i]} as B ${a.key}: ${cross.status} ${code}`);
          }
        }
      }
      // positive control: a B role holding the permission reads B's own rows through this route
      const reader = ACTORS.find((x) => has(x, r.permission as Permission))!;
      const top = await call(r, B.user(reader.key), r.path + own[0]);
      if (top.status !== 200) failures.push(`${key(r)} as B ${reader.key}: ${top.status}`);
      else if (
        LISTS_WITH_ROWS.has(key(r)) &&
        !(JSON.stringify(top.body).match(UUID) ?? []).some((x) => bIds.has(x))
      )
        failures.push(`${key(r)} as B ${reader.key}: none of B's own rows`);
    }
    expect(calls).toBeGreaterThan(200);
    expect(failures).toEqual([]);
  });

  /**
   * Foreign references in a body: B's own resource in the path (or none), one of A's ids in the body. Each must be
   * refused by the reference check itself (not by the shape of the body), and leave A untouched (checked below).
   */
  it('foreign references in a body (A’s spot, slot, user, venue, pool, zone, event, ticket, device, offer) are refused', async () => {
    const b = B.user;
    const at = '2026-10-28T15:00:00.000Z';
    const cases: [SeedUserKey, 'post' | 'put' | 'patch' | 'get', string, Record<string, unknown>?][] = [
      ['DRV4', 'post', '/v1/tickets', { event_id: A.event }],
      ['DRV4', 'post', '/v1/me/duty/start', { venue_id: A.venue }],
      ['DRV1', 'post', '/v1/me/audio-test', { device_id: A.r.device!, result: 'heard' }],
      [
        'DRV5',
        'post',
        `/v1/tasks/${B.r.taskPark}/complete-parking`,
        { parking_spot_id: A.spot('A-29'), key_slot_id: B.slot(59) },
      ],
      [
        'DRV5',
        'post',
        `/v1/tasks/${B.r.taskPark}/complete-parking`,
        { parking_spot_id: B.spot('A-29'), key_slot_id: A.slot(59) },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tickets/${B.r.ticketReady}/custody-transfers`,
        { subject: 'vehicle', to_holder_type: 'driver', to_holder_id: A.user('DRV2'), reason: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tickets/${B.r.ticketParked}/custody-transfers`,
        { subject: 'vehicle', to_holder_type: 'spot', to_holder_id: A.spot('A-28'), reason: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tickets/${B.r.ticketParked}/custody-transfers`,
        { subject: 'key', to_holder_type: 'key_slot', to_holder_id: A.slot(58), reason: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tasks/${B.r.taskOffered}/reassign`,
        { target_driver_id: A.user('DRV4'), reason: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tasks/${B.r.taskRetrieve}/release-custody`,
        { key_slot_id: A.slot(57), reason: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        `/v1/tickets/${B.r.ticketParked}/manual-reconcile`,
        {
          target_status: 'parked',
          reason: 'عزل',
          evidence: { paper_log_ref: 'LOG-1' },
          parking_spot_id: A.spot('A-27'),
          key_slot_id: B.slot(56),
        },
      ],
      ['SUP-R', 'patch', `/v1/incidents/${B.r.incident}`, { expected_version: 1, owner_id: A.user('SUP-R') }],
      [
        'SUP-R',
        'post',
        '/v1/incidents',
        { venue_id: B.venue, ticket_id: A.r.ticketParked, type: 'other', description: 'عزل' },
      ],
      [
        'SUP-R',
        'post',
        '/v1/incidents',
        { venue_id: B.venue, event_id: A.event, type: 'other', description: 'عزل' },
      ],
      ['SUP-R', 'post', '/v1/incidents', { venue_id: A.venue, type: 'other', description: 'عزل' }],
      ['ADM1', 'post', '/v1/exports', { kind: 'tickets', filters: { event_id: A.event } }],
      ['ADM1', 'post', '/v1/exports', { kind: 'tickets', filters: { venue_id: A.venue } }],
      [
        'SUP-R',
        'post',
        '/v1/cash-handovers',
        { event_id: A.feeEvent, driver_id: b('DRV1'), amount_halalas: 2000 },
      ],
      [
        'SUP-R',
        'post',
        '/v1/cash-handovers',
        { event_id: B.feeEvent, driver_id: A.user('DRV1'), amount_halalas: 2000 },
      ],
      ['ADM1', 'post', `/v1/drivers/${b('DRV7')}/assignments`, { venue_id: A.venue }],
      ['ADM1', 'post', `/v1/drivers/${b('DRV7')}/transfers`, { to_venue_id: A.venue, reason: 'عزل' }],
      ['ADM1', 'post', `/v1/staff/${b('SUP-R')}/scopes`, { grant_venue_ids: [A.venue] }],
      ['ADM1', 'post', '/v1/drivers', { full_name: 'عزل', phone: '0500009991', initial_venue_id: A.venue }],
      [
        'ADM1',
        'post',
        '/v1/staff',
        { full_name: 'عزل', phone: '0500009992', role: 'supervisor', venue_ids: [A.venue] },
      ],
      [
        'ADM1',
        'post',
        `/v1/venues/${B.venue}/events`,
        {
          name_ar: 'عزل',
          event_date: '2026-10-28',
          starts_at: at,
          pricing_mode: 'included',
          dispatch_pool_id: A.pool,
        },
      ],
      ['ADM1', 'post', `/v1/venues/${B.venue}/shifts`, { starts_at: at, dispatch_pool_id: A.pool }],
      ['ADM1', 'post', `/v1/venues/${B.venue}/parking-spots`, { zone_id: A.zone, labels: ['ISO-9'] }],
      ['ADM1', 'patch', `/v1/events/${B.event}`, { expected_version: 1, dispatch_pool_id: A.pool }],
      // a WhatsApp number belongs to one operator: B cannot name A's (DEC-475)
      [
        'OWN1',
        'put',
        '/v1/admin/whatsapp/channel',
        {
          business_account_id: 'SIM-WABA-B',
          phone_number_id: A.phoneNumberId,
          api_version: 'v26.0',
          mode: 'simulator',
          access_token_secret_ref: 'env://WA_ACCESS_TOKEN',
          app_secret_ref: 'env://WA_APP_SECRET',
          verify_token_secret_ref: 'env://WA_VERIFY_TOKEN',
        },
      ],
    ];
    const failures: string[] = [];
    // every collection route classified `refs` has its case here (telemetry: the dropped events below)
    const covered = new Set([...cases.map(([, m, p]) => `${m.toUpperCase()} ${p}`), 'POST /v1/telemetry']);
    for (const k of Object.keys(COLLECTION).filter((x) => COLLECTION[x] === 'refs'))
      if (!covered.has(k)) failures.push(`${k}: no foreign-reference case`);
    for (const [as, method, path, body] of cases) {
      const res = await call(
        { method: method.toUpperCase() as RouteDef['method'], path },
        B.user(as),
        path,
        body,
      );
      const code = res.body?.error?.code;
      const named = (JSON.stringify(body ?? {}).match(UUID) ?? []) as string[];
      const where = `${method.toUpperCase()} ${path} as B ${as} ${JSON.stringify(body)}`;
      if (res.status < 400) failures.push(`${where}: ${res.status} (accepted)`);
      else if (code === 'VALIDATION_FAILED' && !JSON.stringify(res.body.error.details).includes('in_use'))
        failures.push(
          `${where}: ${code} ${JSON.stringify(res.body.error.details)} (the reference was not reached)`,
        );
      const l = leaked(res.body, named);
      if (l.length) failures.push(`${where}: A ids ${l.join(',')}`);
    }
    // B's writes on itself land in B only (A's fingerprint is checked next)
    ok(
      await w.command('post', '/v1/venues', { as: b('OWN1'), body: { code: 'ISO', name_ar: 'قاعة العزل' } }),
      201,
    );
    ok(await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: b('OWN1') }));
    // telemetry naming A's ticket, task and offer is dropped event by event (15 §9.2), never stored for B
    const tel = await call({ method: 'POST', path: '/v1/telemetry' }, b('DRV1'), '/v1/telemetry', {
      app_version: '1.0.0',
      events: [
        {
          name: 'offer_seen',
          occurred_at: w.clock.now().toISOString(),
          ticket_id: A.r.ticketRequested,
          task_id: A.r.taskOffered,
          properties: { offer_id: A.r.offer },
        },
      ],
    });
    expect(tel.status).toBe(202);
    for (const id of [A.r.offer!, A.r.ticketRequested!, A.r.taskOffered!])
      expect(
        await rows(
          w.db,
          `SELECT id FROM analytics_events x WHERE org_id = $1 AND x::text LIKE '%' || $2 || '%'`,
          [B.org, id],
        ),
      ).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('A is unchanged by all of it', async () => {
    expect(await fingerprint(A.org)).toEqual(snapshot);
  });

  it('exports: the file B downloads holds B’s tickets only (the mirror of A’s file)', async () => {
    const plates = async (o: Operator) =>
      (
        await rows<{ p: string }>(
          w.db,
          `SELECT plate_digits AS p FROM tickets WHERE org_id = $1 AND plate_digits IS NOT NULL`,
          [o.org],
        )
      ).map((r) => r.p);
    const file = async (o: Operator) => {
      const x = ok(await w.get(`/v1/exports/${o.r.export}`, o.user('ADM1')));
      expect(x.status).toBe('ready');
      const res = w.storage.download(x.download_url);
      expect(res.status).toBe(200);
      return res.body!.toString('utf8');
    };
    const a = await file(A);
    const bText = await file(B);
    const aPlates = await plates(A);
    const bPlates = await plates(B);
    expect(bPlates.length).toBeGreaterThan(3);
    for (const p of bPlates) expect(bText).toContain(p);
    for (const p of aPlates) expect(bText).not.toContain(p);
    expect([...(bText.match(UUID) ?? [])].filter((x) => aIds.has(x))).toEqual([]);
    expect(bText.split('\r\n').length).toBe(a.split('\r\n').length);
  });

  it('WhatsApp: one Meta app serves both numbers — every delivery is stored and processed for the operator of its number', async () => {
    // the customer (the same phone at both operators) asks for each car from the conversation of its operator
    for (const op of [A, B]) {
      await pressFor(w, op);
      await settle(w, '+966551234567');
    }
    const inbound = await rows<{ org_id: string; raw_body: string; status: string }>(
      w.db,
      `SELECT org_id, raw_body, status FROM whatsapp_inbound_events ORDER BY received_at, id`,
    );
    const misrouted: string[] = [];
    for (const e of inbound) {
      const numbers = new Set<string>();
      for (const entry of JSON.parse(e.raw_body).entry ?? [])
        for (const ch of entry.changes ?? [])
          if (ch.value?.metadata?.phone_number_id) numbers.add(ch.value.metadata.phone_number_id);
      const owner = [A, B].find((o) => numbers.has(o.phoneNumberId));
      if (owner && owner.org !== e.org_id)
        misrouted.push(`${[...numbers].join(',')} stored for ${e.org_id} (${e.status})`);
    }
    expect(inbound.filter((e) => e.org_id === B.org).length).toBeGreaterThan(0);
    expect(misrouted).toEqual([]);
    // each press opened the retrieval of its own operator's car
    for (const op of [A, B])
      expect(
        (await rows(w.db, `SELECT status FROM tickets WHERE id = $1`, [op.r.ticketWhatsapp]))[0],
      ).not.toEqual({
        status: 'parked',
      });
    // and B's messages report counts B's messages with the statuses Meta reported for them (the mirror of A's)
    const report = async (o: Operator) =>
      ok(await w.get(`/v1/reports/messages?${DAY}`, o.user('OWN1'))).totals as Record<string, number>;
    expect(await report(B)).toEqual(await report(A));
  });

  it('realtime /ws: B’s sockets receive B’s frames and never one of A', async () => {
    const sockets: Socket[] = [];
    const frames: { who: string; event: string; msg: any }[] = [];
    const connect = async (op: Operator, k: SeedUserKey) => {
      const s = io(w.apiUrl, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { origin: ORIGIN, cookie: await cookie(op.user(k)) },
      });
      sockets.push(s);
      s.onAny((event: string, msg: unknown) => frames.push({ who: `${op.key} ${k}`, event, msg }));
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('connect_error', reject);
      });
    };
    try {
      for (const op of [A, B])
        for (const k of ['OWN1', 'ADM1', 'SUP-R', 'SUP-RL', 'DRV1', 'DRV2', 'DRV4'] as const)
          await connect(op, k);
      // the same activity at both operators: a retrieval request (offer, ticket and board updates), an alert
      for (const op of [A, B]) {
        ok(
          await w.command('post', `/v1/tickets/${op.r.ticketParked}/retrievals`, {
            as: op.user('SUP-R'),
            body: { reason: 'عزل' },
          }),
          201,
        );
        await w.db.transaction((tx) =>
          raiseAlert(tx, {
            orgId: op.org,
            venueId: op.venue,
            type: 'request_unaccepted',
            dedupeKey: `iso-rt:${op.key}`,
          }),
        );
        await w.drain();
      }
      await new Promise((r) => setTimeout(r, 300));
      const of = (prefix: string) => frames.filter((f) => f.who.startsWith(prefix));
      expect(of('A ').length).toBeGreaterThan(0);
      expect(of('B ').length).toBeGreaterThan(0);
      const foreign = of('B ')
        .filter((f) => f.msg?.org_id !== B.org || leaked(f.msg).length > 0)
        .map((f) => `${f.who} ${f.event} ${JSON.stringify(f.msg).slice(0, 200)}`);
      expect(foreign).toEqual([]);
      // the mirror: each B socket received what its A counterpart received
      const count = (prefix: string) => {
        const m = new Map<string, number>();
        for (const f of of(prefix)) {
          const k = `${f.who.slice(2)} ${f.event}`;
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        return Object.fromEntries([...m].sort());
      };
      expect(count('B ')).toEqual(count('A '));
    } finally {
      for (const s of sockets) s.close();
    }
  });
});
