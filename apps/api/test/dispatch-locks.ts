import pg from 'pg';
import type { TestApp } from './harness.js';

/**
 * Holds a row lock in a separate connection so a request blocks behind it; used to change the world between
 * the actor check and the command's locks (TOCTOU, 09 §8.4) and to line racing requests up.
 */
export async function holdRowLock(t: TestApp, table: string, id: string) {
  const c = new pg.Client({ connectionString: t.tdb.url });
  c.on('error', () => {}); // terminated by the database drop if a test fails before release()
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR NO KEY UPDATE`, [id]);
  return {
    /** a statement inside the holding transaction (e.g. the change a concurrent command makes before commit) */
    async query(sql: string, params: unknown[] = []) {
      return c.query(sql, params);
    },
    async release() {
      await c.query('COMMIT');
      await c.end();
    },
  };
}

/** Waits until `n` backends of the test database wait on a lock. */
export async function waitForLockWaiters(t: TestApp, n: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const r = await t.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((r.rows[0]?.n ?? 0) >= n) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`only ${r.rows[0]?.n} lock waiters after ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
