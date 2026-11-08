import { SEED_CREDENTIALS, SEED_IDS, seed } from '@point/db/seed';
import { createTestDatabase, type TestDatabase } from '@point/db/testing';
import { Database, FakeClock, type DatabaseConfig, type Env, type Logger } from '@point/server';
import { createSessionCookie, setSupervisorMfaRequired } from '@point/server/testing';
import pg from 'pg';
import request from 'supertest';
import type { Type } from '@nestjs/common';
import { createApp } from '../src/bootstrap.js';
import { CSRF, testEnv } from './test-env.js';

export type SeedUserKey = keyof typeof SEED_IDS.users;

export interface TestApp {
  app: Awaited<ReturnType<typeof createApp>>;
  db: Database;
  clock: FakeClock;
  env: Env;
  tdb: TestDatabase;
  /** supertest agent bound to the app */
  http(): ReturnType<typeof request>;
  /** Cookie header for a seeded user (session inserted directly; login is tested by PNT-011). */
  sessionFor(user: SeedUserKey): Promise<string>;
  /** POST/PUT/PATCH helper with CSRF headers, a cookie and an Idempotency-Key. */
  command(
    method: 'post' | 'put' | 'patch',
    path: string,
    opts: { as: SeedUserKey | string; body?: unknown; key?: string | null },
  ): Promise<request.Response>;
  get(path: string, as: SeedUserKey | string): Promise<request.Response>;
  close(): Promise<void>;
}

let keySeq = 0;
export const newKey = () => `test-key-${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

/**
 * API test harness (docs/progress/ENGINEERING.md §5): a migrated database cloned from the template, the 17 §4
 * seed, a FakeClock shared by the app and the database, and helpers for sessions and commands.
 */
export async function createTestApp(
  opts: {
    seed?: boolean;
    clock?: FakeClock;
    env?: Record<string, string>;
    extraModules?: Type[];
    supervisorMfa?: boolean;
    /** the app's pool settings (e.g. a connection through startFreezeProxy); the seed connects directly */
    dbConfig?: (url: string) => Partial<DatabaseConfig>;
    /** the api's logger (V2-051: the security suite reads its lines) */
    logger?: Logger;
  } = {},
): Promise<TestApp> {
  const tdb = await createTestDatabase();
  const clock = opts.clock ?? new FakeClock('2026-10-27T16:00:00.000Z');
  const env = testEnv({ DATABASE_URL: tdb.url, ...(opts.env ?? {}) });
  const db = new Database({ connectionString: tdb.url, poolMax: 30, ...opts.dbConfig?.(tdb.url) }, clock);
  if (opts.seed ?? true) {
    const pool = new pg.Pool({ connectionString: tdb.url, max: 2 });
    try {
      await seed(pool, {
        env: 'test',
        nodeEnv: 'test',
        dataEncryptionKey: env.DATA_ENCRYPTION_KEY,
        dataEncryptionKeyId: env.DATA_ENCRYPTION_KEY_ID,
        secretPepper: env.AUTH_SECRET_PEPPER,
      });
    } finally {
      await pool.end();
    }
    if (!(opts.supervisorMfa ?? false)) await setSupervisorMfaRequired(db, SEED_IDS.org, false);
  }
  const app = await createApp({
    env,
    database: db,
    clock,
    extraModules: opts.extraModules,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  await app.init();
  const cookies = new Map<string, string>();
  const sessionFor = async (user: string) => {
    const id = (SEED_IDS.users as Record<string, string>)[user] ?? user;
    if (!cookies.has(id))
      cookies.set(id, (await createSessionCookie(db, id, { now: clock.now(), hours: 48 })).cookie);
    return cookies.get(id)!;
  };
  const t: TestApp = {
    app,
    db,
    clock,
    env,
    tdb,
    http: () => request(app.getHttpServer()),
    sessionFor: (u) => sessionFor(u),
    async command(method, path, o) {
      const server = request(app.getHttpServer());
      let req = server[method](path)
        .set(CSRF)
        .set('Cookie', await sessionFor(o.as));
      if (o.key !== null) req = req.set('Idempotency-Key', o.key ?? newKey());
      return req.send((o.body ?? {}) as object);
    },
    async get(path, as) {
      return request(app.getHttpServer())
        .get(path)
        .set('Cookie', await sessionFor(as));
    },
    async close() {
      await app.close();
      await db.close();
      await tdb.drop();
    },
  };
  return t;
}

export { SEED_CREDENTIALS, SEED_IDS, CSRF };
