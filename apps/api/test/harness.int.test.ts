import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SEED_IDS, type TestApp } from './harness.js';

describe('test harness', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('seeds 17 §4 and opens sessions for seeded users', async () => {
    const r = await t.db.query(`SELECT count(*)::int AS n FROM users`);
    expect(r.rows[0].n).toBe(13);
    expect(await t.sessionFor('DRV1')).toMatch(/^point_sid=/);
    expect(SEED_IDS.venues.RMS).toBeTruthy();
  });
});
