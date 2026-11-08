import { SEED_IDS } from '@point/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness.js';

const RMS = SEED_IDS.venues.RMS;

/**
 * 09 §4 rule 1: the owner and the admin reach no data without an active `org` scope row; revoking it freezes their
 * access without deleting the account, and granting it back restores it. No role is exempt.
 */
describe('owner and admin need an active org scope row', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const setOrgScope = (user: 'OWN1' | 'ADM1', active: boolean) =>
    t.db.query(`UPDATE role_scopes SET revoked_at = ${active ? 'NULL' : 'now()'} WHERE id = $1`, [
      SEED_IDS.roleScopes[user].org,
    ]);

  for (const user of ['OWN1', 'ADM1'] as const) {
    it(`${user}: revoking the org scope freezes access; restoring it brings it back`, async () => {
      const before = await t.get('/v1/venues', user);
      expect(before.status).toBe(200);
      expect(before.body.data.map((v: { id: string }) => v.id)).toContain(RMS);

      await setOrgScope(user, false);
      try {
        const list = await t.get('/v1/venues', user);
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([]);
        const one = await t.get(`/v1/venues/${RMS}`, user);
        expect(one.status).toBeGreaterThanOrEqual(403);
        expect(['SCOPE_VENUE_DENIED', 'RESOURCE_NOT_FOUND']).toContain(one.body.error.code);
        expect((await t.get('/v1/admin/audit-log', user)).body.data ?? []).toEqual([]);
      } finally {
        await setOrgScope(user, true);
      }

      const after = await t.get('/v1/venues', user);
      expect(after.body.data.map((v: { id: string }) => v.id)).toContain(RMS);
    });
  }
});
