import { SEED_IDS, seed } from '@point/db/seed';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_SEVERITY,
  autoResolveAlerts,
  raiseAlert,
  raiseAlertForAffectedVenues,
} from '../src/core/alerts/alerts.js';
import { setupDb, type TestContext } from './helpers.js';

const ORG = SEED_IDS.org;
const RMS = SEED_IDS.venues.RMS;
const LYL = SEED_IDS.venues.LYL;
const b64 = (s: string) => Buffer.from(s.padEnd(32, '.')).toString('base64');

// Shared alert writer (14 §8, DEC-46) used by dispatch, whatsapp, monitoring and custody modules.
describe('core alerts', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupDb();
    const pool = new pg.Pool({ connectionString: t.testDb.url, max: 2 });
    try {
      await seed(pool, {
        env: 'test',
        nodeEnv: 'test',
        dataEncryptionKey: b64('data-key-for-tests'),
        dataEncryptionKeyId: 'test1',
        secretPepper: b64('auth-pepper-for-tests'),
      });
    } finally {
      await pool.end();
    }
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.db.query(`DELETE FROM alerts`);
    await t.db.query(`DELETE FROM outbox_events`);
  });

  const outbox = async (type: string) =>
    // the outbox row holds the event envelope (canon §7.1); the domain payload is nested
    (
      await t.db.query<{ payload: Record<string, unknown>; venue_id: string | null }>(
        `SELECT payload->'payload' AS payload, venue_id FROM outbox_events WHERE type = $1 ORDER BY seq`,
        [type],
      )
    ).rows;

  it('raises once per (venue, dedupe_key): a repeat replaces details and emits nothing new', async () => {
    const first = await t.db.transaction((tx) =>
      raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'request_unaccepted',
        dedupeKey: 'request_unaccepted:task-1',
        details: { waited_s: 120 },
      }),
    );
    expect(first.created).toBe(true);
    expect(first.alert.severity).toBe(ALERT_SEVERITY.request_unaccepted);
    expect(first.alert.status).toBe('open');

    const again = await t.db.transaction((tx) =>
      raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'request_unaccepted',
        dedupeKey: 'request_unaccepted:task-1',
        details: { waited_s: 240, attempts: 3 },
      }),
    );
    expect(again.created).toBe(false);
    expect(again.alert.id).toBe(first.alert.id);
    expect(again.alert.details).toEqual({ waited_s: 240, attempts: 3 });

    const live = await t.db.query(`SELECT count(*)::int AS n FROM alerts WHERE status <> 'resolved'`);
    expect(live.rows[0].n).toBe(1);
    const raised = await outbox('alert.raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.payload).toMatchObject({ alert_id: first.alert.id, severity: 'critical' });
  });

  it('the same key at another venue is a separate alert', async () => {
    await t.db.transaction(async (tx) => {
      await raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'wa_send_failed',
        dedupeKey: 'wa_send_failed:x',
      });
      await raiseAlert(tx, {
        orgId: ORG,
        venueId: LYL,
        type: 'wa_send_failed',
        dedupeKey: 'wa_send_failed:x',
      });
    });
    const r = await t.db.query(`SELECT venue_id FROM alerts ORDER BY venue_id`);
    expect(r.rows.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
  });

  it('multi-venue types write one row per venue with an open or closing event (DEC-46)', async () => {
    const venues = (
      await t.db.query<{ venue_id: string }>(
        `SELECT DISTINCT venue_id FROM events WHERE org_id = $1 AND status IN ('open','closing') ORDER BY venue_id`,
        [ORG],
      )
    ).rows.map((r) => r.venue_id);
    const rows = await t.db.transaction((tx) =>
      raiseAlertForAffectedVenues(tx, {
        orgId: ORG,
        type: 'wa_channel_down',
        dedupeKey: 'wa_channel_down',
        details: { status: 'down' },
      }),
    );
    expect(rows.map((r) => r.venue_id).sort()).toEqual(venues);
    expect(rows.every((r) => r.severity === 'critical')).toBe(true);
    expect(await outbox('alert.raised')).toHaveLength(venues.length);
  });

  it('an explicit venue list overrides the open-event lookup', async () => {
    const rows = await t.db.transaction((tx) =>
      raiseAlertForAffectedVenues(tx, {
        orgId: ORG,
        type: 'outbox_lag',
        dedupeKey: 'outbox_lag',
        venueIds: [LYL, LYL],
      }),
    );
    expect(rows.map((r) => r.venue_id)).toEqual([LYL]);
  });

  it('auto-resolve sets resolved_at without resolved_by and frees the dedupe slot', async () => {
    t.clock.set('2026-10-27T17:00:00.000Z');
    const { alert } = await t.db.transaction((tx) =>
      raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'no_drivers_on_duty',
        dedupeKey: 'no_drivers_on_duty:pool-r',
      }),
    );
    t.clock.set('2026-10-27T17:05:00.000Z');
    const resolved = await t.db.transaction((tx) =>
      autoResolveAlerts(tx, {
        orgId: ORG,
        dedupeKeys: ['no_drivers_on_duty:pool-r'],
        note: 'driver on duty',
      }),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.id).toBe(alert.id);
    expect(resolved[0]!.status).toBe('resolved');
    expect(resolved[0]!.resolved_by).toBeNull();
    expect(new Date(resolved[0]!.resolved_at!).toISOString()).toBe('2026-10-27T17:05:00.000Z');
    expect(resolved[0]!.resolution_note).toBe('driver on duty');
    const ev = await outbox('alert.resolved');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ alert_id: alert.id, auto: true, by: null });

    // the condition comes back: a fresh alert, not the resolved one
    const again = await t.db.transaction((tx) =>
      raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'no_drivers_on_duty',
        dedupeKey: 'no_drivers_on_duty:pool-r',
      }),
    );
    expect(again.created).toBe(true);
    expect(again.alert.id).not.toBe(alert.id);
  });

  it('auto-resolve can be limited to one venue and ignores an empty key list', async () => {
    await t.db.transaction(async (tx) => {
      await raiseAlert(tx, { orgId: ORG, venueId: RMS, type: 'task_stuck', dedupeKey: 'task_stuck:k' });
      await raiseAlert(tx, { orgId: ORG, venueId: LYL, type: 'task_stuck', dedupeKey: 'task_stuck:k' });
    });
    expect(await t.db.transaction((tx) => autoResolveAlerts(tx, { orgId: ORG, dedupeKeys: [] }))).toEqual([]);
    const r = await t.db.transaction((tx) =>
      autoResolveAlerts(tx, { orgId: ORG, dedupeKeys: ['task_stuck:k'], venueId: LYL }),
    );
    expect(r.map((a) => a.venue_id)).toEqual([LYL]);
    const live = await t.db.query(`SELECT venue_id FROM alerts WHERE status <> 'resolved'`);
    expect(live.rows.map((x) => x.venue_id)).toEqual([RMS]);
  });
});
