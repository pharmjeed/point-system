import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { DRIVE_PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from '@point/shared';
import { collectRoutes } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, createTestApp, newKey, type SeedUserKey, type TestApp } from './harness.js';

/**
 * PNT-013 AC1 (09 §14.4): for every implemented route, an actor whose role lacks the route's permission gets
 * 403 PERMISSION_DENIED (negative), and an actor holding it never gets PERMISSION_DENIED from the guard
 * (positive; the handler may still answer 404/409/422 for the dummy ids and empty bodies used here).
 * Grows automatically as modules add routes.
 */
const ACTORS: { key: SeedUserKey; role: Role; canDrive: boolean }[] = [
  { key: 'OWN1', role: 'owner', canDrive: false },
  { key: 'ADM1', role: 'admin', canDrive: false },
  { key: 'SUP-R', role: 'supervisor', canDrive: false },
  { key: 'SUP-RD', role: 'supervisor', canDrive: true },
  { key: 'DRV1', role: 'driver', canDrive: false },
];

const has = (a: (typeof ACTORS)[number], p: Permission) =>
  (ROLE_PERMISSIONS[a.role] as readonly string[]).includes(p) ||
  (a.role === 'supervisor' && a.canDrive && (DRIVE_PERMISSIONS as readonly string[]).includes(p));

describe('permission matrix (canon §10) over every implemented route', () => {
  let t: TestApp;
  let routes: ReturnType<typeof collectRoutes>;
  beforeAll(async () => {
    t = await createTestApp();
    routes = collectRoutes(
      t.app.get(DiscoveryService),
      t.app.get(MetadataScanner),
      t.app.get(Reflector),
    ).filter((r) => !r.public && r.permission);
  });
  afterAll(async () => t.close());

  const DUMMY = '00000000-0000-4000-8000-0000deadbeef';
  const call = async (r: ReturnType<typeof collectRoutes>[number], as: SeedUserKey) => {
    const path = r.path.replace(/\{[A-Za-z]+\}/g, DUMMY);
    const m = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const agent = t.http();
    let req = agent[m](path).set('Cookie', await t.sessionFor(as));
    if (m !== 'get') req = req.set(CSRF).set('Idempotency-Key', newKey());
    return m === 'get' ? req : req.send({});
  };

  it('has routes to check', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('negative: a role without the permission is PERMISSION_DENIED', async () => {
    const failures: string[] = [];
    for (const r of routes) {
      for (const a of ACTORS.filter((x) => !has(x, r.permission as Permission))) {
        const res = await call(r, a.key);
        if (res.status !== 403 || res.body?.error?.code !== 'PERMISSION_DENIED')
          failures.push(`${r.method} ${r.path} as ${a.key}: ${res.status} ${res.body?.error?.code}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('positive: a role holding the permission passes the guard', async () => {
    const failures: string[] = [];
    for (const r of routes) {
      for (const a of ACTORS.filter((x) => has(x, r.permission as Permission))) {
        const res = await call(r, a.key);
        const code = res.body?.error?.code;
        // business rules may legitimately refuse with PERMISSION_DENIED + a reason (e.g. owner-only reset-mfa)
        if (code === 'PERMISSION_DENIED' && !res.body.error.details?.reason)
          failures.push(`${r.method} ${r.path} as ${a.key}: ${res.status} ${code}`);
        if (res.status >= 500) failures.push(`${r.method} ${r.path} as ${a.key}: ${res.status} ${code}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
