import { SEED_IDS } from '@point/db/seed';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/core/metrics/metrics.js';
import { SystemMonitor } from '../src/modules/audit-monitoring/jobs/system-monitor.js';
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
    expect(r.quota).toEqual({ raised: [], resolved: [] });
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

    // the month changes (midnight in Riyadh): the count starts again and the live alert resolves by itself
    t.clock.set('2026-10-31T21:00:05.000Z');
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

    // the business is verified: 2,000 a day — the condition ends
    await setTier('TIER_2K');
    r = await monitor.tick();
    expect(r.quota.resolved.map((x) => x.venue_id)).toEqual([RMS, LYL].sort());
    expect(await quotaAlerts()).toEqual([]);

    // an unlimited tier never alerts
    await setTier('TIER_UNLIMITED');
    expect((await monitor.tick()).quota.raised).toEqual([]);

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

    // the 24 h window slides past the first 199 sends: under the threshold, resolved by itself
    t.clock.set(at(T0, 23 * 3600 + 1));
    r = await monitor.tick();
    expect(r.quota.resolved).toHaveLength(2);
    expect(await quotaAlerts()).toEqual([]);
    expect(await gauge(metrics.waUniqueUsers24h)).toBe(1);
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
});
