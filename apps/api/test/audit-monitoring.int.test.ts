import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF, SEED_IDS, createTestApp, newKey, type TestApp } from './harness.js';

const U = SEED_IDS.users;
const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;

/**
 * PNT-092 (audit viewer, outbox administration) and PNT-091 (retention policy) through the real routes:
 * every error code these routes answer is reached here (08 §10).
 */
describe('audit log, outbox administration, retention policy', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  describe('GET /v1/admin/audit-log (audit.read)', () => {
    const rows: Record<string, number> = {};
    beforeAll(async () => {
      const ins = async (o: {
        at: string;
        action: string;
        actor?: string | null;
        entity?: [string, string] | null;
        venue?: string | null;
        reason?: string | null;
        metadata?: Record<string, unknown>;
      }) =>
        (
          await t.db.query<{ id: number }>(
            `INSERT INTO audit_log (org_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, venue_id, ip, user_agent, reason, before, metadata)
             VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, '10.1.2.3', 'Mozilla/5.0 secret-ua', $8, '{"phone":"+966551234567","status":"open"}', $9)
             RETURNING id`,
            [
              ORG,
              o.at,
              o.actor ?? U['SUP-R'],
              o.action,
              o.entity?.[0] ?? null,
              o.entity?.[1] ?? null,
              o.venue ?? null,
              o.reason ?? null,
              JSON.stringify(o.metadata ?? {}),
            ],
          )
        ).rows[0]!.id;
      rows.a = await ins({
        at: '2026-10-27T10:00:00Z',
        action: 'ticket.void',
        entity: ['ticket', U.DRV1],
        venue: RMS,
      });
      rows.b = await ins({
        at: '2026-10-27T11:00:00Z',
        action: 'ticket.reveal_phone',
        venue: RMS,
        reason: 'customer asked to call 0551234567 back',
        metadata: { code: '123456', token: 'abc', count: 3 },
      });
      rows.c = await ins({
        at: '2026-10-27T12:00:00Z',
        action: 'ticket.void',
        actor: U['SUP-RL'],
        venue: SEED_IDS.venues.LYL,
      });
      rows.d = await ins({ at: '2026-10-27T13:00:00Z', action: 'driver.manage', actor: U.ADM1, venue: null });
    });

    it('lists newest first for the owner and admins; supervisors and drivers are refused', async () => {
      const r = await t.get('/v1/admin/audit-log?action=ticket.void', 'ADM1');
      expect(r.status).toBe(200);
      expect(r.body.data.map((e: any) => e.id)).toEqual([rows.c, rows.a]);
      expect(r.body.meta.next_cursor).toBeNull();
      expect((await t.get('/v1/admin/audit-log', 'OWN1')).status).toBe(200);
      for (const who of ['SUP-R', 'DRV1'] as const) {
        const denied = await t.get('/v1/admin/audit-log', who);
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      }
    });

    it('filters by entity, actor, action, venue and time range', async () => {
      const q = async (qs: string) =>
        (await t.get(`/v1/admin/audit-log?${qs}`, 'ADM1')).body.data.map((e: any) => e.id) as number[];
      expect(await q(`entity_type=ticket&entity_id=${U.DRV1}`)).toEqual([rows.a]);
      expect(await q(`actor_id=${U['SUP-RL']}`)).toEqual([rows.c]);
      expect(await q(`venue_id=${RMS}&action=ticket.void`)).toEqual([rows.a]);
      expect(await q(`from=2026-10-27T10:30:00Z&to=2026-10-27T12:30:00Z`)).toEqual([rows.c, rows.b]);
    });

    it('never returns ip, user agent, phones or secrets', async () => {
      const r = await t.get(`/v1/admin/audit-log?action=ticket.reveal_phone`, 'ADM1');
      const e = r.body.data[0];
      expect(e).not.toHaveProperty('ip');
      expect(e).not.toHaveProperty('user_agent');
      expect(e.reason).toBe('customer asked to call 05•••••567 back');
      expect(e.before).toEqual({ phone: '[REDACTED]', status: 'open' });
      expect(e.metadata).toMatchObject({ code: '[REDACTED]', token: '[REDACTED]', count: 3 });
      expect(JSON.stringify(r.body)).not.toMatch(/0551234567|966551234567|123456|10\.1\.2\.3|secret-ua/);
    });

    it('pages with an opaque signed cursor; a tampered or foreign cursor is PAGINATION_CURSOR_INVALID', async () => {
      const first = await t.get('/v1/admin/audit-log?limit=2', 'ADM1');
      expect(first.body.data).toHaveLength(2);
      const cursor = first.body.meta.next_cursor as string;
      expect(cursor).toBeTruthy();
      const second = await t.get(`/v1/admin/audit-log?limit=2&cursor=${encodeURIComponent(cursor)}`, 'ADM1');
      expect(second.status).toBe(200);
      expect(second.body.data[0].id).toBeLessThan(first.body.data[1].id);
      for (const bad of [cursor.slice(0, -2) + 'aa', 'not-a-cursor']) {
        const r = await t.get(`/v1/admin/audit-log?cursor=${encodeURIComponent(bad)}`, 'ADM1');
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
      }
      // a cursor of another list
      const outboxCursor = (await t.get('/v1/admin/outbox?limit=1&status=done', 'ADM1')).body.meta
        .next_cursor;
      if (outboxCursor) {
        const r = await t.get(`/v1/admin/audit-log?cursor=${encodeURIComponent(outboxCursor)}`, 'ADM1');
        expect(r.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
      }
    });

    it('validates the query: VALIDATION_FAILED; a venue out of scope: SCOPE_VENUE_DENIED', async () => {
      for (const qs of [
        'entity_id=nope',
        'from=2026-10-27T12:00:00Z&to=2026-10-27T11:00:00Z',
        'limit=500',
        'unknown=1',
      ]) {
        const r = await t.get(`/v1/admin/audit-log?${qs}`, 'ADM1');
        expect(r.status, qs).toBe(422);
        expect(r.body.error.code).toBe('VALIDATION_FAILED');
      }
      const r = await t.get(`/v1/admin/audit-log?venue_id=${randomUUID()}`, 'ADM1');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('SCOPE_VENUE_DENIED');
    });

    it('reading the log is itself audited (09 §3)', async () => {
      await t.get(`/v1/admin/audit-log?action=driver.manage&limit=5`, 'OWN1');
      const a = await t.db.query(
        `SELECT actor_id, entity_type, metadata FROM audit_log WHERE action = 'audit.read' ORDER BY id DESC LIMIT 1`,
      );
      expect(a.rows[0]).toMatchObject({ actor_id: U.OWN1, entity_type: 'audit_log' });
      expect(a.rows[0].metadata).toMatchObject({
        filters: { action: 'driver.manage', limit: 5 },
        returned: 1,
      });
    });
  });

  describe('outbox administration (outbox.manage)', () => {
    const ins = async (o: {
      type: string;
      status: string;
      aggregate?: { type: string; id: string; version: number } | null;
      dedupe?: string | null;
      payload?: Record<string, unknown>;
      attempts?: number;
      availableAt?: string;
    }) =>
      (
        await t.db.query<{ id: string }>(
          `INSERT INTO outbox_events (org_id, type, status, aggregate_type, aggregate_id, aggregate_version, venue_id, dedupe_key,
                                      payload, attempts, available_at, created_at, processed_at, last_error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, CASE WHEN $3 IN ('done','dead','failed') THEN $11::timestamptz END,
                   CASE WHEN $3 IN ('dead','failed') THEN 'RetryableJobError: provider timeout' END)
           RETURNING id`,
          [
            ORG,
            o.type,
            o.status,
            o.aggregate?.type ?? null,
            o.aggregate?.id ?? null,
            o.aggregate?.version ?? null,
            RMS,
            o.dedupe ?? null,
            JSON.stringify(o.payload ?? {}),
            o.attempts ?? (o.status === 'dead' ? 8 : 1),
            o.availableAt ?? '2026-10-27T15:00:00Z',
          ],
        )
      ).rows[0]!.id;
    const retry = (id: string, as: 'ADM1' | 'OWN1' | 'SUP-R' = 'ADM1', key?: string) =>
      t.command('post', `/v1/admin/outbox/${id}/retry`, { as, key });

    it('lists stuck and failed rows with a redacted payload; filters by status and type', async () => {
      const dead = await ins({
        type: 'job.wa_send',
        status: 'dead',
        payload: { notification_id: randomUUID(), phone: '+966551234567', code: '123456' },
      });
      const failed = await ins({ type: 'job.push_send', status: 'failed' });
      const done = await ins({ type: 'job.push_send', status: 'done' });
      const all = await t.get('/v1/admin/outbox', 'ADM1');
      expect(all.status).toBe(200);
      const ids = all.body.data.map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining([dead, failed]));
      expect(ids).not.toContain(done); // default: pending, processing, failed, dead
      const d = all.body.data.find((e: any) => e.id === dead);
      expect(d.payload_preview).toMatchObject({ phone: '[REDACTED]', code: '[REDACTED]' });
      expect(d).toMatchObject({
        status: 'dead',
        attempts: 8,
        last_error: 'RetryableJobError: provider timeout',
      });
      expect(JSON.stringify(all.body)).not.toMatch(/966551234567|123456/);
      const onlyDead = await t.get('/v1/admin/outbox?status=dead', 'ADM1');
      expect(onlyDead.body.data.every((e: any) => e.status === 'dead')).toBe(true);
      const both = await t.get('/v1/admin/outbox?status=dead&status=failed&type=job.push_send', 'OWN1');
      expect(both.body.data.map((e: any) => e.id)).toEqual([failed]);
      const comma = await t.get('/v1/admin/outbox?status=done,failed&type=job.push_send', 'ADM1');
      expect(comma.body.data.map((e: any) => e.id).sort()).toEqual([failed, done].sort());
      const old = await t.get('/v1/admin/outbox?status=dead&older_than_s=7200', 'ADM1');
      expect(old.body.data).toEqual([]); // the rows are 1 hour old
      const bad = await t.get('/v1/admin/outbox?status=lost', 'ADM1');
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const page = await t.get('/v1/admin/outbox?limit=1', 'ADM1');
      const next = await t.get(
        `/v1/admin/outbox?limit=1&cursor=${encodeURIComponent(page.body.meta.next_cursor)}`,
        'ADM1',
      );
      expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
      const tampered = await t.get('/v1/admin/outbox?cursor=xyz', 'ADM1');
      expect(tampered.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
      expect((await t.get('/v1/admin/outbox', 'SUP-R')).body.error.code).toBe('PERMISSION_DENIED');
    });

    it('retry re-queues a dead row (attempts reset, due now), is audited and replays with the same key', async () => {
      const id = await ins({
        type: 'ticket.parked',
        status: 'dead',
        aggregate: { type: 'ticket', id: randomUUID(), version: 2 },
      });
      const key = newKey();
      const r = await retry(id, 'ADM1', key);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ id, status: 'pending', attempts: 0, processed_at: null });
      expect(r.body.data.available_at).toBe(t.clock.now().toISOString());
      const a = await t.db.query(
        `SELECT actor_id, entity_id, before, after, metadata FROM audit_log WHERE action = 'outbox.manage' AND entity_id = $1`,
        [id],
      );
      expect(a.rows[0]).toMatchObject({
        actor_id: U.ADM1,
        before: { status: 'dead', attempts: 8 },
        after: { status: 'pending', attempts: 0 },
        metadata: { command: 'retry', outcome: 'requeued', type: 'ticket.parked' },
      });
      const again = await retry(id, 'ADM1', key);
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.meta.replayed).toBe(true);
      // a pending row is not retried again: INVALID_STATE_TRANSITION
      const twice = await retry(id);
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(twice.body.error.details).toMatchObject({
        current_status: 'pending',
        allowed_from: ['failed', 'dead'],
      });
    });

    it('a job scheduled on an aggregate version that changed is not replayed: closed canceled (PNT-092 AC)', async () => {
      const ticket = (
        await t.db.query<{ id: string }>(
          `INSERT INTO tickets (org_id, venue_id, event_id, dispatch_pool_id, display_number, created_by, version)
           VALUES ($1, $2, $3, $4, 900, $5, 5) RETURNING id`,
          [ORG, RMS, SEED_IDS.events['EVT-R1'], SEED_IDS.pools['POOL-R'], U.DRV1],
        )
      ).rows[0]!.id;
      const stale = await ins({
        type: 'job.ready_uncollected_check',
        status: 'dead',
        aggregate: { type: 'ticket', id: ticket, version: 3 },
      });
      const current = await ins({
        type: 'job.ready_uncollected_check',
        status: 'failed',
        aggregate: { type: 'ticket', id: ticket, version: 5 },
      });
      const gone = await ins({
        type: 'job.offer_expire',
        status: 'dead',
        aggregate: { type: 'task_offer', id: randomUUID(), version: 1 },
      });
      const s = await retry(stale);
      expect(s.status).toBe(200);
      expect(s.body.data.status).toBe('canceled');
      expect(s.body.data.last_error).toMatch(
        /not replayed: ticket .* is at version 5, the job was scheduled on 3/,
      );
      const g = await retry(gone, 'OWN1');
      expect(g.body.data.status).toBe('canceled');
      const c = await retry(current);
      expect(c.body.data.status).toBe('pending');
      const audits = await t.db.query(
        `SELECT entity_id, metadata->>'outcome' AS outcome, metadata->>'current_version' AS v FROM audit_log
          WHERE action = 'outbox.manage' AND entity_id = ANY($1)`,
        [[stale, gone, current]],
      );
      const by = new Map(audits.rows.map((x) => [x.entity_id, x]));
      expect(by.get(stale)).toMatchObject({ outcome: 'canceled_stale', v: '5' });
      expect(by.get(gone)).toMatchObject({ outcome: 'canceled_stale', v: null });
      expect(by.get(current)).toMatchObject({ outcome: 'requeued' });
    });

    it('a job whose dedupe key already has a pending twin is closed canceled (uq_outbox_dedupe_pending)', async () => {
      const key = `dispatch_pass:${SEED_IDS.pools['POOL-R']}`;
      const dead = await ins({ type: 'job.dispatch_pass', status: 'dead', dedupe: key });
      await ins({
        type: 'job.dispatch_pass',
        status: 'pending',
        dedupe: key,
        availableAt: '2026-10-27T16:05:00Z',
      });
      const r = await retry(dead);
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('canceled');
    });

    it('unknown or malformed ids are RESOURCE_NOT_FOUND; the key is required; supervisors are refused', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const r = await retry(id);
        expect(r.status).toBe(404);
        expect(r.body.error).toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
          details: { resource: 'outbox_event' },
        });
      }
      const id = await ins({ type: 'job.push_send', status: 'failed' });
      const noKey = await t
        .http()
        .post(`/v1/admin/outbox/${id}/retry`)
        .set(CSRF)
        .set('Cookie', await t.sessionFor('ADM1'));
      expect(noKey.status).toBe(428);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const sup = await retry(id, 'SUP-R');
      expect(sup.body.error.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('retention policy (PNT-091)', () => {
    const body = {
      photos_days: 60,
      wa_messages_days: 120,
      tickets_months: 24,
      audit_months: 72,
      wa_raw_days: 3,
      analytics_months: 12,
    };

    it('GET shows the proposed defaults of canon §12, not yet approved (Q-06)', async () => {
      const r = await t.get('/v1/admin/retention-policy', 'ADM1');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({
        photos_days: 90,
        wa_messages_days: 180,
        tickets_months: 36,
        audit_months: 60,
        wa_raw_days: 7,
        analytics_months: 24,
        approved_by_owner: false,
        updated_at: null,
      });
      expect((await t.get('/v1/admin/retention-policy', 'SUP-R')).body.error.code).toBe('PERMISSION_DENIED');
    });

    it('PUT is the owner’s approval: stored in organizations.settings.retention, audited before/after, replayable', async () => {
      // other sections as /v1/admin/org-settings would have written them
      await t.db.query(
        `UPDATE organizations
            SET settings = jsonb_set(jsonb_set(settings, '{heartbeat}', '{"interval_s": 20, "uncertain_after_s": 50, "offline_after_s": 130}'),
                                     '{ops}', '{"outbox_lag_alert_s": 45}')
          WHERE id = $1`,
        [ORG],
      );
      const others = async () => {
        const { retention: _r, ...rest } = (
          await t.db.query(`SELECT settings FROM organizations WHERE id = $1`, [ORG])
        ).rows[0].settings;
        return rest;
      };
      const othersBefore = await others();
      expect(othersBefore.security.supervisor_mfa_required).toBe(false); // the harness turned it off
      const touchedBefore: Date = (
        await t.db.query(`SELECT updated_at FROM organizations WHERE id = $1`, [ORG])
      ).rows[0].updated_at;

      const key = newKey();
      const r = await t.command('put', '/v1/admin/retention-policy', { as: 'OWN1', body, key });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({
        ...body,
        approved_by_owner: true,
        updated_at: t.clock.now().toISOString(),
      });
      const stored = await t.db.query(`SELECT settings, updated_at FROM organizations WHERE id = $1`, [ORG]);
      expect(stored.rows[0].settings.retention).toEqual({ ...body, approved_by_owner: true });
      // the row's own stamp (trg_organizations_updated_at, database time)
      expect(stored.rows[0].updated_at.getTime()).toBeGreaterThan(touchedBefore.getTime());
      // only settings.retention changed: every other section is exactly as it was
      expect(await others()).toEqual(othersBefore);
      const a = await t.db.query(
        `SELECT actor_id, entity_type, entity_id, before, after FROM audit_log WHERE action = 'retention.manage' ORDER BY id DESC LIMIT 1`,
      );
      expect(a.rows[0]).toMatchObject({ actor_id: U.OWN1, entity_type: 'organization', entity_id: ORG });
      expect(a.rows[0].before.retention).toMatchObject({ photos_days: 90, approved_by_owner: false });
      expect(a.rows[0].after.retention).toEqual({ ...body, approved_by_owner: true });
      const replay = await t.command('put', '/v1/admin/retention-policy', { as: 'OWN1', body, key });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      t.clock.advanceSeconds(60);
      const g = await t.get('/v1/admin/retention-policy', 'ADM1');
      expect(g.body.data).toMatchObject({ ...body, approved_by_owner: true });
      expect(g.body.data.updated_at).toBe(new Date(t.clock.now().getTime() - 60_000).toISOString());
    });

    it('only the owner may change it; bounds, missing and extra keys are VALIDATION_FAILED', async () => {
      const admin = await t.command('put', '/v1/admin/retention-policy', { as: 'ADM1', body });
      expect(admin.status).toBe(403);
      expect(admin.body.error.code).toBe('PERMISSION_DENIED');
      const { photos_days: _p, ...missing } = body;
      for (const bad of [
        { ...body, photos_days: 0 },
        { ...body, audit_months: 1201 },
        { ...body, wa_raw_days: 2.5 },
        { ...body, analytics_months: '24' },
        { ...body, approved_by_owner: true },
        missing,
      ]) {
        const r = await t.command('put', '/v1/admin/retention-policy', { as: 'OWN1', body: bad });
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('VALIDATION_FAILED');
      }
    });
  });
});
