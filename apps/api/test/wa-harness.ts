import type { AddressInfo } from 'node:net';
import { SEED_IDS } from '@point/db/seed';
import { startSimulator, type RunningSimulator } from '../../../tools/wa-simulator/src/index.js';
import { createTestApp, newKey, type TestApp } from './harness.js';

/**
 * WhatsApp integration harness (PNT-038 … PNT-042, PNT-046, PNT-048): the API (webhook, admin routes)
 * listening on a real port and the simulator in-process as Graph API and webhook emitter.
 */

/** Test values for the seeded secret references (env://WA_ACCESS_TOKEN …): not real secrets. */
export const WA_TEST_SECRETS = {
  WA_ACCESS_TOKEN: 'sim-access-token-for-tests',
  WA_APP_SECRET: 'sim-app-secret-for-tests',
  WA_VERIFY_TOKEN: 'sim-verify-token-for-tests',
} as const;

export interface WaTestApp extends TestApp {
  sim: RunningSimulator;
  apiUrl: string;
  /** Unix seconds of the FakeClock (simulator webhook timestamps). */
  ts(offsetS?: number): number;
  syncTemplates(): Promise<void>;
}

export async function createWaTestApp(opts: { env?: Record<string, string> } = {}): Promise<WaTestApp> {
  Object.assign(process.env, WA_TEST_SECRETS);
  const sim = await startSimulator({
    appSecret: WA_TEST_SECRETS.WA_APP_SECRET,
    accessToken: WA_TEST_SECRETS.WA_ACCESS_TOKEN,
    verifyToken: WA_TEST_SECRETS.WA_VERIFY_TOKEN,
    phoneNumberId: 'SIM-PHONE',
    wabaId: 'SIM-WABA',
    autoStatuses: false,
  });
  const t = await createTestApp({
    env: { WA_GRAPH_BASE_URL: sim.url, WA_HTTP_TIMEOUT_MS: '3000', ...(opts.env ?? {}) },
  });
  await repairTemplateNameCheck(t);
  await t.app.listen(0, '127.0.0.1');
  const apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/whatsapp` });

  const w: WaTestApp = {
    ...t,
    sim,
    apiUrl,
    ts: (offsetS = 0) => Math.floor(t.clock.now().getTime() / 1000) + offsetS,
    async syncTemplates() {
      const r = await t.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1', key: newKey() });
      if (r.status !== 200) throw new Error(`template sync failed: ${r.status} ${JSON.stringify(r.body)}`);
    },
    async close() {
      await sim.close();
      await t.close();
    },
  };
  return w;
}

/**
 * SPEC DEFECT workaround (docs/progress/notes/s3-whatsapp.md, DEC-PROPOSED-1): docs/06_schema.sql declares
 * `whatsapp_templates.name CHECK (name ~ '^[a-z0-9_]{1,512}$')`, but PostgreSQL regexes allow at most 255
 * repetitions, so every INSERT into whatsapp_templates fails with 2201B. Until the migration fix lands,
 * the test database gets the equivalent valid check; it is a no-op once the schema is fixed.
 */
async function repairTemplateNameCheck(t: Pick<TestApp, 'db'>): Promise<void> {
  await t.db.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_templates_name_check'
                  AND pg_get_constraintdef(oid) LIKE '%{1,512}%') THEN
        ALTER TABLE whatsapp_templates DROP CONSTRAINT whatsapp_templates_name_check;
        ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_name_check
          CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512);
      END IF;
    END $$`);
}

export const ORG = SEED_IDS.org;
