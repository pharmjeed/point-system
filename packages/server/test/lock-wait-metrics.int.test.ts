import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockPools } from '../src/core/db/locks.js';
import { metrics } from '../src/core/metrics/metrics.js';
import { POOL_R, seededDb } from './audit-monitoring-fixtures.js';
import type { TestContext } from './helpers.js';

type Histogram = typeof metrics.dbLockWait;
const sample = async (h: Histogram, suffix: '_count' | '_sum') =>
  (await h.get()).values.find((v) => v.metricName?.endsWith(suffix))?.value ?? 0;

/**
 * 05 §12.2 `point_db_lock_wait_seconds` / `point_dispatch_pool_lock_wait_seconds`: a wait that ends in
 * `lock_timeout` (55P03 → SERVICE_UNAVAILABLE) is timed like one that gets the lock — those are the waits the
 * histograms exist for.
 */
describe('lock wait histograms', () => {
  let t: TestContext;
  let holder: pg.Client;

  beforeAll(async () => {
    t = await seededDb();
    holder = new pg.Client({ connectionString: t.testDb.url });
    await holder.connect();
  });
  afterAll(async () => {
    await holder.end();
    await t.close();
  });

  it('a pool lock that times out is observed with its whole wait', async () => {
    const before = {
      count: await sample(metrics.dbLockWait, '_count'),
      sum: await sample(metrics.dbLockWait, '_sum'),
      poolCount: await sample(metrics.dispatchPoolLockWait, '_count'),
      poolSum: await sample(metrics.dispatchPoolLockWait, '_sum'),
    };
    await holder.query('BEGIN');
    try {
      await holder.query(`SELECT 1 FROM dispatch_pools WHERE id = $1 FOR UPDATE`, [POOL_R]);
      await expect(
        t.db.transaction((tx) => lockPools(tx, [POOL_R]), { lockTimeoutMs: 300 }),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.query('ROLLBACK');
    }
    expect(await sample(metrics.dbLockWait, '_count')).toBe(before.count + 1);
    expect(await sample(metrics.dispatchPoolLockWait, '_count')).toBe(before.poolCount + 1);
    expect((await sample(metrics.dbLockWait, '_sum')) - before.sum).toBeGreaterThanOrEqual(0.29);
    expect((await sample(metrics.dispatchPoolLockWait, '_sum')) - before.poolSum).toBeGreaterThanOrEqual(
      0.29,
    );

    // the same lock once free: observed again, and short
    const sum = await sample(metrics.dbLockWait, '_sum');
    await t.db.transaction((tx) => lockPools(tx, [POOL_R]));
    expect(await sample(metrics.dbLockWait, '_count')).toBe(before.count + 2);
    expect((await sample(metrics.dbLockWait, '_sum')) - sum).toBeLessThan(0.25);
  });
});
