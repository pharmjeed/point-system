import { readFileSync } from 'node:fs';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  DRIVE_PERMISSIONS,
  PLATFORM_ROUTES,
  ROLE_PERMISSIONS,
  findRoute,
  type Permission,
  type Role,
} from '@point/shared';
import { collectRoutes, sha256Hex } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentedCodes,
  openApiOperations,
  type OpenApiOperation,
} from '../../../packages/shared/test/openapi-doc.js';
import { CSRF, createTestApp, newKey, type SeedUserKey, type TestApp } from './harness.js';

const ACTORS: { key: SeedUserKey; role: Role; canDrive: boolean }[] = [
  { key: 'OWN1', role: 'owner', canDrive: false },
  { key: 'ADM1', role: 'admin', canDrive: false },
  { key: 'SUP-R', role: 'supervisor', canDrive: false },
  { key: 'SUP-RD', role: 'supervisor', canDrive: true },
  { key: 'DRV1', role: 'driver', canDrive: false },
];
const holds = (a: (typeof ACTORS)[number], p: string) =>
  (ROLE_PERMISSIONS[a.role] as readonly string[]).includes(p) ||
  (a.role === 'supervisor' &&
    a.canDrive &&
    (DRIVE_PERMISSIONS as readonly string[]).includes(p as Permission));

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';

/**
 * Server sweep (07): every route answers only the errors its docs/07_openapi.yaml operation documents, under the
 * documented status. Each route is called with dummy ids and an empty body — anonymously, without an
 * Idempotency-Key where it is ✓, and as every role holding its permission — and every error envelope is checked
 * against the operation (the codes a route can reach with real data are tested by its module, 08 §10).
 */
