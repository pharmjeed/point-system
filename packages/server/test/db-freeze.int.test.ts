import { createTestDatabase, testAdminUrl, type TestDatabase } from '@point/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, type Clock } from '../src/core/clock/clock.js';
import { Database, READ_TIMEOUT_MARGIN_MS } from '../src/core/db/database.js';
import { isDbUnavailableError } from '../src/core/errors/pg-constraint-map.js';
import { startFreezeProxy, type FreezeProxy } from '../src/testing/index.js';

const STATEMENT_TIMEOUT_MS = 400;
const READ_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + READ_TIMEOUT_MARGIN_MS; // 2.4 s
const CONNECT_TIMEOUT_MS = 800;
/** scheduling slack on a loaded CI host (the integration files run in parallel) */
const SLACK_MS = 3000;

async function timed<T>(p: Promise<T>): Promise<{ ms: number; error: unknown; value?: T }> {
  const started = performance.now();
  try {
    const value = await p;
    return { ms: performance.now() - started, error: null, value };
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
}

/**
 * DEC-PROPOSED-8, 17 §12 «إيقاف الحاوية مؤقتًا»: a database that stops answering without closing anything (a
 * paused container, a stalled link) is waited for in bounded time — the client read timeout (statement timeout
 * + 2 s), the connect timeout for a slot or a new connection — and every bound fails as a database-unavailable
 * error (SERVICE_UNAVAILABLE). A connection that timed out is destroyed, never handed out again, so the pool
 * works at once after the thaw. The freeze is a real TCP relay that holds the bytes (startFreezeProxy).
 */
describe('a frozen database — bounded waits, broken connections destroyed', () => {
  let tdb: TestDatabase;
  let proxy: FreezeProxy;
  let db: Database;
  let admin: pg.Client;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const u = new URL(tdb.url);
    proxy = await startFreezeProxy({ host: u.hostname, port: Number(u.port || 5432) });
    db = new Database(
      {
        connectionString: proxy.via(tdb.url),
        poolMax: 3,
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        applicationName: 'point-freeze-test',
      },
      new FakeClock() as Clock,
    );
    db.onIdleError = () => {};
    admin = new pg.Client({ connectionString: testAdminUrl() });
    await admin.connect();
  });
  afterEach(() => proxy.thaw());
  afterAll(async () => {
    proxy.thaw();
    await db.close();
    await proxy.stop();
    await admin.end();
    await tdb.drop();
  });

  /** backends of the database under test, seen directly (not through the relay) */
  const backends = async () =>
    (
      await admin.query<{ state: string | null }>(
        `SELECT state FROM pg_stat_activity WHERE datname = $1 AND application_name = 'point-freeze-test'`,
        [tdb.name],
      )
    ).rows;

  it('a pooled connection gets no answer: the query fails at statement timeout + 2 s, the connection is destroyed', async () => {
    await db.query('SELECT 1');
    expect(db.pool.idleCount).toBe(1);
    proxy.freeze();
    const r = await timed(db.query('SELECT 1'));
    expect(isDbUnavailableError(r.error)).toBe(true);
    expect(String((r.error as Error).message)).toMatch(/query read timeout/i);
    expect(r.ms).toBeGreaterThanOrEqual(READ_TIMEOUT_MS - 50);
    expect(r.ms).toBeLessThan(READ_TIMEOUT_MS + SLACK_MS);
    // not returned to the pool: the next user would queue behind the unanswered statement
    expect(db.pool.totalCount).toBe(0);
  });

  it('a new connection that is never answered, and a slot of a full pool, fail at the connect timeout', async () => {
    proxy.freeze();
    const fresh = await timed(db.transaction((tx) => tx.query('SELECT 1')));
    expect(isDbUnavailableError(fresh.error)).toBe(true);
    expect(fresh.ms).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 50);
    expect(fresh.ms).toBeLessThan(CONNECT_TIMEOUT_MS + SLACK_MS);

    // three connections checked out and waiting for answers; a fourth request waits for a slot
    proxy.thaw();
    await Promise.all([1, 2, 3].map(() => db.query('SELECT pg_sleep(0.05)')));
    expect(db.pool.idleCount).toBe(3);
    proxy.freeze();
    const busy = [1, 2, 3].map(() => timed(db.query('SELECT 1')));
    await new Promise((r) => setTimeout(r, 100));
    const slot = await timed(db.query('SELECT 1'));
    expect(isDbUnavailableError(slot.error)).toBe(true);
    expect(String((slot.error as Error).message)).toMatch(/timeout exceeded when trying to connect/i);
    expect(slot.ms).toBeLessThan(CONNECT_TIMEOUT_MS + SLACK_MS);
    for (const b of await Promise.all(busy)) expect(isDbUnavailableError(b.error)).toBe(true);
  });

  it('a transaction frozen half-way fails after one read timeout (no ROLLBACK waited for); the pool works after the thaw', async () => {
    proxy.thaw();
    await db.query('SELECT 1');
    const started = performance.now();
    const r = await timed(
      db.transaction(async (tx) => {
        await tx.query('SELECT 1');
        proxy.freeze();
        await tx.query('SELECT 2');
      }),
    );
    const ms = performance.now() - started;
    expect(isDbUnavailableError(r.error)).toBe(true);
    // one read timeout, not two: no ROLLBACK is sent on a connection that stopped answering
    expect(ms).toBeLessThan(2 * READ_TIMEOUT_MS);
    proxy.thaw();
    const after = await timed(db.query('SELECT 42 AS n'));
    expect(after.error).toBeNull(); // a reused broken connection would fail with its read timeout instead
    expect(after.ms).toBeLessThan(2000);
    expect(after.value?.rows[0].n).toBe(42);
    // the destroyed connection's backend is gone: the server rolled its transaction back, none is left open
    await expect
      .poll(async () => (await backends()).filter((b) => b.state === 'idle in transaction').length, {
        timeout: 5000,
      })
      .toBe(0);
  });
});
