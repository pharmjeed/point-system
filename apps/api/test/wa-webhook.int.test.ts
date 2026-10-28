import { createHmac } from 'node:crypto';
import { WhatsappRuntime } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG, WA_TEST_SECRETS, createWaTestApp, type WaTestApp } from './wa-harness.js';

const sign = (secret: string, raw: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** PNT-040 — GET/POST /webhooks/whatsapp (12 §6.1–§6.2, AC-01 delivery side). */
describe('WhatsApp webhook endpoint', () => {
  let w: WaTestApp;
  beforeAll(async () => {
    process.env.WA_APP_SECRET_OLD = 'previous-app-secret-for-tests';
    w = await createWaTestApp({ env: { WA_APP_SECRET_PREVIOUS_REF: 'env://WA_APP_SECRET_OLD' } });
  });
  afterAll(async () => w?.close());

  let seq = 0;
  const body = () =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'SIM-WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '966500000000', phone_number_id: 'SIM-PHONE' },
                contacts: [{ profile: { name: 'x' }, wa_id: '966551234567' }],
                messages: [
                  {
                    from: '966551234567',
                    id: `wamid.test.${++seq}.${Date.now()}`,
                    timestamp: String(w.ts()),
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  const post = (raw: string, signature: string | null) => {
    let r = w.http().post('/webhooks/whatsapp').set('Content-Type', 'application/json');
    if (signature !== null) r = r.set('X-Hub-Signature-256', signature);
    return r.send(raw);
  };
  const stored = async () =>
    Number((await w.db.query(`SELECT count(*)::int AS n FROM whatsapp_inbound_events`)).rows[0].n);

  describe('GET — the setup handshake', () => {
    it('echoes hub.challenge as text/plain for the right verify token', async () => {
      const r = await w.http().get('/webhooks/whatsapp').query({
        'hub.mode': 'subscribe',
        'hub.verify_token': WA_TEST_SECRETS.WA_VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/^text\/plain/);
      expect(r.text).toBe('1158201444');
      const viaSim = await w.sim.client.verifyWebhook({ challenge: 'abc123' });
      expect(viaSim).toMatchObject({ ok: true });
    });

    it('refuses a wrong or missing token with WA_WEBHOOK_VERIFY_FAILED (403)', async () => {
      for (const q of [
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
        { 'hub.mode': 'subscribe', 'hub.challenge': '1' },
        {
          'hub.mode': 'unsubscribe',
          'hub.verify_token': WA_TEST_SECRETS.WA_VERIFY_TOKEN,
          'hub.challenge': '1',
        },
      ]) {
        const r = await w.http().get('/webhooks/whatsapp').query(q);
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('WA_WEBHOOK_VERIFY_FAILED');
      }
    });
  });

  describe('POST — verify, store, acknowledge', () => {
    it('a signed delivery is stored once and processed by job.wa_process_inbound; the answer is 200 with no body', async () => {
      const raw = body();
      const before = await stored();
      const r = await post(raw, sign(WA_TEST_SECRETS.WA_APP_SECRET, raw));
      expect(r.status).toBe(200);
      expect(r.text).toBe('');
      expect(await stored()).toBe(before + 1);
      const row = (
        await w.db.query(
          `SELECT id, org_id, status, raw_body, signature_verified_at FROM whatsapp_inbound_events ORDER BY received_at DESC LIMIT 1`,
        )
      ).rows[0];
      expect(row).toMatchObject({ org_id: ORG, status: 'pending', raw_body: raw });
      const job = await w.db.query(
        `SELECT payload FROM outbox_events WHERE type = 'job.wa_process_inbound' AND payload->>'inbound_event_id' = $1`,
        [row.id],
      );
      expect(job.rows).toHaveLength(1);
    });

    it('the same body ×10 (Meta retries) → one row, ten 200 answers', async () => {
      const raw = body();
      const before = await stored();
      const r = await w.sim.client.emitRaw({ body: raw, copies: 10 });
      expect(r.deliveries.map((d) => d.httpStatus)).toEqual(Array(10).fill(200));
      expect(await stored()).toBe(before + 1);
      const jobs = await w.db.query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'job.wa_process_inbound'`,
      );
      expect(jobs.rows[0].n).toBe(before + 1);
    });

    it('an invalid or missing signature is refused (401) and nothing is stored', async () => {
      const raw = body();
      const before = await stored();
      for (const sig of [
        sign('wrong-secret', raw),
        null,
        'sha256=xyz',
        sign(WA_TEST_SECRETS.WA_APP_SECRET, raw + ' '),
      ]) {
        const r = await post(raw, sig);
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('WA_WEBHOOK_SIGNATURE_INVALID');
      }
      const viaSim = await w.sim.client.emitRaw({ body: raw, signature: 'invalid' });
      expect(viaSim.deliveries[0]?.httpStatus).toBe(401);
      expect(await stored()).toBe(before);
    });

    it('the previous app secret is accepted during a rotation (WA_APP_SECRET_PREVIOUS_REF)', async () => {
      const raw = body();
      const r = await post(raw, sign('previous-app-secret-for-tests', raw));
      expect(r.status).toBe(200);
    });

    it('accepts a signed delivery up to 3 MB (a batch may carry 1000 updates) and refuses a bigger one (12 §6.2, DEC-130)', async () => {
      const big = (bytes: number) => {
        const b = JSON.parse(body());
        b.entry[0].changes[0].value.messages[0].text.body = 'x'.repeat(bytes);
        return JSON.stringify(b);
      };
      const two = big(2 * 1024 * 1024);
      const ok = await post(two, sign(WA_TEST_SECRETS.WA_APP_SECRET, two));
      expect(ok.status).toBe(200);
      const four = big(4 * 1024 * 1024);
      const tooBig = await post(four, sign(WA_TEST_SECRETS.WA_APP_SECRET, four));
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      // other routes keep the 1 MB JSON limit
      const other = await w
        .http()
        .post('/v1/auth/login')
        .set('Content-Type', 'application/json')
        .set('X-Requested-With', 'point-web')
        .send(JSON.stringify({ phone: '0500000000', secret: 'y'.repeat(2 * 1024 * 1024) }));
      expect(other.status).toBe(413);
    });

    it('a database failure answers 5xx, never a false 200 (Meta will retry)', async () => {
      await w.db.query(`CREATE FUNCTION test_inbound_down() RETURNS trigger LANGUAGE plpgsql AS $$
                          BEGIN RAISE EXCEPTION 'database unavailable (test)'; END $$`);
      await w.db.query(`CREATE TRIGGER trg_test_inbound_down BEFORE INSERT ON whatsapp_inbound_events
                          FOR EACH ROW EXECUTE FUNCTION test_inbound_down()`);
      try {
        const raw = body();
        const r = await post(raw, sign(WA_TEST_SECRETS.WA_APP_SECRET, raw));
        expect(r.status).toBeGreaterThanOrEqual(500);
        expect(r.body.ok).toBeUndefined();
      } finally {
        await w.db.query(`DROP TRIGGER trg_test_inbound_down ON whatsapp_inbound_events`);
        await w.db.query(`DROP FUNCTION test_inbound_down()`);
      }
    });

    it('no active channel: 503 so that Meta keeps the delivery (nothing can verify it)', async () => {
      const apiRuntime = w.app.get(WhatsappRuntime, { strict: false });
      await w.db.query(`UPDATE whatsapp_channel SET is_active = false WHERE org_id = $1`, [ORG]);
      apiRuntime.channels.invalidate();
      try {
        const raw = body();
        const r = await post(raw, sign(WA_TEST_SECRETS.WA_APP_SECRET, raw));
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe('SERVICE_UNAVAILABLE');
      } finally {
        await w.db.query(
          `UPDATE whatsapp_channel SET is_active = true WHERE id = (SELECT id FROM whatsapp_channel WHERE org_id = $1 ORDER BY created_at LIMIT 1)`,
          [ORG],
        );
        apiRuntime.channels.invalidate();
      }
    });

    it('acknowledges in < 300 ms (p95, local)', async () => {
      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const raw = body();
        const started = performance.now();
        const r = await post(raw, sign(WA_TEST_SECRETS.WA_APP_SECRET, raw));
        times.push(performance.now() - started);
        expect(r.status).toBe(200);
      }
      times.sort((a, b) => a - b);
      expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThan(300);
    });
  });
});
