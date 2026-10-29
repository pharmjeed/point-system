import { SEED_IDS } from '@point/db/seed';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/core/clock/clock.js';
import { Database } from '../src/core/db/database.js';
import { createLogger } from '../src/core/logging/logger.js';
import { metrics } from '../src/core/metrics/metrics.js';
import { emitEvent } from '../src/core/outbox/outbox-writer.js';
import { SystemMonitor, type QuotaReport } from '../src/modules/audit-monitoring/jobs/system-monitor.js';
import { LYL, ORG, RMS, U, seededDb } from './audit-monitoring-fixtures.js';
import { silentLogger, type TestContext } from './helpers.js';

const T0 = '2026-10-27T16:00:00.000Z'; // 19:00 in Riyadh, October
const CH = SEED_IDS.whatsappChannel;
const SERVICE_KEY = (month: string) => `wa_send_failed:service_messages_month:${CH}:${month}`;
const LIMIT_KEY = `wa_send_failed:unique_users_24h:${CH}`;

const at = (iso: string, offsetS = 0) => new Date(new Date(iso).getTime() + offsetS * 1000);

/**
 * GAP-9 (12 §13, F-03, F-18; 05 §12.2): the SystemMonitor computes `point_wa_service_messages_month` and
 * `point_wa_unique_users_24h_outside_window` from whatsapp_messages and raises/resolves their alerts.
 */
