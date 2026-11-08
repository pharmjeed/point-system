/**
 * The real API for the live G1 run (PNT-036) — test code only, never deployed.
 *
 * - A throwaway database on TEST_DATABASE_URL (a PostgreSQL 16 where we may CREATE DATABASE; default the
 *   local postgres/postgres of docs/progress/ENGINEERING.md), migrated (first migration = docs/06_schema.sql)
 *   and loaded with the development seed of docs/17 §4, like apps/api/test/harness.ts.
 * - The API built to dist (`pnpm --filter @point/shared --filter @point/db --filter @point/server
 *   --filter @point/api build`), listening on E2E_API_PORT with APP_BASE_URL = the web origin, so the CSRF
 *   Origin check passes through the same-origin proxy of `vite preview`.
 * - No S3 in tests: the private bucket is the API's in-memory one. Its presigned URLs
 *   (`http://object-storage.invalid/…`) are answered by the spec's browser route through `/__e2e/storage`
 *   here (the original URL in `x-e2e-url`), with the bucket's own signature, expiry and length checks.
 *
 * Prints one JSON line `{"ready":true,…}` once listening; SIGTERM closes the app and drops the database.
 */
import pg from 'pg';
import { createDatabase, dropDatabase, migrate } from '../../../../packages/db/dist/index.js';
import { seed, SEED_IDS } from '../../../../packages/db/dist/seed/index.js';
import { loadEnv, OBJECT_STORAGE } from '../../../../packages/server/dist/index.js';
import { setSupervisorMfaRequired } from '../../../../packages/server/dist/testing/index.js';
import { createApp } from '../../../api/dist/bootstrap.js';

const admin = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const port = Number(process.env.E2E_API_PORT ?? 3917);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5317';

/** Fixed, obviously fake test values (the same shape as apps/api/test/test-env.ts). */
const b64 = (s) => Buffer.from(s.padEnd(32, '.')).toString('base64');

const database = await createDatabase(admin, 'point_e2e');
let app;
const stop = async (code = 0) => {
  // bounded: an open socket or keep-alive must not hold the run (CI teardown timed out waiting for close())
  setTimeout(() => process.exit(code), 10_000).unref();
  await app?.close().catch(() => {});
  await dropDatabase(admin, database.name).catch(() => {});
  process.exit(code);
};
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

try {
  await migrate(database.url);
  const env = loadEnv({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    TZ: 'UTC',
    APP_BASE_URL: webOrigin,
    API_PORT: String(port),
    BRAND_STAFF_NAME_AR: 'STAFF_AR',
    BRAND_STAFF_NAME_EN: 'POINT',
    BRAND_CUSTOMER_NAME_AR: 'CUSTOMER_AR',
    BRAND_CUSTOMER_NAME_EN: 'MASAF',
    DATABASE_URL: database.url,
    SESSION_SECRET: b64('session-secret-for-e2e'),
    SESSION_COOKIE_NAME: 'point_sid',
    SESSION_COOKIE_SECURE: 'false',
    CODE_PEPPER: b64('code-pepper-for-e2e'),
    AUTH_SECRET_PEPPER: b64('auth-pepper-for-e2e'),
    DATA_ENCRYPTION_KEY: b64('data-key-for-e2e'),
    DATA_ENCRYPTION_KEY_ID: 'e2e1',
    LOG_LEVEL: 'error',
    METRICS_ENABLED: 'false',
  });
  const pool = new pg.Pool({ connectionString: database.url, max: 2 });
  try {
    await seed(pool, {
      env: 'test',
      nodeEnv: 'test',
      dataEncryptionKey: env.DATA_ENCRYPTION_KEY,
      dataEncryptionKeyId: env.DATA_ENCRYPTION_KEY_ID,
      secretPepper: env.AUTH_SECRET_PEPPER,
    });
    // the seed enables MFA for OWN1/ADM1 only; SUP-R signs in with the password (as the API tests do)
    await setSupervisorMfaRequired(pool, SEED_IDS.org, false);
  } finally {
    await pool.end();
  }

  app = await createApp({ env });
  const storage = app.get(OBJECT_STORAGE);
  app.use('/__e2e/storage', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const target = String(req.headers['x-e2e-url'] ?? '');
      const r = storage.handleHttp(req.method, target, {
        headers: { 'content-type': String(req.headers['content-type'] ?? '') },
        body: Buffer.concat(chunks),
      });
      res.status(r.status);
      for (const [name, value] of Object.entries(r.headers ?? {})) res.setHeader(name, value);
      res.end(r.body ?? (r.code ? `${r.code}: ${r.message ?? ''}` : ''));
    });
  });
  await app.listen(port);
  console.log(
    JSON.stringify({ ready: true, apiOrigin: `http://localhost:${port}`, databaseUrl: database.url }),
  );
} catch (error) {
  console.error(error);
  await stop(1);
}
