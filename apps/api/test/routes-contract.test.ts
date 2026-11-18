import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PLATFORM_ROUTES, ROUTES } from '@point/shared';
import { CUSTOMER_ROUTES } from '@point/shared/customer';
import { Database, FakeClock, collectRoutes, routeProblems } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';
import { testEnv } from './test-env.js';

/**
 * PNT-013 / 16 §3.2: every implemented route matches canon §9 (path, permission, ✓ idempotency), and every canon
 * route is served (the server sweep made the former ROUTES_COMPLETE=1 check the default once all 131 were built).
 */
describe('routes contract (canon §9)', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let db: Database;
  let declared: ReturnType<typeof collectRoutes>;

  beforeAll(async () => {
    db = new Database({ connectionString: 'postgres://x:y@127.0.0.1:1/none' }, new FakeClock());
    app = await createApp({ env: testEnv(), database: db });
    await app.init(); // RouteAudit throws here if a route has no permission
    declared = collectRoutes(app.get(DiscoveryService), app.get(MetadataScanner), app.get(Reflector));
  });
  afterAll(async () => {
    await app.close();
    await db.close().catch(() => {});
  });

  const key = (m: string, p: string) => `${m} ${p}`;
  const canon = new Map(ROUTES.map((r) => [key(r.method, r.path), r]));

  const platform = new Map(PLATFORM_ROUTES.map((r) => [key(r.method, r.path), r]));

  const customer = new Map(Object.values(CUSTOMER_ROUTES).map((r) => [key(r.method, r.path), r]));

  it('every declared route exists in canon §9 with the same permission and idempotency', () => {
    const problems: string[] = [];
    for (const r of declared) {
      if (r.path.startsWith('/health')) continue;
      if (platform.has(key(r.method, r.path))) continue; // V2: checked below against PLATFORM_ROUTES
      if (customer.has(key(r.method, r.path))) continue; // V2-010: checked below against CUSTOMER_ROUTES
      const c = canon.get(key(r.method, r.path));
      if (!c) {
        problems.push(`${key(r.method, r.path)} is not in canon §9`);
        continue;
      }
      const expectPublic = c.permission === 'public' || c.permission === 'webhook';
      if (expectPublic !== r.public)
        problems.push(`${key(r.method, r.path)}: public=${r.public}, canon ${c.permission}`);
      if (!expectPublic && c.permission !== r.permission)
        problems.push(`${key(r.method, r.path)}: permission ${r.permission}, canon ${c.permission}`);
      if (c.idempotent && !r.command?.idempotent)
        problems.push(`${key(r.method, r.path)}: canon ✓ requires @Command() with Idempotency-Key`);
      if (r.command && r.command.operation !== key(r.method, r.path))
        problems.push(`${key(r.method, r.path)}: @Command operation is "${r.command.operation}"`);
    }
    expect(problems).toEqual([]);
  });

  it('V2 (DEC-462): the platform routes match PLATFORM_ROUTES and carry platform permissions only', () => {
    const problems: string[] = [];
    const served = declared.filter((r) => r.path.startsWith('/v1/platform'));
    for (const r of served) {
      const c = platform.get(key(r.method, r.path));
      if (!c) {
        problems.push(`${key(r.method, r.path)} is not in PLATFORM_ROUTES`);
        continue;
      }
      if ((c.permission === 'public') !== r.public)
        problems.push(`${key(r.method, r.path)}: public=${r.public}, registry ${c.permission}`);
      if (c.permission !== 'public' && r.platformPermission !== c.permission)
        problems.push(
          `${key(r.method, r.path)}: platform permission ${r.platformPermission}, registry ${c.permission}`,
        );
      if (r.permission)
        problems.push(`${key(r.method, r.path)}: carries the staff permission ${r.permission}`);
      if (c.idempotent && !r.command?.idempotent)
        problems.push(`${key(r.method, r.path)}: ✓ requires @Command() with Idempotency-Key`);
      if (r.command && r.command.operation !== key(r.method, r.path))
        problems.push(`${key(r.method, r.path)}: @Command operation is "${r.command.operation}"`);
    }
    expect(problems).toEqual([]);
    expect(served.map((r) => key(r.method, r.path)).sort()).toEqual([...platform.keys()].sort());
    // no staff route under /v1/platform and no platform permission elsewhere: the boot audit's rules
    expect(routeProblems(declared)).toEqual([]);
    expect(declared.filter((r) => r.platformPermission && !r.path.startsWith('/v1/platform/'))).toEqual([]);
  });

  it('V2-010 (DEC-497): the customer routes match CUSTOMER_ROUTES, Bearer-authorized, with no staff or platform permission', () => {
    const problems: string[] = [];
    const served = declared.filter((r) => r.path.startsWith('/v1/customer'));
    for (const r of served) {
      const c = customer.get(key(r.method, r.path));
      if (!c) {
        problems.push(`${key(r.method, r.path)} is not in CUSTOMER_ROUTES`);
        continue;
      }
      if ((c.auth === 'public') !== r.public)
        problems.push(`${key(r.method, r.path)}: public=${r.public}, registry ${c.auth}`);
      if (c.auth === 'customer' && !r.customer)
        problems.push(`${key(r.method, r.path)}: not @RequireCustomer`);
      if (r.permission || r.platformPermission)
        problems.push(`${key(r.method, r.path)}: carries a staff or platform permission`);
      if (c.idempotency === 'required' && !r.command?.idempotent)
        problems.push(`${key(r.method, r.path)}: Idempotency-Key required by the registry`);
      if (c.idempotency === 'none' && r.command?.idempotent)
        problems.push(`${key(r.method, r.path)}: Idempotency-Key required, registry none`);
      if (r.command && r.command.operation !== key(r.method, r.path))
        problems.push(`${key(r.method, r.path)}: @Command operation is "${r.command.operation}"`);
    }
    expect(problems).toEqual([]);
    expect(served.map((r) => key(r.method, r.path)).sort()).toEqual([...customer.keys()].sort());
    expect(declared.filter((r) => r.customer && !r.path.startsWith('/v1/customer/'))).toEqual([]);
  });

  it('the boot audit refuses a mixed-up route declaration (DEC-462)', () => {
    const base = { method: 'GET', public: false, customer: false, command: null, handler: 'X.y' };
    expect(
      routeProblems([
        { ...base, path: '/v1/platform/x', permission: 'venue.read', platformPermission: null },
        { ...base, path: '/v1/venues', permission: null, platformPermission: 'platform.self' },
        { ...base, path: '/v1/platform/y', permission: 'venue.read', platformPermission: 'platform.self' },
        { ...base, path: '/v1/z', permission: null, platformPermission: null },
        { ...base, path: '/v1/customer/x', permission: 'venue.read', platformPermission: null },
        { ...base, path: '/v1/venues/x', permission: null, platformPermission: null, customer: true },
      ]),
    ).toEqual([
      'staff permission on a platform route: GET /v1/platform/x (X.y)',
      'platform permission off /v1/platform: GET /v1/venues (X.y)',
      'staff and platform permission together: GET /v1/platform/y (X.y)',
      'staff permission on a platform route: GET /v1/platform/y (X.y)',
      'no @RequirePermission/@Public: GET /v1/z (X.y)',
      'staff or platform permission on a customer route: GET /v1/customer/x (X.y)',
      'customer authorization off /v1/customer: GET /v1/venues/x (X.y)',
    ]);
  });

  it('serves every canon route (G5: /metrics is the internal metrics server of startMetricsServer)', () => {
    const implemented = new Set(declared.map((r) => key(r.method, r.path)));
    const missing = ROUTES.filter(
      (r) => r.permission !== 'internal' && !implemented.has(key(r.method, r.path)),
    ).map((r) => key(r.method, r.path));
    expect(missing).toEqual([]);
    expect(ROUTES.filter((r) => r.permission === 'internal').map((r) => key(r.method, r.path))).toEqual([
      'GET /metrics',
    ]);
  });
});