describe('served errors ↔ docs/07_openapi.yaml', () => {
  let t: TestApp;
  let routes: ReturnType<typeof collectRoutes>;
  let ops: Map<string, OpenApiOperation>;

  beforeAll(async () => {
    t = await createTestApp();
    // every served route: /v1, /webhooks/whatsapp and /health (/metrics is the internal metrics server)
    routes = collectRoutes(t.app.get(DiscoveryService), t.app.get(MetadataScanner), t.app.get(Reflector));
    const yaml = readFileSync(new URL('../../../docs/07_openapi.yaml', import.meta.url), 'utf8');
    ops = new Map(openApiOperations(yaml).map((o) => [`${o.method} ${o.path}`, o]));
  });
  afterAll(async () => t.close());

  // V2-002: a platform owner session (MFA passed) for the /v1/platform/* routes; staff actors hold none of them
  let platformCookie = '';
  const platformSession = async () => {
    if (platformCookie) return platformCookie;
    const u = await t.db.query<{ id: string }>(
      `INSERT INTO platform_users (phone_e164, full_name, role, secret_hash, must_change_secret, mfa_enabled, mfa_secret_enc)
       VALUES ('+966551119101', 'مالك المنصة', 'platform_owner', 'x', false, true, 'x') RETURNING id`,
    );
    const token = 'openapi-sweep-platform-session-token-0001';
    await t.db.query(
      `INSERT INTO platform_sessions (platform_user_id, token_hash, mfa_verified, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, true, $3, $3, $3::timestamptz + interval '48 hours')`,
      [u.rows[0]!.id, sha256Hex(token), t.clock.now()],
    );
    platformCookie = `${t.env.PLATFORM_SESSION_COOKIE_NAME}=${token}`;
    return platformCookie;
  };

  const call = async (
    r: (typeof routes)[number],
    o: { as?: SeedUserKey | 'PLATFORM'; key?: boolean } = {},
  ): Promise<{ status: number; code: string | undefined }> => {
    const path = r.path.replace(/\{[A-Za-z]+\}/g, DUMMY);
    const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    let req = t.http()[m](path);
    if (o.as === 'PLATFORM') req = req.set('Cookie', await platformSession());
    else if (o.as) req = req.set('Cookie', await t.sessionFor(o.as));
    if (m !== 'get') {
      req = req.set(CSRF);
      if (o.key ?? true) req = req.set('Idempotency-Key', newKey());
    }
    const res = m === 'get' ? await req : await req.send({});
    return { status: res.status, code: res.body?.error?.code };
  };

  it('every error envelope of every route is documented for its operation and status', async () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const check = (
      r: (typeof routes)[number],
      who: string,
      res: { status: number; code: string | undefined },
    ) => {
      if (res.status < 400) return;
      const op = ops.get(`${r.method} ${r.path}`);
      const where = `${r.method} ${r.path} as ${who}: ${res.status} ${res.code}`;
      if (!op) return void problems.push(`${where} — no OpenAPI operation`);
      if (!res.code) return void problems.push(`${where} — no error envelope`);
      seen.add(`${r.method} ${r.path} ${res.code}`);
      if (!documentedCodes(op).has(res.code) || !op.responses.get(res.status)?.includes(res.code))
        problems.push(`${where} — not documented`);
    };
    for (const r of routes) {
      const route = findRoute(r.method as Parameters<typeof findRoute>[0], r.path);
      check(r, 'anonymous', await call(r));
      if (route?.idempotent && !r.public) {
        const a = ACTORS.find((x) => holds(x, r.permission ?? ''));
        if (a) check(r, `${a.key} without a key`, await call(r, { as: a.key, key: false }));
      }
      for (const a of ACTORS.filter((x) => r.public || holds(x, r.permission ?? '')))
        check(r, a.key, await call(r, { as: a.key }));
      if (r.platformPermission) {
        // V2 (DEC-462): a staff session on a platform route, then the platform owner
        check(r, 'OWN1 (staff) on a platform route', await call(r, { as: 'OWN1' }));
        check(r, 'platform owner', await call(r, { as: 'PLATFORM' }));
      }
    }
    // the 131 operations of 07 but the internal GET /metrics, and the platform operations (V2-002, V2-003…)
    expect(routes).toHaveLength(130 + PLATFORM_ROUTES.length);
    expect(seen).toContain('GET /v1/platform/me PLATFORM_AUTH_REQUIRED');
    expect(seen.size).toBeGreaterThan(200);
    expect(seen).toContain('GET /webhooks/whatsapp WA_WEBHOOK_VERIFY_FAILED');
    expect(seen).toContain('POST /webhooks/whatsapp WA_WEBHOOK_SIGNATURE_INVALID');
    expect(problems).toEqual([]);
  });

  it('a body over the limit is 413 PAYLOAD_TOO_LARGE with max_bytes on every route but a GET (08 §4.15, DEC-130)', async () => {
    // the parsers run before any route: a route that takes no body still reads one sent to it
    const problems: string[] = [];
    let checked = 0;
    for (const r of routes) {
      const op = ops.get(`${r.method} ${r.path}`);
      if (r.method === 'GET' || !op) continue;
      const limit = r.path === '/webhooks/whatsapp' ? 3 * 1024 * 1024 : 1024 * 1024; // raw webhook body vs JSON
      const send = t.http()[r.method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete'];
      const res = await send(r.path.replace(/\{[A-Za-z]+\}/g, DUMMY))
        .set(CSRF)
        .set('Idempotency-Key', newKey())
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ pad: 'x'.repeat(limit) }));
      checked++;
      const where = `${r.method} ${r.path}: ${res.status} ${res.body?.error?.code}`;
      if (res.status !== 413 || res.body?.error?.code !== 'PAYLOAD_TOO_LARGE') problems.push(where);
      else if (res.body.error.details?.max_bytes !== limit)
        problems.push(`${where} max_bytes ${res.body.error.details?.max_bytes}`);
      else if (!op.responses.get(413)?.includes('PAYLOAD_TOO_LARGE'))
        problems.push(`${where} — not documented`);
    }
    // the 90 V1 writes (79 with a requestBody, 11 without) and the platform commands
    expect(checked).toBe(90 + PLATFORM_ROUTES.filter((r) => r.method !== 'GET').length);
    expect(problems).toEqual([]);
  });

  it('a body that is not JSON is 422 VALIDATION_FAILED on the field (body) on every JSON route but a GET (08 §4.3, DEC-126)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const r of routes) {
      const op = ops.get(`${r.method} ${r.path}`);
      // the webhook reads its raw body (signature first, 12 §4.1): no JSON parser runs before it
      if (r.method === 'GET' || !op || r.path === '/webhooks/whatsapp') continue;
      const send = t.http()[r.method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete'];
      const res = await send(r.path.replace(/\{[A-Za-z]+\}/g, DUMMY))
        .set(CSRF)
        .set('Idempotency-Key', newKey())
        .set('Content-Type', 'application/json')
        .send('{"phone": ');
      checked++;
      const where = `${r.method} ${r.path}: ${res.status} ${res.body?.error?.code}`;
      if (res.status !== 422 || res.body?.error?.code !== 'VALIDATION_FAILED') problems.push(where);
      else if (
        JSON.stringify(res.body.error.details) !==
        JSON.stringify({ fields: [{ field: '(body)', issue: 'malformed_json' }] })
      )
        problems.push(`${where} details ${JSON.stringify(res.body.error.details)}`);
      else if (!op.responses.get(422)?.includes('VALIDATION_FAILED'))
        problems.push(`${where} — not documented`);
    }
    expect(checked).toBe(89 + PLATFORM_ROUTES.filter((r) => r.method !== 'GET').length); // + the platform commands
    expect(problems).toEqual([]);
  });
});
