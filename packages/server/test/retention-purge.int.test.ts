import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from '@point/db/seed';
import {
  hasMediaObjectDeleter,
  registerMediaObjectDeleter,
  type MediaObjectDeleter,
} from '../src/core/hooks/media-objects.js';
import { OutboxDispatcher } from '../src/core/outbox/dispatcher.js';
import { InMemoryObjectStorage } from '../src/modules/media/infra/in-memory-object-storage.js';
import { deleterForStore } from '../src/core/hooks/media-objects.js';
import {
  RETENTION_STEPS,
  RetentionPurger,
  retentionPurgeJob,
  type PurgeRunResult,
} from '../src/modules/audit-monitoring/jobs/retention-purge.js';
import {
  ORG,
  RMS,
  U,
  insertEvent,
  insertIncident,
  insertMedia,
  insertMessage,
  insertNotification,
  insertTicket,
  openTransactions,
  seededDb,
} from './audit-monitoring-fixtures.js';
import { silentLogger, type TestContext } from './helpers.js';

const NOW = '2027-06-01T02:00:00.000Z';

const step = (r: PurgeRunResult, name: string) => {
  const s = r.steps.find((x) => x.step === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
};

/**
 * PNT-091 (retention half), TC-078: job.retention_purge — dry run lists the candidates only; the real run
 * applies 06 ERD §8.1 as the point_retention role, deletes storage objects outside any transaction through
 * the core seam, never touches held tickets (open incident on the ticket or its event, event not closed),
 * marks stale pending uploads failed (DEC-101) and audits every batch.
 */
describe('job.retention_purge', () => {
  let t: TestContext;
  let ids: Record<string, string>;
  let deleterCalls: { keys: string[]; openTx: number }[];
  let failKeys: Set<string>;

  const fakeDeleter: MediaObjectDeleter = async (keys) => {
    deleterCalls.push({ keys: [...keys], openTx: await openTransactions(t.db, t.testDb.name) });
    return {
      deleted: keys.filter((k) => !failKeys.has(k)),
      failed: keys.filter((k) => failKeys.has(k)).map((key) => ({ key, error: 'timeout' })),
    };
  };

  const purger = () => new RetentionPurger(t.db, t.clock, silentLogger, { mediaUploadUrlTtlS: 300 });
  const one = async <R extends QueryResultRow = any>(sql: string, params: unknown[] = []) =>
    (await t.db.query<R>(sql, params)).rows[0]!;

  beforeAll(async () => {
    t = await seededDb();
    t.clock.set(NOW);
    const closed = await insertEvent(t.db, { closedAt: '2026-01-02T00:00:00Z' });
    const oldClosed = await insertEvent(t.db, { closedAt: '2023-01-02T00:00:00Z' });
    const heldEvent = await insertEvent(t.db, { closedAt: '2026-01-02T00:00:00Z' });
    const T1 = await insertTicket(t.db, { eventId: closed });
    const T2 = await insertTicket(t.db, { eventId: closed });
    const T3 = await insertTicket(t.db, { eventId: closed });
    const T4 = await insertTicket(t.db, { eventId: SEED_IDS.events['EVT-R1'] }); // event still open
    const T5 = await insertTicket(t.db, {
      eventId: oldClosed,
      createdAt: '2023-01-01T18:00:00Z',
      submittedAt: '2023-01-01T18:02:00Z',
      deliveredAt: '2023-01-01T22:00:00Z',
    });
    const T6 = await insertTicket(t.db, { eventId: heldEvent });
    await insertIncident(t.db, { ticketId: T2, status: 'open' });
    await insertIncident(t.db, { ticketId: T3, status: 'resolved', resolvedAt: '2027-05-01T00:00:00Z' });
    await insertIncident(t.db, { eventId: heldEvent, status: 'in_review' });
    const P1 = await insertMedia(t.db, { ticketId: T1 });
    const P2 = await insertMedia(t.db, { ticketId: T2 });
    const P3 = await insertMedia(t.db, { ticketId: T3 });
    const P4 = await insertMedia(t.db, { ticketId: T4 });
    const P5 = await insertMedia(t.db, { ticketId: T5, createdAt: '2023-01-01T18:01:00Z' });
    const P6 = await insertMedia(t.db, { ticketId: T6 });
    const P7 = await insertMedia(t.db, {
      ticketId: T4,
      status: 'pending',
      key: `incoming/${ORG}/${T4}/stale`,
      createdAt: '2027-06-01T00:00:00Z',
      kind: 'photo_extra',
    });
    const P8 = await insertMedia(t.db, {
      ticketId: T4,
      status: 'pending',
      key: `incoming/${ORG}/${T4}/fresh`,
      createdAt: '2027-06-01T01:50:00Z',
      kind: 'photo_extra',
    });
    const N1 = await insertNotification(t.db, { ticketId: T1 });
    const M1 = await insertMessage(t.db, { ticketId: T1, notificationId: N1 });
    const M2 = await insertMessage(t.db, { ticketId: T2 });
    const M3 = await insertMessage(t.db, { ticketId: null, direction: 'inbound' });
    // custody note and inspection notes of the old ticket
    await t.db.query(
      `INSERT INTO custody_events (org_id, venue_id, ticket_id, subject, from_holder_type, to_holder_type, reason, actor_id, note, occurred_at)
       VALUES ($1, $2, $3, 'key', 'driver', 'key_slot', 'key_deposited', $4, 'left on the dashboard', '2023-01-01T18:10:00Z')`,
      [ORG, RMS, T5, U.DRV1],
    );
    await t.db.query(
      `INSERT INTO vehicle_inspections (org_id, ticket_id, kind, captured_by, notes, damage_marks)
       VALUES ($1, $2, 'intake', $3, 'dent', '[{"area":"front_left","note":"dent"}]')`,
      [ORG, T5, U.DRV1],
    );
    // a retrieval cycle + claim code of T1 with a leftover ciphertext
    const C1 = randomUUID();
    await t.db.query(
      `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source, requested_by_user_id,
                                     request_reason, outcome, closed_at, delivered_at)
       VALUES ($1, $2, $3, $4, 1, '2026-01-01T21:00:00Z', 'staff', $5, 'test', 'delivered', '2026-01-01T22:00:00Z', '2026-01-01T22:00:00Z')`,
      [C1, ORG, RMS, T1, U['SUP-R']],
    );
    const K1 = randomUUID();
    await t.db.query(
      `INSERT INTO claim_codes (id, org_id, ticket_id, cycle_id, code_hash, code_ciphertext, issued_at, expires_at, consumed_at, consumed_by)
       VALUES ($1, $2, $3, $4, 'h', 'test1:aaa:bbb:ccc', '2026-01-01T21:30:00Z', '2026-01-01T22:00:00Z', '2026-01-01T21:50:00Z', $5)`,
      [K1, ORG, T1, C1, U.DRV2],
    );
    // tokens and link codes
    const AT1 = randomUUID();
    const AT2 = randomUUID();
    await t.db.query(
      `INSERT INTO action_tokens (id, org_id, ticket_id, customer_id, token_hash, link_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'th1', 1, '2027-03-29T00:00:00Z', '2027-04-01T00:00:00Z'),
              ($5, $2, $6, $4, 'th2', 1, '2027-03-29T00:00:00Z', '2027-04-01T00:00:00Z')`,
      [AT1, ORG, T1, SEED_IDS.customers.CUS1, AT2, T2],
    );
    const L1 = randomUUID();
    await t.db.query(
      `INSERT INTO link_codes (id, org_id, ticket_id, code, status, created_by, created_at, expires_at, inbound_phone_e164)
       VALUES ($1, $2, $3, 'ABCDEF', 'expired', $4, '2027-05-01T00:00:00Z', '2027-05-01T00:10:00Z', '+966551234567')`,
      [L1, ORG, T1, U.DRV1],
    );
    // sessions, devices, alerts
    const S1 = randomUUID();
    await t.db.query(
      `INSERT INTO auth_sessions (id, org_id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, 'old-session-hash', '2027-03-01T00:00:00Z', '2027-03-01T00:00:00Z', '2027-03-02T00:00:00Z')`,
      [S1, ORG, U.DRV3],
    );
    const D1 = randomUUID();
    await t.db.query(
      `INSERT INTO devices (id, org_id, user_id, platform, push_endpoint, push_p256dh, push_auth, revoked_at)
       VALUES ($1, $2, $3, 'android', 'https://push.example/old', 'p', 'a', '2026-01-01T00:00:00Z')`,
      [D1, ORG, U.DRV3],
    );
    const AL1 = randomUUID();
    await t.db.query(
      `INSERT INTO alerts (id, org_id, venue_id, type, severity, status, dedupe_key, raised_at, resolved_at)
       VALUES ($1, $2, $3, 'task_stuck', 'warning', 'resolved', 'task_stuck:old', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')`,
      [AL1, ORG, RMS],
    );
    // idempotency keys
    await t.db.query(
      `INSERT INTO idempotency_keys (user_id, key, operation, request_hash, status, created_at, expires_at)
       VALUES ($1, 'expired-key-1', 'POST /x', 'h', 'completed', '2027-05-30T00:00:00Z', '2027-05-31T00:00:00Z'),
              ($1, 'live-key-0001', 'POST /x', 'h', 'completed', '2027-06-01T01:00:00Z', '2027-06-02T01:00:00Z')`,
      [U.DRV1],
    );
    // raw webhook deliveries
    const W1 = randomUUID();
    const W2 = randomUUID();
    const W3 = randomUUID();
    await t.db.query(
      `INSERT INTO whatsapp_inbound_events (id, org_id, received_at, signature_verified_at, body_sha256, raw_body, status)
       VALUES ($1, $4, '2027-05-20T00:00:00Z', '2027-05-20T00:00:00Z', 'sha-w1', '{"from":"966551234567"}', 'processed'),
              ($2, $4, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'sha-w2', '{"from":"966551234567"}', 'processed'),
              ($3, $4, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'sha-w3', '{"from":"966551234567"}', 'pending')`,
      [W1, W2, W3, ORG],
    );
    // analytics and audit
    await t.db.query(
      `INSERT INTO analytics_events (name, source, occurred_at, org_id, properties) VALUES
         ('ticket_parked', 'server', '2025-01-01T00:00:00Z', $1, '{"tag":"A1"}'),
         ('ticket_parked', 'server', '2026-01-01T00:00:00Z', $1, '{"tag":"A2"}')`,
      [ORG],
    );
    await t.db.query(
      `INSERT INTO audit_log (org_id, occurred_at, actor_type, action, reason) VALUES
         ($1, '2021-01-01T00:00:00Z', 'system', 'test.old', 'old-row'),
         ($1, '2026-01-01T00:00:00Z', 'system', 'test.recent', 'recent-row')`,
      [ORG],
    );
    // outbox rows
    const ob = async (status: string, processedAt: string) =>
      one<{ id: string }>(
        `INSERT INTO outbox_events (org_id, type, status, payload, available_at, created_at, processed_at)
         VALUES ($1, 'job.dispatch_pass', $2, '{}', $3, $3, $3) RETURNING id`,
        [ORG, status, processedAt],
      );
    const O1 = (await ob('done', '2027-05-01T00:00:00Z')).id;
    const O2 = (await ob('done', '2027-05-30T00:00:00Z')).id;
    const O3 = (await ob('dead', '2027-01-01T00:00:00Z')).id;
    const O4 = (await ob('dead', '2027-05-20T00:00:00Z')).id;
    // exports
    const X1 = randomUUID();
    const X2 = randomUUID();
    await t.db.query(
      `INSERT INTO exports (id, org_id, requested_by, kind, status, storage_key, created_at, completed_at, expires_at) VALUES
         ($1, $3, $4, 'payments', 'ready', 'exports/x1.csv', '2027-05-30T00:00:00Z', '2027-05-30T00:01:00Z', '2027-05-31T00:01:00Z'),
         ($2, $3, $4, 'payments', 'expired', 'exports/x2.csv', '2027-01-01T00:00:00Z', '2027-01-01T00:01:00Z', '2027-01-02T00:01:00Z')`,
      [X1, X2, ORG, U.ADM1],
    );
    ids = {
      T1,
      T2,
      T3,
      T4,
      T5,
      T6,
      P1: P1.id,
      P1key: P1.key,
      P2: P2.id,
      P3: P3.id,
      P4: P4.id,
      P5: P5.id,
      P5key: P5.key,
      P6: P6.id,
      P7: P7.id,
      P8: P8.id,
      N1,
      M1,
      M2,
      M3,
      K1,
      AT1,
      AT2,
      L1,
      S1,
      D1,
      AL1,
      W1,
      W2,
      W3,
      O1,
      O2,
      O3,
      O4,
      X1,
      X2,
    };
  });
  afterAll(async () => {
    registerMediaObjectDeleter(null, 'media');
    registerMediaObjectDeleter(null, 'exports');
    await t.close();
  });
  beforeEach(() => {
    deleterCalls = [];
    failKeys = new Set();
    registerMediaObjectDeleter(fakeDeleter, 'media');
    registerMediaObjectDeleter(fakeDeleter, 'exports');
  });

  it('dry run: counts the candidates of every step, changes nothing and audits the run (AC1)', async () => {
    const r = await purger().run(ORG, { dryRun: true, runId: 'dry-1' });
    expect(r.steps.map((s) => s.step)).toEqual(RETENTION_STEPS);
    expect(r.steps.filter((s) => s.skipped)).toEqual([]);
    expect(step(r, 'photos').candidates).toBe(2); // T1 and T5 only
    expect(step(r, 'stale_uploads').candidates).toBe(1);
    expect(step(r, 'tickets').candidates).toBe(1); // T5 (older than 36 months)
    expect(step(r, 'wa_messages').candidates).toBe(2); // M1 (T1) and M3 (no ticket); M2 is held
    expect(step(r, 'notifications').candidates).toBe(1);
    expect(step(r, 'idempotency_keys').candidates).toBe(1);
    expect(step(r, 'webhook_raw_bodies').candidates).toBe(2); // W1 and W2 (W3 is pending)
    expect(step(r, 'webhook_events').candidates).toBe(1);
    expect(step(r, 'analytics_events').candidates).toBe(1);
    expect(step(r, 'audit_log').candidates).toBe(1);
    expect(step(r, 'outbox_events').candidates).toBe(2);
    expect(step(r, 'export_files').candidates).toBe(1);
    expect(step(r, 'export_rows').candidates).toBe(1);
    expect(step(r, 'action_tokens').candidates).toBe(1); // AT2 belongs to the held T2
    expect(r.steps.every((s) => s.applied === 0)).toBe(true);
    expect(deleterCalls).toEqual([]);
    const p1 = await one(`SELECT upload_status FROM media_assets WHERE id = $1`, [ids.P1]);
    expect(p1.upload_status).toBe('uploaded');
    const summary = await one(
      `SELECT actor_type, entity_type, entity_id, metadata FROM audit_log
        WHERE action = 'job.retention_purge' AND metadata->>'run_id' = 'dry-1'`,
    );
    expect(summary).toMatchObject({ actor_type: 'system', entity_type: 'organization', entity_id: ORG });
    expect(summary.metadata.dry_run).toBe(true);
    expect(summary.metadata.steps.find((s: any) => s.step === 'photos').candidates).toBe(2);
  });

  it('purges per 06 §8.1, holds what an open incident or an open event covers, audits every batch', async () => {
    const r = await purger().run(ORG, { runId: 'run-1' });
    expect(r.steps.filter((s) => s.skipped)).toEqual([]);

    // photos: objects deleted first, outside any transaction, then the rows marked
    expect(deleterCalls.map((c) => c.keys)).toContainEqual(expect.arrayContaining([ids.P1key, ids.P5key]));
    expect(deleterCalls.every((c) => c.openTx === 0)).toBe(true);
    // (the probe does see an open transaction)
    const probe = await t.db.pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1');
      expect(await openTransactions(t.db, t.testDb.name)).toBe(1);
    } finally {
      await probe.query('ROLLBACK');
      probe.release();
    }
    const media = async (id: string) =>
      one<{ upload_status: string; delete_reason: string | null; deleted_at: Date | null }>(
        `SELECT upload_status, delete_reason, deleted_at FROM media_assets WHERE id = $1`,
        [id],
      );
    for (const id of [ids.P1!, ids.P5!]) {
      const m = await media(id);
      expect(m.upload_status).toBe('deleted');
      expect(m.delete_reason).toBe('retention');
      expect(new Date(m.deleted_at!).toISOString()).toBe(NOW);
    }
    // TC-078: the open incident (T2), the recent incident resolution (T3), the open event (T4) and the
    // event-level incident (T6) keep their photos
    for (const id of [ids.P2!, ids.P3!, ids.P4!, ids.P6!])
      expect((await media(id)).upload_status).toBe('uploaded');
    // DEC-101: the stale pending upload is failed, the fresh one keeps its chance
    expect((await media(ids.P7!)).upload_status).toBe('failed');
    expect((await media(ids.P8!)).upload_status).toBe('pending');

    // messages: text and addresses redacted, the structure kept; the held ticket's message untouched
    const m1 = await one(`SELECT * FROM whatsapp_messages WHERE id = $1`, [ids.M1]);
    expect(m1).toMatchObject({
      body_redacted: null,
      payload_redacted: null,
      recipient_wa_id: null,
      status: 'delivered',
    });
    expect(m1.notification_id).toBeNull(); // N1 deleted
    const m2 = await one(`SELECT body_redacted, recipient_wa_id FROM whatsapp_messages WHERE id = $1`, [
      ids.M2,
    ]);
    expect(m2.recipient_wa_id).toBe('966551234567');
    expect(
      (await one(`SELECT sender_wa_id FROM whatsapp_messages WHERE id = $1`, [ids.M3])).sender_wa_id,
    ).toBeNull();
    expect((await t.db.query(`SELECT 1 FROM notifications WHERE id = $1`, [ids.N1])).rowCount).toBe(0);
    expect(
      (await t.db.query(`SELECT 1 FROM notification_attempts WHERE notification_id = $1`, [ids.N1])).rowCount,
    ).toBe(0);

    // tickets older than tickets_months anonymized, structure kept; younger ones untouched
    const t5 = await one(`SELECT * FROM tickets WHERE id = $1`, [ids.T5]);
    expect(t5).toMatchObject({
      plate_digits: null,
      plate_letters_ar: null,
      vehicle_make: null,
      vehicle_color: null,
      notes: null,
      key_tag: null,
      current_spot_note: null,
      customer_id: null,
      status: 'delivered',
      version: 2,
    });
    expect((await one(`SELECT plate_digits FROM tickets WHERE id = $1`, [ids.T1])).plate_digits).toBe('1234');
    expect((await one(`SELECT note FROM custody_events WHERE ticket_id = $1`, [ids.T5])).note).toBeNull();
    const insp = await one(`SELECT notes, damage_marks FROM vehicle_inspections WHERE ticket_id = $1`, [
      ids.T5,
    ]);
    expect(insp).toEqual({ notes: null, damage_marks: [] });

    // housekeeping rows
    const exists = async (sql: string, p: unknown[]) => ((await t.db.query(sql, p)).rowCount ?? 0) > 0;
    expect(await exists(`SELECT 1 FROM idempotency_keys WHERE key = 'expired-key-1'`, [])).toBe(false);
    expect(await exists(`SELECT 1 FROM idempotency_keys WHERE key = 'live-key-0001'`, [])).toBe(true);
    expect((await one(`SELECT raw_body FROM whatsapp_inbound_events WHERE id = $1`, [ids.W1])).raw_body).toBe(
      '',
    );
    expect(await exists(`SELECT 1 FROM whatsapp_inbound_events WHERE id = $1`, [ids.W2])).toBe(false);
    expect(
      (await one(`SELECT raw_body FROM whatsapp_inbound_events WHERE id = $1`, [ids.W3])).raw_body,
    ).not.toBe('');
    expect(await exists(`SELECT 1 FROM analytics_events WHERE properties->>'tag' = 'A1'`, [])).toBe(false);
    expect(await exists(`SELECT 1 FROM analytics_events WHERE properties->>'tag' = 'A2'`, [])).toBe(true);
    expect(await exists(`SELECT 1 FROM audit_log WHERE reason = 'old-row'`, [])).toBe(false);
    expect(await exists(`SELECT 1 FROM audit_log WHERE reason = 'recent-row'`, [])).toBe(true);
    expect(await exists(`SELECT 1 FROM outbox_events WHERE id = ANY($1)`, [[ids.O1, ids.O3]])).toBe(false);
    expect(
      (await t.db.query(`SELECT 1 FROM outbox_events WHERE id = ANY($1)`, [[ids.O2, ids.O4]])).rowCount,
    ).toBe(2);
    expect((await one(`SELECT status FROM exports WHERE id = $1`, [ids.X1])).status).toBe('expired');
    expect(deleterCalls.map((c) => c.keys)).toContainEqual(['exports/x1.csv']);
    expect(await exists(`SELECT 1 FROM exports WHERE id = $1`, [ids.X2])).toBe(false);
    expect(
      (await one(`SELECT code_ciphertext FROM claim_codes WHERE id = $1`, [ids.K1])).code_ciphertext,
    ).toBeNull();
    expect(await exists(`SELECT 1 FROM action_tokens WHERE id = $1`, [ids.AT1])).toBe(false);
    expect(await exists(`SELECT 1 FROM action_tokens WHERE id = $1`, [ids.AT2])).toBe(true);
    expect(await exists(`SELECT 1 FROM link_codes WHERE id = $1`, [ids.L1])).toBe(false);
    expect(await exists(`SELECT 1 FROM auth_sessions WHERE id = $1`, [ids.S1])).toBe(false);
    expect((await one(`SELECT push_endpoint FROM devices WHERE id = $1`, [ids.D1])).push_endpoint).toBeNull();
    expect(await exists(`SELECT 1 FROM alerts WHERE id = $1`, [ids.AL1])).toBe(false);

    // no silent deletes: one audit row per batch with its counts, and the run summary
    const batches = await t.db.query<{ entity_type: string; metadata: any }>(
      `SELECT entity_type, metadata FROM audit_log WHERE action = 'job.retention_purge' AND metadata->>'run_id' = 'run-1'
        AND metadata ? 'batch' ORDER BY id`,
    );
    const byStep = new Map(batches.rows.map((b) => [b.metadata.step, b]));
    expect(byStep.get('photos')).toMatchObject({
      entity_type: 'media_assets',
      metadata: { rows: 2, objects_deleted: 2 },
    });
    expect(byStep.get('tickets')).toMatchObject({
      entity_type: 'tickets',
      metadata: { rows: 1, action: 'anonymize' },
    });
    expect(byStep.get('audit_log')?.metadata.rows).toBe(1);
    const summary = await one(
      `SELECT metadata FROM audit_log WHERE action = 'job.retention_purge' AND metadata->>'run_id' = 'run-1'
        AND entity_type = 'organization'`,
    );
    expect(summary.metadata.dry_run).toBe(false);
    expect(summary.metadata.steps.find((s: any) => s.step === 'photos')).toMatchObject({
      candidates: 2,
      applied: 2,
    });

    // a second run finds nothing left (idempotent)
    deleterCalls = [];
    const again = await purger().run(ORG, { runId: 'run-2' });
    expect(again.steps.filter((s) => s.applied > 0)).toEqual([]);
    expect(deleterCalls).toEqual([]);
  });

  it('a storage failure keeps the row for the next run; no deleter registered skips the step (no silent marking)', async () => {
    const T = await insertTicket(t.db, {
      eventId: await insertEvent(t.db, { closedAt: '2026-01-02T00:00:00Z' }),
    });
    const ok = await insertMedia(t.db, { ticketId: T });
    const bad = await insertMedia(t.db, { ticketId: T, kind: 'photo_rear' });

    registerMediaObjectDeleter(null, 'media');
    expect(hasMediaObjectDeleter('media')).toBe(false);
    const skipped = await purger().run(ORG, { runId: 'run-no-deleter' });
    expect(step(skipped, 'photos')).toMatchObject({
      skipped: 'no_object_deleter',
      candidates: 2,
      applied: 0,
    });
    const status = async (id: string) =>
      (await one(`SELECT upload_status FROM media_assets WHERE id = $1`, [id])).upload_status;
    expect(await status(ok.id)).toBe('uploaded');

    registerMediaObjectDeleter(fakeDeleter, 'media');
    failKeys = new Set([bad.key]);
    const partial = await purger().run(ORG, { runId: 'run-partial' });
    expect(step(partial, 'photos')).toMatchObject({ applied: 1, failed: 1 });
    expect(await status(ok.id)).toBe('deleted');
    expect(await status(bad.id)).toBe('uploaded');

    failKeys = new Set();
    const retried = await purger().run(ORG, { runId: 'run-retry' });
    expect(step(retried, 'photos')).toMatchObject({ applied: 1, failed: 0 });
    expect(await status(bad.id)).toBe('deleted');
  });

  it('deletes the objects of the media storage through deleterForStore (in-memory bucket)', async () => {
    const storage = new InMemoryObjectStorage({ clock: t.clock, bucket: 'point-media' });
    const T = await insertTicket(t.db, {
      eventId: await insertEvent(t.db, { closedAt: '2026-01-02T00:00:00Z' }),
    });
    const p = await insertMedia(t.db, { ticketId: T });
    const keep = await insertMedia(t.db, { ticketId: ids.T2!, kind: 'photo_left' }); // held ticket
    storage.plant(p.key, Buffer.from('jpeg'), 'image/jpeg');
    storage.plant(keep.key, Buffer.from('jpeg'), 'image/jpeg');
    registerMediaObjectDeleter(deleterForStore(storage), 'media');
    await purger().run(ORG, { runId: 'run-memory' });
    expect(storage.keys()).toEqual([keep.key]);
  });

  it('as a job: runs every organization, plans the next day (retention:<date>) and a dry run does not', async () => {
    const dispatcher = new OutboxDispatcher(t.db, t.clock, silentLogger).register(
      retentionPurgeJob({ cron: '0 2 * * *' }),
    );
    await t.db.query(
      `INSERT INTO outbox_events (org_id, type, dedupe_key, payload, available_at)
       VALUES ($1, 'job.retention_purge', 'retention:2027-06-01', '{"scope":"all"}', $2)`,
      [ORG, NOW],
    );
    await dispatcher.drain();
    const rows = await t.db.query<{ status: string; dedupe_key: string; available_at: Date }>(
      `SELECT status, dedupe_key, available_at FROM outbox_events WHERE type = 'job.retention_purge' ORDER BY seq`,
    );
    expect(rows.rows.map((r) => [r.status, r.dedupe_key])).toEqual([
      ['done', 'retention:2027-06-01'],
      ['pending', 'retention:2027-06-02'],
    ]);
    expect(new Date(rows.rows[1]!.available_at).toISOString()).toBe('2027-06-02T02:00:00.000Z');

    await t.db.query(
      `INSERT INTO outbox_events (org_id, type, payload, available_at) VALUES ($1, 'job.retention_purge', '{"scope":"all","dry_run":true}', $2)`,
      [ORG, NOW],
    );
    await dispatcher.drain();
    const pending = await t.db.query(
      `SELECT 1 FROM outbox_events WHERE type = 'job.retention_purge' AND status = 'pending'`,
    );
    expect(pending.rowCount).toBe(1); // still only tomorrow's run
    const dry = await one(
      `SELECT metadata FROM audit_log WHERE action = 'job.retention_purge' AND entity_type = 'organization'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(dry.metadata.dry_run).toBe(true);
  });

  it('point_retention holds exactly the purge privileges; point_app still cannot delete the audit log', async () => {
    const c = await t.db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE point_app');
      await expect(c.query(`DELETE FROM audit_log WHERE false`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE point_retention');
      for (const table of [
        'audit_log',
        'analytics_events',
        'outbox_events',
        'notifications',
        'exports',
        'alerts',
      ])
        await c.query(`DELETE FROM ${table} WHERE false`);
      await c.query(`UPDATE custody_events SET note = NULL WHERE false`);
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE custody_events SET reason = 'parked' WHERE false`)).rejects.toThrow(
        /permission denied/,
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(c.query(`DELETE FROM ticket_events WHERE false`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
});
