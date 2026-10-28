import { WA_TEMPLATE_NAMES } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKey } from './harness.js';
import { ORG, createWaTestApp, type WaTestApp } from './wa-harness.js';

/** PNT-038 (single channel, references only) and PNT-039 (templates, sync, approval gate). */
describe('WhatsApp channel and templates (canon §9.7)', () => {
  let w: WaTestApp;
  beforeAll(async () => {
    w = await createWaTestApp();
  });
  afterAll(async () => w?.close());

  const body = (over: Record<string, unknown> = {}) => ({
    business_account_id: 'SIM-WABA',
    phone_number_id: 'SIM-PHONE',
    phone_display: '+966500000000',
    api_version: 'v26.0',
    mode: 'simulator',
    access_token_secret_ref: 'env://WA_ACCESS_TOKEN',
    app_secret_ref: 'env://WA_APP_SECRET',
    verify_token_secret_ref: 'env://WA_VERIFY_TOKEN',
    ...over,
  });

  describe('PNT-038 — GET/PUT /v1/admin/whatsapp/channel', () => {
    it('owner and admin read the channel; no secret value or reference is ever returned', async () => {
      for (const who of ['OWN1', 'ADM1'] as const) {
        const r = await w.get('/v1/admin/whatsapp/channel', who);
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({
          phone_number_id: 'SIM-PHONE',
          business_account_id: 'SIM-WABA',
          api_version: 'v26.0',
          mode: 'simulator',
          is_active: true,
          health_status: 'healthy',
          secrets_configured: { access_token: true, app_secret: true, verify_token: true },
        });
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/secret_ref|env:\/\/|sim-access-token|sim-app-secret|sim-verify-token/);
      }
    });

    it('supervisors and drivers cannot read it; admins cannot change it (owner only)', async () => {
      expect((await w.get('/v1/admin/whatsapp/channel', 'SUP-R')).status).toBe(403);
      expect((await w.get('/v1/admin/whatsapp/channel', 'DRV1')).status).toBe(403);
      const r = await w.command('put', '/v1/admin/whatsapp/channel', { as: 'ADM1', body: body() });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('the owner updates the same number in place (audit, Idempotency-Key replay)', async () => {
      const key = newKey();
      const r = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        key,
        body: body({ phone_display: '+966500000001', api_version: 'v26.1' }),
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        api_version: 'v26.1',
        phone_display: '+966500000001',
        is_active: true,
      });
      const again = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        key,
        body: body({ phone_display: '+966500000001', api_version: 'v26.1' }),
      });
      expect(again.headers['idempotent-replayed']).toBe('true');
      const rows = await w.db.query(`SELECT id, api_version FROM whatsapp_channel WHERE org_id = $1`, [ORG]);
      expect(rows.rows).toHaveLength(1);
      const audit = await w.db.query(
        `SELECT action, after FROM audit_log WHERE entity_type = 'whatsapp_channel' AND action = 'wa.channel_manage'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0])).not.toMatch(/secret/);
      // back to the seeded version for the other tests
      await w.command('put', '/v1/admin/whatsapp/channel', { as: 'OWN1', body: body() });
    });

    it('refuses raw secret values, a mode other than WA_MODE, and requires an Idempotency-Key', async () => {
      const raw = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        body: body({ access_token_secret_ref: 'EAAG-real-looking-token-value' }),
      });
      expect(raw.status).toBe(422);
      expect(raw.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(raw.body)).not.toContain('EAAG-real-looking-token-value');
      const live = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        body: body({ mode: 'live' }),
      });
      expect(live.status).toBe(422);
      expect(live.body.error.details.fields[0]).toMatchObject({ field: 'mode', issue: 'wa_mode_mismatch' });
      const noKey = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        key: null,
        body: body(),
      });
      expect(noKey.status).toBe(428);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('a different number replaces the channel: exactly one active row (uq_whatsapp_channel_active)', async () => {
      const r = await w.command('put', '/v1/admin/whatsapp/channel', {
        as: 'OWN1',
        body: body({ phone_number_id: 'SIM-PHONE-2' }),
      });
      expect(r.status).toBe(200);
      const rows = await w.db.query<{ phone_number_id: string; is_active: boolean }>(
        `SELECT phone_number_id, is_active FROM whatsapp_channel WHERE org_id = $1 ORDER BY created_at`,
        [ORG],
      );
      expect(rows.rows.map((x) => [x.phone_number_id, x.is_active])).toEqual([
        ['SIM-PHONE', false],
        ['SIM-PHONE-2', true],
      ]);
      // the original number again (a new active row; history keeps the old ones)
      await w.command('put', '/v1/admin/whatsapp/channel', { as: 'OWN1', body: body() });
      const active = await w.db.query(`SELECT 1 FROM whatsapp_channel WHERE org_id = $1 AND is_active`, [
        ORG,
      ]);
      expect(active.rowCount).toBe(1);
      await expect(
        w.db.query(
          `INSERT INTO whatsapp_channel (org_id, business_account_id, phone_number_id, access_token_secret_ref, app_secret_ref,
                  verify_token_secret_ref, api_version) VALUES ($1, 'X', 'Y', 'env://A', 'env://B', 'env://C', 'v1.0')`,
          [ORG],
        ),
      ).rejects.toMatchObject({ constraint: 'uq_whatsapp_channel_active' });
    });
  });

  describe('PNT-039 — templates', () => {
    it('GET lists nothing before the first sync (no seeded template rows, DEC-52)', async () => {
      const r = await w.get('/v1/admin/whatsapp/templates', 'ADM1');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    });

    it('POST sync reads /{waba_id}/message_templates and stores W-01 … W-08 in catalog order', async () => {
      const r = await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'ADM1' });
      expect(r.status).toBe(200);
      expect(r.body.data.map((t: { name: string }) => t.name)).toEqual([...WA_TEMPLATE_NAMES]);
      for (const t of r.body.data)
        expect(t).toMatchObject({ language: 'ar', category: 'UTILITY', status: 'approved', version: 1 });
      expect(r.body.data[0].meta_template_id).toBeTruthy();
      const list = await w.get('/v1/admin/whatsapp/templates', 'OWN1');
      expect(list.body.data).toEqual(r.body.data);
      // a second sync with nothing changed keeps the versions
      const again = await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1' });
      expect(again.body.data.map((t: { version: number }) => t.version)).toEqual(
        WA_TEMPLATE_NAMES.map(() => 1),
      );
      const audits = await w.db.query(`SELECT 1 FROM audit_log WHERE action = 'wa.templates_manage'`);
      expect(audits.rowCount).toBe(2);
    });

    it('a template paused at Meta becomes paused here and degrades the channel (12 §6.9)', async () => {
      await w.sim.client.setTemplateStatus('masaf_request_reserved_v1', 'PAUSED', { emitWebhook: false });
      const r = await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1' });
      expect(r.status).toBe(200);
      const w03 = r.body.data.find((t: { name: string }) => t.name === 'masaf_request_reserved_v1');
      expect(w03).toMatchObject({ status: 'paused', version: 2 });
      const ch = await w.get('/v1/admin/whatsapp/channel', 'OWN1');
      expect(ch.body.data.health_status).toBe('degraded');
      const ev = await w.db.query(
        `SELECT payload->'payload' AS p FROM outbox_events WHERE type = 'wa.channel_health_changed' ORDER BY seq DESC LIMIT 1`,
      );
      expect(ev.rows[0].p).toMatchObject({ from: 'healthy', to: 'degraded' });
      await w.sim.client.setTemplateStatus('masaf_request_reserved_v1', 'APPROVED', { emitWebhook: false });
      await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1' });
      await w.db.query(
        `UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1 AND is_active`,
        [ORG],
      );
    });

    it('sync with the provider unreachable: WA_CHANNEL_UNAVAILABLE, nothing written; supervisors refused', async () => {
      await w.sim.client.setChannel({ state: 'down', code: 190 });
      const r = await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'OWN1' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('WA_CHANNEL_UNAVAILABLE');
      expect(r.headers['retry-after']).toBeDefined();
      await w.sim.client.setChannel({ state: 'up' });
      expect((await w.command('post', '/v1/admin/whatsapp/templates/sync', { as: 'SUP-R' })).status).toBe(
        403,
      );
      expect((await w.get('/v1/admin/whatsapp/templates', 'SUP-R')).status).toBe(403);
    });
  });
});
