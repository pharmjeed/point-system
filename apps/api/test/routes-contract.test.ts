import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ROUTES } from '@point/shared';
import { Database, FakeClock, collectRoutes } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';
import { testEnv } from './test-env.js';

/**
 * PNT-013 / 16 §3.2: every implemented route matches canon §9 (path, permission, ✓ idempotency). Routes of the
 * canon that are not implemented yet are listed (ROUTES_COMPLETE=1 turns that list into a failure, for G5).
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

  it('every declared route exists in canon §9 with the same permission and idempotency', () => {
    const problems: string[] = [];
    for (const r of declared) {
      if (r.path.startsWith('/health')) continue;
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

  it('reports canon routes not implemented yet', () => {
    const implemented = new Set(declared.map((r) => key(r.method, r.path)));
    const missing = ROUTES.filter(
      (r) => r.permission !== 'internal' && !implemented.has(key(r.method, r.path)),
    ).map((r) => key(r.method, r.path));
    if (process.env.ROUTES_COMPLETE === '1') expect(missing).toEqual([]);
    else console.info(`[routes] ${ROUTES.length - missing.length}/${ROUTES.length} canon routes implemented`);
  });
});
