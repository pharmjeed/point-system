import { SEED_IDS } from '@point/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  err,
  EVT_L1,
  EVT_R1,
  EVT_R2,
  keyPickup,
  liveOffer,
  LYL,
  markReady,
  ok,
  one,
  paperTicketInParking,
  parkedPaperTicket,
  requestRetrieval,
  RMS,
  startDuty,
  startRetrieval,
  U,
} from './dispatch-fixtures.js';
import {
  CASH,
  cashHandover,
  deliver,
  FEE,
  onBreak,
  ORG,
  POS,
  reverse,
  waive,
  type ReadyTicket,
} from './payments-fixtures.js';

/**
 * PNT-088 (15 §10 KPI definitions, 07 §2.7): the event summary, drivers, payments and messages reports on a
 * scripted event whose durations are known, checked against the 15 reference SQL; scope rules of 09 §3.
 */

const DAY = { from: '2026-10-27T00:00:00+03:00', to: '2026-10-28T00:00:00+03:00' };
const qs = (q: Record<string, string | number | undefined>) =>
  Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

interface Durations {
  accept: number;
  start: number;
  ready: number;
  deliver: number;
}

describe('PNT-088 — reports', () => {
  let t: TestApp;
  const tickets: Record<string, ReadyTicket & { paymentId?: string }> = {};
  const messageIds: Record<string, string> = {};

  /** One retrieval by DRV1 with known durations (request → accept → start → ready → delivered). */
  async function timed(
    key: string,
    d: Durations,
    payment: unknown,
    opts: { waive?: boolean; wrongStub?: boolean } = {},
  ) {
    const p = await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 });
    const req = ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    t.clock.advanceSeconds(d.accept);
    ok(await accept(t, 'DRV1', (await liveOffer(t.db, U.DRV1))!.id));
    ok(await keyPickup(t, 'DRV1', req.task.id, p.slotId));
    t.clock.advanceSeconds(d.start);
    ok(await startRetrieval(t, 'DRV1', req.task.id));
    t.clock.advanceSeconds(d.ready);
    ok(await markReady(t, 'DRV1', req.task.id));
    const r: ReadyTicket = { ...p, retrieveTaskId: req.task.id, cycleId: req.cycle.id };
    if (opts.waive) ok(await waive(t, 'SUP-R', p.ticketId, { reason: 'خدمة مجاملة' }));
    if (opts.wrongStub)
      err(
        await t.command('post', `/v1/tickets/${p.ticketId}/handover`, {
          as: 'DRV1',
          body: { verification: { method: 'paper_stub', paper_serial: 'WRONG-9' } },
        }),
        'PAPER_STUB_MISMATCH',
      );
    t.clock.advanceSeconds(d.deliver);
    const done = ok(await deliver(t, 'DRV1', r, payment ?? undefined));
    tickets[key] = { ...r, paymentId: done.payment?.id };
  }

  async function message(key: string, m: Record<string, unknown>) {
    const r = await one(
      t.db,
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, kind, purpose, template_name, status, status_rank,
                                      error_code, error_title, body_redacted, recipient_wa_id, sender_wa_id, ticket_id,
                                      venue_id, event_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        ORG,
        SEED_IDS.whatsappChannel,
        m.direction ?? 'outbound',
        m.kind ?? 'template',
        m.purpose ?? 'W-05',
        m.template ?? 'masaf_ready_v1',
        m.status,
        m.rank ?? 0,
        m.error_code ?? null,
        m.error_title ?? null,
        m.body ?? null,
        m.direction === 'inbound' ? null : '966551234567',
        m.direction === 'inbound' ? '966551234567' : null,
        m.ticket ?? null,
        m.venue === undefined ? RMS : m.venue,
        m.event === undefined ? EVT_R2 : m.event,
        new Date(t.clock.now().getTime() - 60_000),
      ],
    );
    messageIds[key] = r.id;
  }

  beforeAll(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await onBreak(t, 'DRV2', true)); // every offer goes to DRV1
    await timed('t1', { accept: 5, start: 20, ready: 30, deliver: 40 }, CASH);
    await timed('t2', { accept: 10, start: 40, ready: 60, deliver: 80 }, POS('AP1'));
    await timed('t3', { accept: 15, start: 60, ready: 90, deliver: 120 }, null, {
      waive: true,
      wrongStub: true,
    });
    // t2: the reference is corrected (a reversal with replacement); t1's cash is handed over short (an incident)
    ok(
      await reverse(t, 'SUP-R', tickets.t2!.paymentId!, { reason: 'رقم إيصال خطأ', replacement: POS('AP2') }),
    );
    ok(await cashHandover(t, 'SUP-R', { event_id: EVT_R2, driver_id: U.DRV1, amount_halalas: 1000 }), 201);
    tickets.t4 = {
      ...(await parkedPaperTicket(t, 'DRV1', { eventId: EVT_R2 })),
      retrieveTaskId: '',
      cycleId: '',
    };
    const t5 = await paperTicketInParking(t, 'DRV1', { eventId: EVT_R2 });
    ok(
      await t.command('post', `/v1/tickets/${t5.ticketId}/void`, {
        as: 'SUP-R',
        body: { reason: 'تسجيل خاطئ', custody_returned_to_customer: true },
      }),
    );
    // a canceled cycle (the cancel route is S4's): it must stay out of the timings and be counted apart
    const now = t.clock.now().getTime();
    await t.db.query(
      `INSERT INTO retrieval_cycles (org_id, venue_id, ticket_id, cycle_no, requested_at, request_source, requested_by_user_id,
                                     request_reason, ready_at, canceled_at, canceled_by, cancel_reason, outcome, closed_at)
       SELECT org_id, venue_id, id, 2, $2, 'staff', $3, 'طلب ثانٍ', $4, $5, $3, 'العميل غادر', 'canceled', $5
         FROM tickets WHERE id = $1`,
      [
        tickets.t1!.ticketId,
        new Date(now - 7200_000),
        U['SUP-R'],
        new Date(now - 3600_000),
        new Date(now - 3500_000),
      ],
    );
    await message('sent', { status: 'sent', rank: 1, ticket: tickets.t1!.ticketId });
    await message('delivered', { status: 'delivered', rank: 2 });
    await message('read', { status: 'read', rank: 3 });
    await message('failed', {
      status: 'failed',
      error_code: '131026',
      error_title: 'Message undeliverable',
      body: 'سيارتك جاهزة، للاستفسار 0551234567',
    });
    await message('skipped', { status: 'skipped', purpose: 'W-08' });
    await message('inbound', {
      direction: 'inbound',
      kind: 'inbound_button',
      status: 'received',
      purpose: null,
      template: null,
    });
    await message('unplaced', {
      direction: 'inbound',
      kind: 'inbound_text',
      status: 'received',
      purpose: null,
      template: null,
      venue: null,
      event: null,
    });
    await message('lyl_failed', { status: 'failed', venue: LYL, event: EVT_L1, error_code: '131047' });
  });
  afterAll(async () => t.close());

  it('event summary: counts, KPI timings (canceled cycles apart), offers, messages, money, by driver — vs 15 SQL', async () => {
    const r = ok(await t.get(`/v1/reports/events/${EVT_R2}/summary`, 'SUP-R'));
    expect(r.event).toMatchObject({ id: EVT_R2, venue_id: RMS, status: 'open', pricing_mode: 'per_vehicle' });
    expect(r.counts).toEqual({
      tickets_total: 5,
      delivered: 3,
      voided: 1,
      open: 1,
      reparks: 0,
      canceled_requests: 1,
      whatsapp_linked: 0,
      paper: 4,
    });
    // durations scripted above: accept 5/10/15, start 20/40/60, request→ready 55/110/165, ready→delivered 40/80/120
    expect(r.timings_seconds).toEqual({
      accept: { p50: 10, p90: 14, max: 15 },
      start: { p50: 40, p90: 56, max: 60 },
      request_to_ready: { p50: 110, p90: 154, max: 165 },
      ready_to_delivered: { p50: 80, p90: 112, max: 120 },
    });
    // the reference queries of 15 (KPI-01, KPI-02, KPI-03/04) give the same values
    const kpi01 = await one(
      t.db,
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90
         FROM (SELECT EXTRACT(EPOCH FROM (t.claimed_at - t.queued_at)) AS s FROM tasks t
                WHERE t.event_id = $1 AND t.type = 'retrieve' AND t.claimed_at IS NOT NULL AND t.queued_at IS NOT NULL) x`,
      [EVT_R2],
    );
    expect([kpi01.p50, kpi01.p90]).toEqual([r.timings_seconds.accept.p50, r.timings_seconds.accept.p90]);
    const kpi02 = await one(
      t.db,
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.started_at - t.accepted_at))) AS p50
         FROM tasks t WHERE t.event_id = $1 AND t.type = 'retrieve' AND t.started_at IS NOT NULL`,
      [EVT_R2],
    );
    expect(kpi02.p50).toBe(r.timings_seconds.start.p50);
    const kpi03 = await one(
      t.db,
      `WITH c AS (SELECT rc.* FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id WHERE tk.event_id = $1)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at - requested_at)))
                FILTER (WHERE ready_at IS NOT NULL AND outcome IN ('delivered','reparked')) AS p50_rr,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at - requested_at)))
                FILTER (WHERE ready_at IS NOT NULL AND outcome IN ('delivered','reparked')) AS p90_rr,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - ready_at)))
                FILTER (WHERE outcome = 'delivered') AS p50_rd,
              count(*) FILTER (WHERE outcome = 'canceled')::int AS canceled_cycles
         FROM c`,
      [EVT_R2],
    );
    expect(kpi03).toEqual({
      p50_rr: r.timings_seconds.request_to_ready.p50,
      p90_rr: r.timings_seconds.request_to_ready.p90,
      p50_rd: r.timings_seconds.ready_to_delivered.p50,
      canceled_cycles: r.counts.canceled_requests,
    });
    expect(r.offers).toEqual({ single: 3, broadcast: 0, expired: 0, escalations: 0 });
    expect(r.messages).toEqual({ sent: 1, delivered: 1, read: 1, failed: 1, skipped: 1 });
    expect(r.payments).toEqual({ cash_halalas: FEE, pos_halalas: FEE, waived: 1, outstanding: 1 });
    expect(r.incidents).toEqual({ open: 1, resolved: 0 });
    expect(r.by_driver).toEqual([
      {
        driver: { id: U.DRV1, employee_code: 'D-0001', full_name: 'سائق 1' },
        parked: 4,
        retrieved: 3,
        delivered: 3,
        accept_p50_s: 10,
      },
    ]);
    // scope: another venue's event is 404; the owner sees every venue; drivers hold no report.read
    expect(
      err(await t.get(`/v1/reports/events/${EVT_L1}/summary`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404),
    ).toEqual({
      resource: 'event',
    });
    err(await t.get(`/v1/reports/events/zzz/summary`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404);
    err(await t.get(`/v1/reports/events/${EVT_R2}/summary`, 'DRV1'), 'PERMISSION_DENIED', 403);
    expect(ok(await t.get(`/v1/reports/events/${EVT_L1}/summary`, 'OWN1')).counts.tickets_total).toBe(0);
  });

  it('drivers: one row per driver and venue, counts in the period, keyset pages, SCOPE_VENUE_DENIED', async () => {
    const all = ok(await t.get(`/v1/reports/drivers?${qs(DAY)}`, 'SUP-R'));
    expect(all.map((x: { driver: { id: string } }) => x.driver.id)).toEqual([U.DRV1, U.DRV2]);
    const now = t.clock.now().getTime();
    const hours = async (user: string) => {
      const s = await one(t.db, `SELECT started_at FROM duty_sessions WHERE user_id = $1`, [user]);
      return Math.round(((now - new Date(s.started_at).getTime()) / 3600_000) * 100) / 100;
    };
    expect(all[0]).toEqual({
      driver: { id: U.DRV1, full_name: 'سائق 1', employee_code: 'D-0001' },
      venue_id: RMS,
      duty_hours: await hours(U.DRV1),
      parked: 4,
      retrieved: 3,
      delivered: 3,
      offers_received: 3,
      offers_expired: 0,
      accept_p50_s: 10,
      handover_code_failures: 1,
    });
    expect(all[1]).toMatchObject({
      driver: { id: U.DRV2, employee_code: 'D-0002' },
      duty_hours: await hours(U.DRV2),
      parked: 0,
      offers_received: 0,
      accept_p50_s: null,
    });

    // keyset pages of one row: the cursor carries the list scope (route + filters)
    const p1 = await t.get(`/v1/reports/drivers?${qs({ ...DAY, limit: 1 })}`, 'SUP-R');
    expect(p1.body.data.map((x: { driver: { id: string } }) => x.driver.id)).toEqual([U.DRV1]);
    const cursor = p1.body.meta.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    const p2 = await t.get(`/v1/reports/drivers?${qs({ ...DAY, limit: 1, cursor })}`, 'SUP-R');
    expect(p2.body.data.map((x: { driver: { id: string } }) => x.driver.id)).toEqual([U.DRV2]);
    expect(p2.body.meta.next_cursor).toBeNull();
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
    err(
      await t.get(`/v1/reports/drivers?${qs({ ...DAY, limit: 1, cursor: tampered })}`, 'SUP-R'),
      'PAGINATION_CURSOR_INVALID',
    );
    err(
      await t.get(
        `/v1/reports/drivers?${qs({ from: '2026-10-26T00:00:00+03:00', to: DAY.to, limit: 1, cursor })}`,
        'SUP-R',
      ),
      'PAGINATION_CURSOR_INVALID',
    );

    // a period with nothing in it, a reversed period, a venue outside the scope
    expect(
      ok(
        await t.get(
          `/v1/reports/drivers?${qs({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' })}`,
          'SUP-R',
        ),
      ),
    ).toEqual([]);
    expect(
      err(
        await t.get(`/v1/reports/drivers?${qs({ from: DAY.to, to: DAY.from })}`, 'SUP-R'),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'from', issue: 'after_to' }]);
    err(await t.get(`/v1/reports/drivers`, 'SUP-R'), 'VALIDATION_FAILED', 422);
    expect(
      err(
        await t.get(`/v1/reports/drivers?${qs({ ...DAY, venue_id: LYL })}`, 'SUP-R'),
        'SCOPE_VENUE_DENIED',
        403,
      ),
    ).toEqual({
      venue_id: LYL,
    });
    expect(ok(await t.get(`/v1/reports/drivers?${qs({ ...DAY, venue_id: LYL })}`, 'SUP-RL'))).toEqual([]);
  });

  it('payments: per event held in the period (Riyadh dates), reversals and waivers apart, event filter and scope', async () => {
    const r = ok(await t.get(`/v1/reports/payments?${qs(DAY)}`, 'SUP-R'));
    expect(r.from).toBe('2026-10-26T21:00:00.000Z');
    expect(r.to).toBe('2026-10-27T21:00:00.000Z');
    expect(r.rows).toEqual([
      {
        event_id: EVT_R1,
        event_name_ar: 'حفل تجريبي — ريماس 1',
        venue_id: RMS,
        cash_halalas: 0,
        pos_halalas: 0,
        waived: 0,
        reversed: 0,
        outstanding: 0,
      },
      {
        event_id: EVT_R2,
        event_name_ar: 'حفل تجريبي — ريماس 2',
        venue_id: RMS,
        cash_halalas: FEE,
        pos_halalas: FEE,
        waived: 1,
        reversed: 1,
        outstanding: 1,
      },
    ]);
    expect(r.totals).toEqual({ cash_halalas: FEE, pos_halalas: FEE, waived: 1, reversed: 1, outstanding: 1 });
    // the same numbers as the payments table (recorded only; the reversed record counted apart)
    const ref = await one(
      t.db,
      `SELECT coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'cash'), 0)::int AS cash,
              coalesce(sum(amount_halalas) FILTER (WHERE status = 'recorded' AND method = 'pos'), 0)::int AS pos,
              count(*) FILTER (WHERE status = 'reversed')::int AS reversed
         FROM payments WHERE event_id = $1`,
      [EVT_R2],
    );
    expect(ref).toEqual({
      cash: r.totals.cash_halalas,
      pos: r.totals.pos_halalas,
      reversed: r.totals.reversed,
    });

    expect(
      ok(await t.get(`/v1/reports/payments?${qs({ ...DAY, event_id: EVT_R2 })}`, 'SUP-R')).rows,
    ).toHaveLength(1);
    // 00:30 Riyadh on the 28th: the events of the 27th are outside although the UTC date is the 27th
    expect(
      ok(
        await t.get(
          `/v1/reports/payments?${qs({ from: '2026-10-27T21:30:00Z', to: '2026-10-28T20:00:00Z' })}`,
          'SUP-R',
        ),
      ).rows,
    ).toEqual([]);
    expect(
      ok(await t.get(`/v1/reports/payments?${qs(DAY)}`, 'OWN1')).rows.map(
        (x: { event_id: string }) => x.event_id,
      ),
    ).toEqual([EVT_R1, EVT_R2, EVT_L1]);
    expect(
      err(
        await t.get(`/v1/reports/payments?${qs({ ...DAY, event_id: EVT_L1 })}`, 'SUP-R'),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({
      resource: 'event',
    });
    err(
      await t.get(`/v1/reports/payments?${qs({ ...DAY, venue_id: LYL })}`, 'SUP-R'),
      'SCOPE_VENUE_DENIED',
      403,
    );
    err(await t.get(`/v1/reports/payments?${qs({ ...DAY, extra: 1 })}`, 'SUP-R'), 'VALIDATION_FAILED', 422);
  });

  it('messages: totals by status, the failed ones redacted, unplaced inbound for the organization only', async () => {
    const sup = await t.get(`/v1/reports/messages?${qs(DAY)}`, 'SUP-R');
    const r = sup.body.data;
    expect(r.totals).toEqual({
      queued: 0,
      sent: 1,
      delivered: 1,
      read: 1,
      failed: 1,
      skipped: 1,
      received: 1,
    });
    expect(r.failures).toEqual([
      expect.objectContaining({
        id: messageIds.failed,
        direction: 'outbound',
        status: 'failed',
        error_code: '131026',
        venue_id: RMS,
      }),
    ]);
    expect(r.failures[0].body_redacted).not.toContain('0551234567');
    // no recipient, sender or full phone anywhere in the answer (09 §5.1)
    expect(JSON.stringify(sup.body)).not.toMatch(/966551234567|0551234567/);

    const owner = ok(await t.get(`/v1/reports/messages?${qs(DAY)}`, 'OWN1'));
    expect(owner.totals).toMatchObject({ failed: 2, received: 2 });
    expect(owner.failures.map((m: { id: string }) => m.id).sort()).toEqual(
      [messageIds.failed, messageIds.lyl_failed].sort(),
    );
    expect(
      ok(await t.get(`/v1/reports/messages?${qs({ ...DAY, venue_id: RMS })}`, 'OWN1')).totals.received,
    ).toBe(1);

    const read = ok(await t.get(`/v1/reports/messages?${qs({ ...DAY, status: 'read' })}`, 'SUP-R'));
    expect(read.totals).toEqual({
      queued: 0,
      sent: 0,
      delivered: 0,
      read: 1,
      failed: 0,
      skipped: 0,
      received: 0,
    });
    expect(read.failures.map((m: { id: string }) => m.id)).toEqual([messageIds.read]);
    err(
      await t.get(`/v1/reports/messages?${qs({ ...DAY, status: 'bogus' })}`, 'SUP-R'),
      'VALIDATION_FAILED',
      422,
    );
    err(
      await t.get(`/v1/reports/messages?${qs({ ...DAY, venue_id: LYL })}`, 'SUP-R'),
      'SCOPE_VENUE_DENIED',
      403,
    );
    err(await t.get(`/v1/reports/messages?${qs(DAY)}`, 'DRV1'), 'PERMISSION_DENIED', 403);
  });
});
