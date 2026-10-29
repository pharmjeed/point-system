import { readFileSync } from 'node:fs';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { DRIVE_PERMISSIONS, ROLE_PERMISSIONS, findRoute, type Permission, type Role } from '@point/shared';
import { collectRoutes } from '@point/server';
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

  const call = async (
    r: (typeof routes)[number],
    o: { as?: SeedUserKey; key?: boolean } = {},
  ): Promise<{ status: number; code: string | undefined }> => {
    const path = r.path.replace(/\{[A-Za-z]+\}/g, DUMMY);
    const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    let req = t.http()[m](path);
    if (o.as) req = req.set('Cookie', await t.sessionFor(o.as));
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
    }
    expect(routes).toHaveLength(130); // the 131 operations of 07 but the internal GET /metrics
    expect(seen.size).toBeGreaterThan(200);
    expect(seen).toContain('GET /webhooks/whatsapp WA_WEBHOOK_VERIFY_FAILED');
    expect(seen).toContain('POST /webhooks/whatsapp WA_WEBHOOK_SIGNATURE_INVALID');
    expect(problems).toEqual([]);
  });

  it('a body over the limit is 413 PAYLOAD_TOO_LARGE with max_bytes on every route that takes one (08 §4.15, DEC-130)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const r of routes) {
      const op = ops.get(`${r.method} ${r.path}`);
      if (!op?.requestBody) continue;
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
    expect(checked).toBe(81);
    expect(problems).toEqual([]);
  });
});