describe('SystemMonitor — WhatsApp quotas (GAP-9)', () => {
  let t: TestContext;
  let monitor: SystemMonitor;
  let phoneSeq = 0;

  /** customers with phones of their own (+9665900xxxxx: no seeded customer uses that range) */
  const customers = async (n: number): Promise<string[]> => {
    const from = phoneSeq + 1;
    phoneSeq += n;
    const r = await t.db.query<{ id: string }>(
      `INSERT INTO customers (org_id, phone_e164, wa_id)
       SELECT $1, '+9665900' || lpad(g::text, 5, '0'), '9665900' || lpad(g::text, 5, '0') FROM generate_series($2::int, $3::int) g
       RETURNING id`,
      [ORG, from, phoneSeq],
    );
    return r.rows.map((x) => x.id);
  };

  /** outbound rows as the sender writes them: accepted (wamid) unless `accepted: false` */
  const outbound = async (o: {
    kind: 'template' | 'session_text';
    customerIds: string[];
    queuedAt: Date;
    status?: string;
    accepted?: boolean;
    channelId?: string;
  }) => {
    const accepted = o.accepted ?? true;
    const status = o.status ?? (accepted ? 'delivered' : 'queued');
    await t.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, wa_message_id, customer_id, kind, purpose, status,
                                      status_rank, queued_at, created_at)
       SELECT $1, $2, 'outbound', CASE WHEN $3 THEN 'wamid.' || gen_random_uuid() END, c.id, $4,
              CASE WHEN $4 = 'template' THEN 'W-01' ELSE 'W-09' END, $5, CASE WHEN $5 = 'delivered' THEN 2 ELSE 0 END,
              CASE WHEN $3 THEN $6::timestamptz END, $6
         FROM unnest($7::uuid[]) AS c(id)`,
      [ORG, o.channelId ?? CH, accepted, o.kind, status, o.queuedAt, o.customerIds],
    );
  };
  /** `n` accepted service messages to one customer, a second apart from `from` */
  const serviceMessages = async (n: number, from: Date, customerId: string = SEED_IDS.customers.CUS1) =>
    t.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, wa_message_id, customer_id, kind, purpose, status,
                                      status_rank, queued_at, created_at)
       SELECT $1, $2, 'outbound', 'wamid.' || gen_random_uuid(), $3, 'session_text', 'W-09', 'delivered', 2,
              $4::timestamptz + g * interval '1 second', $4
         FROM generate_series(1, $5::int) g`,
      [ORG, CH, customerId, from, n],
    );
  const inbound = (customerId: string, receivedAt: Date) =>
    t.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, wa_message_id, customer_id, kind, status,
                                      received_at, created_at)
       VALUES ($1, $2, 'inbound', $3, $4, 'inbound_text', 'received', $5, $5)`,
      [ORG, CH, `wamid.in.${randomUUID()}`, customerId, receivedAt],
    );
  const quotaAlerts = async (status: 'live' | 'all' = 'live') =>
    (
      await t.db.query<{
        id: string;
        venue_id: string;
        dedupe_key: string;
        type: string;
        severity: string;
        status: string;
        ticket_id: string | null;
        details: any;
        resolved_by: string | null;
        resolution_note: string | null;
      }>(
        `SELECT id, venue_id, dedupe_key, type, severity, status, ticket_id, details, resolved_by, resolution_note
           FROM alerts WHERE (starts_with(dedupe_key, 'wa_send_failed:service_messages_month:')
                           OR starts_with(dedupe_key, 'wa_send_failed:unique_users_24h:'))
          ${status === 'live' ? `AND status <> 'resolved'` : ''}
          ORDER BY dedupe_key, venue_id, raised_at`,
      )
    ).rows;
  const gauge = async (g: typeof metrics.waServiceMessagesMonth) => (await g.get()).values[0]?.value;
  /** the counts at the FakeClock's instant */
  const quota = () => t.db.transaction((tx) => monitor.waQuota(tx));
  const setTier = (tier: string | null) =>
    t.db.query(`UPDATE whatsapp_channel SET messaging_limit_tier = $2 WHERE id = $1`, [CH, tier]);
  /** the api and the worker tick in turn every 5 s; each decides at most once a minute on its own cadence */
  const alternate = async (
    first: SystemMonitor,
    second: SystemMonitor,
    seconds: number,
    onStep?: (s: number) => Promise<void>,
  ): Promise<QuotaReport[]> => {
    const reports: QuotaReport[] = [];
    for (let s = 0; s < seconds; s += 5) {
      await onStep?.(s);
      reports.push((await (s % 10 === 0 ? first : second).tick()).quota);
      t.clock.advanceSeconds(5);
    }
    return reports;
  };
  const quotaEvents = async (type: 'alert.raised' | 'alert.resolved') =>
    (
      await t.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events
          WHERE type = $1 AND payload->'payload'->>'type' = 'wa_send_failed'`,
        [type],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    t = await seededDb();
    monitor = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null, quotaRefreshMs: 0 });
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    t.clock.set(T0);
    await t.db.query(`DELETE FROM alerts`);
    await t.db.query(`DELETE FROM outbox_events`);
    await t.db.query(`DELETE FROM whatsapp_messages`);
    await setTier(null);
    await t.db.query(`UPDATE events SET status = 'open', closed_at = NULL WHERE id = ANY($1)`, [
      Object.values(SEED_IDS.events),
    ]);
  });

  it('point_wa_service_messages_month: session texts the provider accepted this month (Asia/Riyadh), per number', async () => {
    const [c1] = await customers(1);
    await serviceMessages(3, at('2026-10-27T10:00:00Z'), c1);
    await outbound({
      kind: 'session_text',
      customerIds: [c1!],
      queuedAt: at('2026-10-27T10:05:00Z'),
      status: 'failed',
    });
    await outbound({ kind: 'session_text', customerIds: [c1!], queuedAt: at(T0), accepted: false }); // never accepted
    await outbound({
      kind: 'session_text',
      customerIds: [c1!],
      queuedAt: at(T0),
      accepted: false,
      status: 'skipped',
    });
    await outbound({ kind: 'template', customerIds: [c1!], queuedAt: at('2026-10-27T10:00:00Z') }); // a template
    await inbound(c1!, at('2026-10-27T09:59:00Z'));
    // September 30, 23:00 in Riyadh: last month; 00:30 on October 1 in Riyadh (21:30 UTC on September 30): this month
    await serviceMessages(1, at('2026-09-30T19:59:59Z'), c1);
    await serviceMessages(1, at('2026-09-30T21:29:59Z'), c1);
    // a number the organization no longer uses keeps its own count (F-03 is per business number)
    const old = randomUUID();
    await t.db.query(
      `INSERT INTO whatsapp_channel (id, org_id, business_account_id, phone_number_id, access_token_secret_ref,
              app_secret_ref, verify_token_secret_ref, api_version, mode, is_active, health_status)
       VALUES ($1, $2, 'OLD-WABA', 'OLD-PHONE', 'env://X', 'env://Y', 'env://Z', 'v26.0', 'simulator', false, 'healthy')`,
      [old, ORG],
    );
    await outbound({
      kind: 'session_text',
      customerIds: [c1!],
      queuedAt: at('2026-10-27T11:00:00Z'),
      channelId: old,
    });

    const [snap] = await quota();
    expect(snap).toMatchObject({ orgId: ORG, channelId: CH, month: '2026-10', serviceMessagesMonth: 4 });
    await monitor.refreshGauges();
    expect(await gauge(metrics.waServiceMessagesMonth)).toBe(4);

    // the month changes at midnight in Riyadh: 21:00 UTC on October 31
    t.clock.set('2026-10-31T20:59:59.000Z');
    expect((await quota())[0]).toMatchObject({ month: '2026-10', serviceMessagesMonth: 4 });
    t.clock.set('2026-10-31T21:00:00.000Z');
    // the first one at 20:59:59 (October), the second at 21:00 (November)
    await serviceMessages(2, at('2026-10-31T20:59:58Z'), c1);
    expect((await quota())[0]).toMatchObject({ month: '2026-11', serviceMessagesMonth: 1 });
  });

  it('point_wa_unique_users_24h_outside_window: templates in the last 24 h to customers with no inbound message in the 24 h before', async () => {
    const [a, b, c, d, e, f, g, h] = await customers(8);
    const send = (ids: (string | undefined)[], q: Date, o: { status?: string; accepted?: boolean } = {}) =>
      outbound({ kind: 'template', customerIds: ids as string[], queuedAt: q, ...o });
    await send([a], at(T0, -3600)); // outside the window
    await send([a], at(T0, -1800)); // the same customer again: counted once
    await inbound(b!, at(T0, -3 * 3600));
    await send([b], at(T0, -2 * 3600)); // inside the window opened 1 h before: not counted
    await inbound(c!, at(T0, -26 * 3600));
    await send([c], at(T0, -3600)); // the window closed 25 h before the send: counted
    await send([d], at(T0, -3600));
    await inbound(d!, at(T0, -1800)); // a reply after the template does not change how it went out: counted
    await send([e], at(T0, -25 * 3600)); // older than the rolling 24 h: not counted
    await send([f], at(T0, -3600), { status: 'failed' }); // refused by the provider after acceptance: not counted
    await send([f], at(T0, -3600), { accepted: false }); // never accepted: not counted
    await outbound({ kind: 'session_text', customerIds: [g!], queuedAt: at(T0, -3600) }); // a service message
    await inbound(h!, at(T0, -25 * 3600));
    await send([h], at(T0, -3600)); // an inbound exactly 24 h before the send no longer opens the window: counted

    const [snap] = await quota();
    expect(snap!.uniqueUsers24hOutsideWindow).toBe(4); // a, c, d, h
    await monitor.refreshGauges();
    expect(await gauge(metrics.waUniqueUsers24h)).toBe(4);

    // the 24 h window slides: just under 23 h later every send of T0 − 1 h is still in it
    t.clock.set(at(T0, 23 * 3600 - 60));
    expect((await quota())[0]!.uniqueUsers24hOutsideWindow).toBe(4);
    // past 23 h the sends of T0 − 1 h have left; a's second send (T0 − 30 min) is still in
    t.clock.set(at(T0, 23 * 3600 + 1));
    expect((await quota())[0]!.uniqueUsers24hOutsideWindow).toBe(1);
  });

  it('AC (12 §13): 800 service messages raise wa_send_failed for each venue with an open event; a resolution holds for the month', async () => {
    await serviceMessages(799, at('2026-10-27T08:00:00Z'));
    let r = await monitor.tick();
    expect(r.quota).toEqual({ evaluated: true, raised: [], resolved: [] });
    expect(await quotaAlerts()).toEqual([]);

    await serviceMessages(1, at('2026-10-27T15:00:00Z'));
    r = await monitor.tick();
    expect(r.quota.raised).toEqual(
      [RMS, LYL].sort().map((venue_id) => ({ venue_id, dedupe_key: SERVICE_KEY('2026-10') })),
    );
    let live = await quotaAlerts();
    expect(live.map((a) => a.venue_id)).toEqual([RMS, LYL].sort()); // DEC-46: one row per affected venue
    for (const a of live) {
      expect(a).toMatchObject({
        type: 'wa_send_failed',
        severity: 'warning',
        status: 'open',
        ticket_id: null,
      });
      expect(a.details).toEqual({
        quota: 'service_messages_month',
        channel_id: CH,
        month: '2026-10',
        count: 800,
        threshold: 800,
        free_per_month: 1000,
      });
    }
    const raised = await t.db.query(
      `SELECT payload->'payload' AS p FROM outbox_events WHERE type = 'alert.raised' ORDER BY seq`,
    );
    expect(raised.rows.map((x) => x.p.type)).toEqual(['wa_send_failed', 'wa_send_failed']);
    expect(raised.rows.every((x) => x.p.ticket_id === null && x.p.severity === 'warning')).toBe(true);

    // the condition lasts: the details follow the count, no second row
    await serviceMessages(50, at('2026-10-27T15:10:00Z'));
    t.clock.advanceSeconds(10);
    r = await monitor.tick();
    expect(r.quota.raised).toEqual([]);
    live = await quotaAlerts();
    expect(live).toHaveLength(2);
    expect(live.map((a) => a.details.count)).toEqual([850, 850]);

    // a supervisor resolves it at RMS: not raised again there this month; LYL keeps its live row
    await t.db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = $3, resolved_by = $4, resolution_note = 'payment method added'
        WHERE venue_id = $1 AND dedupe_key = $2`,
      [RMS, SERVICE_KEY('2026-10'), t.clock.now(), U['SUP-R']],
    );
    t.clock.advanceSeconds(3600);
    r = await monitor.tick();
    expect(r.quota.raised).toEqual([]);
    expect((await quotaAlerts()).map((a) => a.venue_id)).toEqual([LYL]);

    // the month changes (midnight in Riyadh): the count starts again; the live alert resolves by itself once the
    // condition stayed false for two minutes (the instant it turned false is kept in the row)
    t.clock.set('2026-10-31T21:00:05.000Z');
    r = await monitor.tick();
    expect(r.quota).toEqual({ evaluated: true, raised: [], resolved: [] });
    expect((await quotaAlerts()).map((a) => [a.venue_id, a.details.below_since])).toEqual([
      [LYL, '2026-10-31T21:00:05.000Z'],
    ]);
    t.clock.set('2026-10-31T21:02:04.000Z');
    expect((await monitor.tick()).quota.resolved).toEqual([]);
    t.clock.set('2026-10-31T21:02:05.000Z');
    r = await monitor.tick();
    expect(r.quota.resolved).toEqual([{ venue_id: LYL, dedupe_key: SERVICE_KEY('2026-10') }]);
    expect(await quotaAlerts()).toEqual([]);
    const lyl = (await quotaAlerts('all')).find((a) => a.venue_id === LYL)!;
    expect(lyl).toMatchObject({ status: 'resolved', resolved_by: null });
    expect(lyl.resolution_note).toMatch(/12 §13/);
  });

  it('AC (12 §13): 80 % of the channel messaging limit raises the alert; it ends with the window, a higher or unlimited tier', async () => {
    await setTier('TIER_250');
    const ids = await customers(200);
    await outbound({ kind: 'template', customerIds: ids.slice(0, 199), queuedAt: at(T0, -3600) });
    let r = await monitor.tick();
    expect(r.quota.raised).toEqual([]);
    expect(await gauge(metrics.waUniqueUsers24h)).toBe(199);

    await outbound({ kind: 'template', customerIds: ids.slice(199), queuedAt: at(T0, -60) });
    r = await monitor.tick();
    expect(r.quota.raised.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
    let live = await quotaAlerts();
    expect(live.map((a) => a.dedupe_key)).toEqual([LIMIT_KEY, LIMIT_KEY]);
    expect(live[0]).toMatchObject({ type: 'wa_send_failed', severity: 'warning', ticket_id: null });
    expect(live[0]!.details).toEqual({
      quota: 'unique_users_24h_outside_window',
      channel_id: CH,
      count: 200,
      threshold: 200,
      limit: 250,
      limit_tier: 'TIER_250',
      limit_source: 'channel',
      window_h: 24,
    });

    // the business is verified: 2,000 a day — the condition ends; the rows resolve two minutes later
    await setTier('TIER_2K');
    r = await monitor.tick();
    expect(r.quota.resolved).toEqual([]);
    expect((await quotaAlerts()).map((a) => a.details.below_since)).toEqual([
      t.clock.now().toISOString(),
      t.clock.now().toISOString(),
    ]);
    t.clock.advanceSeconds(120);
    r = await monitor.tick();
    expect(r.quota.resolved.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
    expect(await quotaAlerts()).toEqual([]);

    // no limit stored on the channel: the F-18 starting limit is assumed (and said so)
    await setTier(null);
    r = await monitor.tick();
    expect(r.quota.raised).toHaveLength(2);
    live = await quotaAlerts();
    expect(live[0]!.details).toMatchObject({
      limit: 250,
      limit_tier: null,
      limit_source: 'assumed',
      threshold: 200,
    });

    // the limit becomes unlimited while the alert is live: it resolves, and an unlimited tier never alerts
    await setTier('TIER_UNLIMITED');
    expect((await monitor.tick()).quota).toEqual({ evaluated: true, raised: [], resolved: [] });
    t.clock.advanceSeconds(120);
    r = await monitor.tick();
    expect(r.quota.resolved.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
    t.clock.advanceSeconds(60);
    expect((await monitor.tick()).quota).toEqual({ evaluated: true, raised: [], resolved: [] });
    expect(await quotaAlerts()).toEqual([]);

    // the assumed limit again, then the 24 h window slides past the first 199 sends: under the threshold
    await setTier(null);
    expect((await monitor.tick()).quota.raised).toHaveLength(2);
    t.clock.set(at(T0, 23 * 3600 + 1));
    r = await monitor.tick();
    expect(r.quota.resolved).toEqual([]);
    expect(await gauge(metrics.waUniqueUsers24h)).toBe(1);
    t.clock.advanceSeconds(120);
    r = await monitor.tick();
    expect(r.quota.resolved).toHaveLength(2);
    expect(await quotaAlerts()).toEqual([]);
  });

  it('a condition that holds again inside the two minutes keeps its row (no second alert.raised)', async () => {
    await setTier('TIER_50'); // threshold 40
    const ids = await customers(40);
    await outbound({ kind: 'template', customerIds: ids, queuedAt: at(T0, -86_400 + 30) });
    await monitor.tick();
    const first = (await quotaAlerts()).map((a) => a.id);
    expect(first).toHaveLength(2);
    // 40 s later the 40 sends have left the 24 h window: false, the window starts
    t.clock.advanceSeconds(40);
    expect((await monitor.tick()).quota.resolved).toEqual([]);
    expect((await quotaAlerts()).every((a) => typeof a.details.below_since === 'string')).toBe(true);
    // the same 40 customers get a new template (a busy evening near the threshold): true again a minute later
    await outbound({ kind: 'template', customerIds: ids, queuedAt: at(t.clock.now().toISOString(), -5) });
    t.clock.advanceSeconds(60);
    const r = await monitor.tick();
    expect(r.quota).toEqual({ evaluated: true, raised: [], resolved: [] });
    const live = await quotaAlerts();
    expect(live.map((a) => a.id)).toEqual(first);
    expect(live.every((a) => a.details.below_since === undefined && a.details.count === 40)).toBe(true);
    expect(await quotaEvents('alert.raised')).toBe(2);
  });

  it('a resolved messaging-limit alert stays quiet for 24 h; venues without an open event get no row', async () => {
    await setTier('TIER_50'); // threshold 40
    const ids = await customers(80);
    await outbound({ kind: 'template', customerIds: ids.slice(0, 40), queuedAt: at(T0, -60) });
    await monitor.tick();
    expect((await quotaAlerts()).map((a) => a.venue_id)).toEqual([RMS, LYL].sort());
    await t.db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = $2, resolved_by = $3 WHERE venue_id = $1 AND status <> 'resolved'`,
      [RMS, t.clock.now(), U['SUP-R']],
    );
    t.clock.advanceSeconds(3600);
    await monitor.tick();
    expect((await quotaAlerts()).map((a) => a.venue_id)).toEqual([LYL]);

    // a day later a new crossing raises it again at RMS (and at LYL, whose row resolved when the window slid)
    t.clock.set(at(T0, 24 * 3600 + 60));
    let r = await monitor.tick();
    expect(r.quota.resolved).toEqual([]);
    t.clock.advanceSeconds(120);
    r = await monitor.tick();
    expect(r.quota.resolved).toEqual([{ venue_id: LYL, dedupe_key: LIMIT_KEY }]);
    await outbound({
      kind: 'template',
      customerIds: ids.slice(40),
      queuedAt: at(t.clock.now().toISOString(), -30),
    });
    r = await monitor.tick();
    expect(r.quota.raised.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());

    // no venue with an open or closing event: the gauges move, no alert row is created
    await t.db.query(`DELETE FROM alerts`);
    await t.db.query(`UPDATE events SET status = 'closed', closed_at = $1`, [t.clock.now()]);
    r = await monitor.tick();
    expect(r.quota.raised).toEqual([]);
    expect(await quotaAlerts()).toEqual([]);
    expect(await gauge(metrics.waUniqueUsers24h)).toBe(40);
  });

  it('each process recomputes the counts at most once per quotaRefreshMs (the gauges come from the snapshot)', async () => {
    const cached = new SystemMonitor(t.db, t.clock, silentLogger, {
      retentionCron: null,
      quotaRefreshMs: 60_000,
    });
    await serviceMessages(2, at(T0, -600));
    await cached.refreshGauges();
    expect(await gauge(metrics.waServiceMessagesMonth)).toBe(2);
    await serviceMessages(3, at(T0, -300));
    t.clock.advanceSeconds(59);
    await cached.refreshGauges();
    expect(await gauge(metrics.waServiceMessagesMonth)).toBe(2);
    t.clock.advanceSeconds(1);
    await cached.refreshGauges();
    expect(await gauge(metrics.waServiceMessagesMonth)).toBe(5);
  });

  it('two processes on the default cadence never undo each other: one row per venue and key, one resolution', async () => {
    const worker = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null });
    const api = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null });
    await setTier('TIER_250');
    await serviceMessages(799, at('2026-10-27T08:00:00Z'));
    const ids = await customers(200);
    await outbound({ kind: 'template', customerIds: ids.slice(0, 199), queuedAt: at(T0, -3600) });

    // between the two processes' first counts (the worker counted at 0 s, the api counts at 5 s): the 800th service
    // message and the 200th user outside the window — the worker's next decision must not undo the api's raise
    const up = await alternate(worker, api, 240, async (s) => {
      if (s !== 5) return;
      await serviceMessages(1, at(t.clock.now().toISOString(), -2)); // queued 1 s before the api counts
      await outbound({ kind: 'template', customerIds: ids.slice(199), queuedAt: t.clock.now() });
    });
    const decisions = up.filter((q) => q.evaluated).length;
    expect(decisions).toBeGreaterThanOrEqual(8); // both processes, every minute
    expect(decisions).toBeLessThanOrEqual(10);
    expect(up.flatMap((q) => q.resolved)).toEqual([]);
    expect(up.flatMap((q) => q.raised).map((x) => x.dedupe_key)).toEqual([
      ...[SERVICE_KEY('2026-10'), SERVICE_KEY('2026-10')],
      ...[LIMIT_KEY, LIMIT_KEY],
    ]);
    const venues = [RMS, LYL].sort();
    expect((await quotaAlerts('all')).map((a) => [a.dedupe_key, a.venue_id, a.status])).toEqual([
      ...venues.map((v) => [SERVICE_KEY('2026-10'), v, 'open']),
      ...venues.map((v) => [LIMIT_KEY, v, 'open']),
    ]);
    expect(await quotaEvents('alert.raised')).toBe(4);
    expect(await quotaEvents('alert.resolved')).toBe(0);

    // the 24 h window slides past the 199 sends: the limit alert resolves once per venue, the month's alert stays
    t.clock.set(at(T0, 23 * 3600 + 1));
    const down = await alternate(worker, api, 300);
    expect(down.flatMap((q) => q.raised)).toEqual([]);
    expect(down.flatMap((q) => q.resolved).map((x) => x.dedupe_key)).toEqual([LIMIT_KEY, LIMIT_KEY]);
    expect((await quotaAlerts('all')).map((a) => [a.dedupe_key, a.venue_id, a.status])).toEqual([
      ...venues.map((v) => [SERVICE_KEY('2026-10'), v, 'open']),
      ...venues.map((v) => [LIMIT_KEY, v, 'resolved']),
    ]);
    expect(await quotaEvents('alert.raised')).toBe(4);
    expect(await quotaEvents('alert.resolved')).toBe(2);
  });

  it('at midnight in Riyadh, processes whose clocks differ by 20 s resolve the ended month once and never raise it again', async () => {
    // the api's clock runs 20 s ahead of the worker's: it reaches November first
    const ahead: Clock = { now: () => new Date(t.clock.now().getTime() + 20_000) };
    const aheadDb = new Database({ connectionString: t.testDb.url, poolMax: 4 }, ahead);
    try {
      const worker = new SystemMonitor(t.db, t.clock, silentLogger, { retentionCron: null });
      const api = new SystemMonitor(aheadDb, ahead, silentLogger, { retentionCron: null });
      await serviceMessages(800, at('2026-10-31T08:00:00Z'));
      // the api decides at :45 (its clock :05), the worker at :50 — at 20:59:45 the api is in November, the worker
      // decides in October 5 s later
      t.clock.set('2026-10-31T20:57:45.000Z');
      const reports = await alternate(api, worker, 600);
      expect(reports.flatMap((q) => q.raised)).toEqual(
        [RMS, LYL].sort().map((venue_id) => ({ venue_id, dedupe_key: SERVICE_KEY('2026-10') })),
      );
      expect(reports.flatMap((q) => q.resolved).map((x) => x.dedupe_key)).toEqual([
        SERVICE_KEY('2026-10'),
        SERVICE_KEY('2026-10'),
      ]);
      const all = await quotaAlerts('all');
      expect(all.map((a) => [a.dedupe_key, a.status, a.resolved_by])).toEqual([
        [SERVICE_KEY('2026-10'), 'resolved', null],
        [SERVICE_KEY('2026-10'), 'resolved', null],
      ]);
      expect(await quotaEvents('alert.raised')).toBe(2);
      expect(await quotaEvents('alert.resolved')).toBe(2);
    } finally {
      await aheadDb.close();
    }
  });

  it("a live alert of a number no longer active resolves; the new number's key is raised while the condition holds", async () => {
    await setTier('TIER_50'); // threshold 40
    await outbound({ kind: 'template', customerIds: await customers(40), queuedAt: at(T0, -60) });
    await monitor.tick();
    expect((await quotaAlerts()).map((a) => a.dedupe_key)).toEqual([LIMIT_KEY, LIMIT_KEY]);
    const next = randomUUID();
    const nextKey = `wa_send_failed:unique_users_24h:${next}`;
    await t.db.query(`UPDATE whatsapp_channel SET is_active = false WHERE id = $1`, [CH]);
    try {
      await t.db.query(
        `INSERT INTO whatsapp_channel (id, org_id, business_account_id, phone_number_id, access_token_secret_ref,
                app_secret_ref, verify_token_secret_ref, api_version, mode, is_active, health_status, messaging_limit_tier)
         VALUES ($1, $2, 'NEW-WABA', 'NEW-PHONE', 'env://X', 'env://Y', 'env://Z', 'v26.0', 'simulator', true, 'healthy',
                 'TIER_50')`,
        [next, ORG],
      );
      // the limit is per business portfolio: the same 40 users count under the new number's key
      let r = await monitor.tick();
      expect(r.quota.raised.map((x) => x.dedupe_key)).toEqual([nextKey, nextKey]);
      expect(r.quota.resolved).toEqual([]);
      t.clock.advanceSeconds(120);
      r = await monitor.tick();
      expect(r.quota.resolved.map((x) => x.dedupe_key)).toEqual([LIMIT_KEY, LIMIT_KEY]);
      expect((await quotaAlerts()).map((a) => a.dedupe_key)).toEqual([nextKey, nextKey]);
    } finally {
      await t.db.query(`DELETE FROM whatsapp_channel WHERE id = $1`, [next]);
      await t.db.query(`UPDATE whatsapp_channel SET is_active = true WHERE id = $1`, [CH]);
    }
  });

  it('a failing quota count is logged and never rolls back the tick: outbox_lag is still raised', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', destination: { write: (l: string) => void lines.push(l) } });
    const failing = new SystemMonitor(t.db, t.clock, logger, { retentionCron: null, quotaRefreshMs: 0 });
    failing.waQuota = async () => {
      throw new Error('canceling statement due to statement timeout');
    };
    await t.db.transaction((tx) =>
      emitEvent(tx, {
        type: 'driver.enabled',
        orgId: ORG,
        aggregate: { type: 'user', id: U.DRV1, version: 1 },
        actor: { type: 'user', id: U.ADM1 },
        payload: { user_id: U.DRV1, enabled_by: U.ADM1 },
      }),
    );
    t.clock.advanceSeconds(60);
    const r = await failing.tick();
    expect(r.evaluated).toBe(true);
    expect(r.outbox[0]).toMatchObject({ lagging: true });
    expect(r.quota).toEqual({ evaluated: false, raised: [], resolved: [] });
    const lag = await t.db.query<{ venue_id: string }>(
      `SELECT venue_id FROM alerts WHERE type = 'outbox_lag' AND status <> 'resolved' ORDER BY venue_id`,
    );
    expect(lag.rows.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
    expect(lines.map((l) => JSON.parse(l).msg)).toContain('system monitor whatsapp quota failed');
  });

  it('a live quota row is rewritten only when its counts change', async () => {
    await serviceMessages(800, at('2026-10-27T08:00:00Z'));
    await monitor.tick();
    const rows = async () =>
      (
        await t.db.query<{ venue_id: string; v: string; count: number }>(
          `SELECT venue_id, xmin::text AS v, (details->>'count')::int AS count FROM alerts
            WHERE dedupe_key = $1 ORDER BY venue_id`,
          [SERVICE_KEY('2026-10')],
        )
      ).rows;
    const before = await rows();
    expect(before.map((x) => x.count)).toEqual([800, 800]);
    t.clock.advanceSeconds(10);
    expect((await monitor.tick()).quota.evaluated).toBe(true);
    expect(await rows()).toEqual(before);
    await serviceMessages(1, at(T0, 5));
    t.clock.advanceSeconds(10);
    await monitor.tick();
    const after = await rows();
    expect(after.map((x) => x.count)).toEqual([801, 801]);
    expect(after.map((x) => x.v)).not.toEqual(before.map((x) => x.v));
  });
});
