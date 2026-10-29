import { createHash } from 'node:crypto';
import { OutboxDispatcher, WhatsappRuntime, whatsappJobs } from '@point/server';
import { renderWaText, waMessageText } from '@point/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUS1,
  LYL,
  ORG,
  RMS,
  createClaimCode,
  createCycle,
  createTask,
  createTicket,
  createWaTestApp,
  emit,
  notificationsOf,
  setTicket,
  silentLogger,
  type TicketFixture,
  type WaTestApp,
} from './wa-harness.js';

const TEMPLATE = {
  'W-01': 'masaf_ticket_issued_v1',
  'W-02': 'masaf_request_received_v1',
  'W-03': 'masaf_request_reserved_v1',
  'W-04': 'masaf_retrieval_started_v1',
  'W-05': 'masaf_vehicle_ready_v1',
  'W-07': 'masaf_request_canceled_v1',
} as const;

/** PNT-042 (job.wa_send) with the PNT-046 planner, end to end through the simulator. */
describe('WhatsApp sender (job.wa_send)', () => {
  let w: WaTestApp;
  beforeAll(async () => {
    w = await createWaTestApp();
    await w.syncTemplates();
  });
  afterAll(async () => w?.close());
  beforeEach(async () => {
    await w.sim.client.clearFaults();
    await w.db.query(
      `UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1 AND is_active`,
      [ORG],
    );
    w.rt.probes.clear();
    w.clock.advance(10 * 60_000); // fresh recipient buckets and throttles between tests
  });

  const sentFor = async (t: TicketFixture) =>
    (await w.sim.client.listMessages({ type: 'template' })).filter(
      (m) => m.bodyParams[m.purpose === 'W-01' ? 1 : 0] === String(t.displayNumber),
    );
  const newCustomer = async (phone: string) =>
    (
      await w.db.query<{ id: string }>(
        `INSERT INTO customers (org_id, phone_e164, wa_id) VALUES ($1, $2, $3) RETURNING id`,
        [ORG, phone, phone.slice(1)],
      )
    ).rows[0]!.id;
  const alerts = (ticketId: string) =>
    w.db.query(
      `SELECT type, dedupe_key, details, venue_id FROM alerts WHERE ticket_id = $1 ORDER BY raised_at`,
      [ticketId],
    );
  const attempts = (notificationId: string) =>
    w.db.query(
      `SELECT attempt_no, outcome, http_status, provider_error_code, started_at FROM notification_attempts
        WHERE notification_id = $1 ORDER BY attempt_no`,
      [notificationId],
    );
  const delivered = async (wamid: string) => {
    await w.sim.client.emitStatuses({ wamid, statuses: ['sent', 'delivered'], timestamp: w.ts() });
  };
  const health = async () =>
    (await w.db.query(`SELECT health_status FROM whatsapp_channel WHERE org_id = $1 AND is_active`, [ORG]))
      .rows[0].health_status as string;

  it('W-01 {{3}}: the make and colour stored as 02 §8.4 keys reach the customer as their Arabic labels (DEC-350)', async () => {
    const t = await createTicket(w, { status: 'parking', waLinkStatus: 'pending_send' });
    await w.db.query(`UPDATE tickets SET vehicle_make = 'toyota', vehicle_color = 'white' WHERE id = $1`, [
      t.id,
    ]);
    await emit(w, 'ticket.intake_submitted', t, {
      channel: 'whatsapp',
      inspection_status: 'complete',
      payment_status: 'not_required',
      wa_link_status: 'pending_send',
    });
    await w.flush();
    const [m] = await sentFor(t);
    expect(m!.bodyParams).toEqual(['قاعة ريماس', String(t.displayNumber), 'تويوتا كامري أبيض — لوحة 4821']);
  });

  it('W-01: one template with the «طلب السيارة» token, accepted → linked; only sha256(token) is stored', async () => {
    const t = await createTicket(w, { status: 'parking', waLinkStatus: 'pending_send' });
    await emit(w, 'ticket.intake_submitted', t, {
      channel: 'whatsapp',
      inspection_status: 'complete',
      payment_status: 'not_required',
      wa_link_status: 'pending_send',
    });
    await w.flush();
    const [m] = await sentFor(t);
    expect(m).toMatchObject({
      templateName: TEMPLATE['W-01'],
      to: '+966551234567',
      bodyParams: ['قاعة ريماس', String(t.displayNumber), 'تويوتا كامري بيضاء — لوحة 4821'],
    });
    expect(m!.buttons).toHaveLength(1);
    const token = m!.buttons[0]!.payload!;
    expect(token).toMatch(/^rq1\.[A-Za-z0-9_-]{22}$/);
    const ticket = (await w.db.query(`SELECT wa_link_status FROM tickets WHERE id = $1`, [t.id])).rows[0];
    expect(ticket.wa_link_status).toBe('linked');
    const tokens = (await w.db.query(`SELECT * FROM action_tokens WHERE ticket_id = $1`, [t.id])).rows;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      token_hash: createHash('sha256').update(token).digest('hex'),
      link_version: 1,
      customer_id: CUS1,
    });
    expect(new Date(tokens[0].expires_at).getTime() - new Date(tokens[0].created_at).getTime()).toBe(
      72 * 3_600_000,
    );
    const row = (
      await w.db.query(`SELECT * FROM whatsapp_messages WHERE ticket_id = $1 AND direction = 'outbound'`, [
        t.id,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      purpose: 'W-01',
      kind: 'template',
      status: 'queued',
      wa_message_id: m!.wamid,
    });
    expect(row.ordering_key).toBe(t.id);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row.payload_redacted)).toContain('[action_token]');
    const outbox = await w.db.query(`SELECT 1 FROM outbox_events WHERE payload::text LIKE $1`, [
      `%${token}%`,
    ]);
    expect(outbox.rowCount).toBe(0);
    const [n] = await notificationsOf(w, t.id);
    expect(n).toMatchObject({
      purpose: 'W-01',
      status: 'sent',
      attempts: 1,
      dedupe_key: `wa:W-01:${t.id}:lv1`,
    });
    expect((await attempts(n!.id)).rows).toEqual([
      expect.objectContaining({ attempt_no: 1, outcome: 'success', http_status: 200 }),
    ]);
  });

  it('W-01 to a number that is not on WhatsApp: the failed status → wa_link_status failed + wa_send_failed (TC-WA-20)', async () => {
    const customer = await newCustomer('+966555550000');
    const t = await createTicket(w, {
      customerId: customer,
      status: 'parking',
      waLinkStatus: 'pending_send',
    });
    await emit(w, 'ticket.intake_submitted', t, { channel: 'whatsapp', wa_link_status: 'pending_send' });
    await w.flush();
    const [m] = await sentFor(t);
    expect(
      (await w.db.query(`SELECT wa_link_status FROM tickets WHERE id = $1`, [t.id])).rows[0].wa_link_status,
    ).toBe('linked');
    await w.sim.client.emitStatuses({ wamid: m!.wamid, timestamp: w.ts() }); // the planned 131026 failure
    await w.flush();
    expect(
      (await w.db.query(`SELECT wa_link_status FROM tickets WHERE id = $1`, [t.id])).rows[0].wa_link_status,
    ).toBe('failed');
    const [n] = await notificationsOf(w, t.id);
    expect(n).toMatchObject({ status: 'failed', last_error_code: 'WA_SEND_FAILED' });
    const a = (await alerts(t.id)).rows;
    expect(a).toEqual([
      expect.objectContaining({
        type: 'wa_send_failed',
        dedupe_key: `wa_send_failed:${t.id}:W-01`,
        venue_id: RMS,
      }),
    ]);
    expect(JSON.stringify(a)).not.toContain('555550000');
    const msg = (
      await w.db.query(`SELECT status, error_code FROM whatsapp_messages WHERE wa_message_id = $1`, [
        m!.wamid,
      ])
    ).rows[0];
    expect(msg).toEqual({ status: 'failed', error_code: '131026' });
  });

  it('per-ticket order holds across retries: W-02 retried after a 5xx (≈1 s), W-03 only after it', async () => {
    const t = await createTicket(w, { status: 'requested' });
    const cycle = await createCycle(w, t);
    await w.sim.client.addFault({ httpStatus: 503, count: 1, match: { template: TEMPLATE['W-02'] } });
    await emit(w, 'ticket.retrieval_requested', t, { cycle_id: cycle, cycle_no: 1, requested_early: false });
    await w.drain(); // first attempt fails
    const task = await createTask(w, t, cycle, 'assigned_waiting');
    await emit(
      w,
      'ticket.assigned_waiting',
      t,
      { cycle_id: cycle, task_id: task, assignee_id: null, via: 'broadcast' },
      (tx) =>
        tx
          .query(`UPDATE tickets SET status = 'assigned_waiting' WHERE id = $1`, [t.id])
          .then(() => undefined),
    );
    await w.drain();
    expect(await sentFor(t)).toEqual([]); // W-03 waits behind W-02's retry
    await w.flush();
    const sent = await sentFor(t);
    expect(sent.map((m) => m.templateName)).toEqual([TEMPLATE['W-02'], TEMPLATE['W-03']]);
    const [n02] = await notificationsOf(w, t.id);
    const a = (await attempts(n02!.id)).rows;
    expect(a.map((x) => [x.attempt_no, x.outcome, x.http_status, x.provider_error_code])).toEqual([
      [1, 'retryable_error', 503, '2'], // a bare 5xx carries Graph code 2 (temporary)
      [2, 'success', 200, null],
    ]);
    const gap = new Date(a[1].started_at).getTime() - new Date(a[0].started_at).getTime();
    expect(gap).toBeGreaterThanOrEqual(800);
    expect(gap).toBeLessThanOrEqual(1200);
  });

  it('W-03 planned while waiting, then the drive starts: W-03 is skipped (superseded), W-04 is sent', async () => {
    const t = await createTicket(w, { status: 'assigned_waiting' });
    const cycle = await createCycle(w, t);
    const task = await createTask(w, t, cycle, 'assigned_waiting', '00000000-0000-4000-8000-000400000102');
    await emit(w, 'ticket.assigned_waiting', t, {
      cycle_id: cycle,
      task_id: task,
      assignee_id: null,
      via: 'broadcast',
    });
    await emit(
      w,
      'ticket.retrieving',
      t,
      { cycle_id: cycle, task_id: task, retrieved_by: null },
      async (tx) => {
        await tx.query(`UPDATE tasks SET status = 'in_progress', started_at = now() WHERE id = $1`, [task]);
        await tx.query(`UPDATE tickets SET status = 'retrieving' WHERE id = $1`, [t.id]);
      },
    );
    await w.flush();
    expect((await sentFor(t)).map((m) => m.templateName)).toEqual([TEMPLATE['W-04']]);
    expect((await notificationsOf(w, t.id)).map((n) => [n.purpose, n.status, n.skipped_reason])).toEqual([
      ['W-03', 'skipped', 'superseded'],
      ['W-04', 'sent', null],
    ]);
  });

  it('a permanent provider error: failed at once, attempt recorded, message failed, wa_send_failed raised', async () => {
    const t = await createTicket(w, { status: 'retrieving' });
    const cycle = await createCycle(w, t);
    await w.sim.client.addFault({ code: 131051, match: { template: TEMPLATE['W-04'] } });
    await emit(w, 'ticket.retrieving', t, { cycle_id: cycle, task_id: null, retrieved_by: null });
    await w.flush();
    const [n] = await notificationsOf(w, t.id);
    expect(n).toMatchObject({
      purpose: 'W-04',
      status: 'failed',
      attempts: 1,
      last_error_code: 'WA_SEND_FAILED',
    });
    expect((await attempts(n!.id)).rows).toEqual([
      expect.objectContaining({ attempt_no: 1, outcome: 'permanent_error', provider_error_code: '131051' }),
    ]);
    const msg = (await w.db.query(`SELECT * FROM whatsapp_messages WHERE notification_id = $1`, [n!.id]))
      .rows[0];
    expect(msg).toMatchObject({ status: 'failed', error_code: '131051', wa_message_id: null });
    expect((await alerts(t.id)).rows).toEqual([
      expect.objectContaining({
        type: 'wa_send_failed',
        dedupe_key: `wa_send_failed:${t.id}:W-04`,
        details: expect.objectContaining({
          purpose: 'W-04',
          error_code: 'WA_SEND_FAILED',
          provider_error_code: '131051',
        }),
      }),
    ]);
    const changed = await w.db.query(
      `SELECT payload->'payload' AS p FROM outbox_events WHERE type = 'wa.message_status_changed' AND payload->'payload'->>'notification_id' = $1`,
      [n!.id],
    );
    expect(changed.rows[0].p).toMatchObject({ status: 'failed', error_code: '131051', purpose: 'W-04' });
    const timeline = await w.db.query(
      `SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND type = 'wa.message_status_changed'`,
      [t.id],
    );
    expect(timeline.rowCount).toBe(1);
  });

  it('W-05: the code comes from claim_codes.code_ciphertext at send time, is masked in every row and purged after acceptance', async () => {
    const t = await createTicket(w, { status: 'ready' });
    const cycle = await createCycle(w, t);
    const claim = await createClaimCode(w, t, cycle, '482731');
    await emit(
      w,
      'handover.code_issued',
      null,
      { ticket_id: t.id, cycle_id: cycle, claim_code_id: claim, resend_no: 0 },
      undefined,
    );
    await w.flush();
    const [m] = await sentFor(t);
    expect(m).toMatchObject({
      templateName: TEMPLATE['W-05'],
      bodyParams: [String(t.displayNumber), '482731'],
    });
    const code = (
      await w.db.query(`SELECT code_ciphertext, sent_message_id FROM claim_codes WHERE id = $1`, [claim])
    ).rows[0];
    expect(code.code_ciphertext).toBeNull();
    const row = (await w.db.query(`SELECT * FROM whatsapp_messages WHERE id = $1`, [code.sent_message_id]))
      .rows[0];
    expect(row.body_redacted).toContain('رمز التسليم: ••••••');
    expect(JSON.stringify(row)).not.toContain('482731');
    // the code never stands alone in any row (uuids and timestamps only contain it next to other hex digits)
    for (const table of [
      'outbox_events',
      'notifications',
      'notification_attempts',
      'audit_log',
      'ticket_events',
    ])
      expect(
        (await w.db.query(`SELECT 1 FROM ${table} t WHERE t::text ~ '(^|[^0-9a-f])482731([^0-9a-f]|$)'`))
          .rowCount,
      ).toBe(0);
  });

  it('a template that is not approved is refused before any Graph call; W-05 falls back to a session text', async () => {
    const t = await createTicket(w, { status: 'retrieving' });
    const cycle = await createCycle(w, t);
    await w.db.query(`UPDATE whatsapp_templates SET status = 'paused' WHERE name IN ($1, $2)`, [
      TEMPLATE['W-04'],
      TEMPLATE['W-05'],
    ]);
    try {
      const before = (await w.sim.client.sendAttempts()).length;
      await emit(w, 'ticket.retrieving', t, { cycle_id: cycle, task_id: null, retrieved_by: null });
      await w.flush();
      expect((await w.sim.client.sendAttempts()).length).toBe(before);
      const [n] = await notificationsOf(w, t.id);
      expect(n).toMatchObject({
        purpose: 'W-04',
        status: 'failed',
        last_error_code: 'WA_TEMPLATE_NOT_APPROVED',
      });
      expect((await alerts(t.id)).rows[0]).toMatchObject({
        type: 'wa_send_failed',
        details: expect.objectContaining({ error_code: 'WA_TEMPLATE_NOT_APPROVED', reason: 'template' }),
      });

      // ready with the customer inside the 24 h window (they pressed the button): same content as session text (12 §8.4)
      await setTicket(w, t, { status: 'ready' });
      await w.db.query(`UPDATE customers SET last_inbound_at = $2 WHERE id = $1`, [
        CUS1,
        new Date(w.clock.now().getTime() - 3_600_000),
      ]);
      const claim = await createClaimCode(w, t, cycle, '907153');
      await emit(w, 'handover.code_issued', null, {
        ticket_id: t.id,
        cycle_id: cycle,
        claim_code_id: claim,
        resend_no: 0,
      });
      await w.flush();
      const text = (await w.sim.client.listMessages({ to: '+966551234567', type: 'text' })).at(-1);
      expect(text?.text).toBe(renderWaText(waMessageText('W-05'), [String(t.displayNumber), '907153']));
      const row = (
        await w.db.query(
          `SELECT kind, purpose, body_redacted FROM whatsapp_messages WHERE wa_message_id = $1`,
          [text!.wamid],
        )
      ).rows[0];
      expect(row).toMatchObject({ kind: 'session_text', purpose: 'W-05' });
      expect(row.body_redacted).not.toContain('907153');
    } finally {
      await w.db.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE name IN ($1, $2)`, [
        TEMPLATE['W-04'],
        TEMPLATE['W-05'],
      ]);
      await w.db.query(`UPDATE customers SET last_inbound_at = NULL WHERE id = $1`, [CUS1]);
    }
  });

  it('W-07 only when the customer was told about the cycle (W-02 created); otherwise nothing', async () => {
    const informed = await createTicket(w, { status: 'requested' });
    const c1 = await createCycle(w, informed);
    await emit(w, 'ticket.retrieval_requested', informed, {
      cycle_id: c1,
      cycle_no: 1,
      requested_early: false,
    });
    await w.flush();
    await delivered((await sentFor(informed))[0]!.wamid);
    await emit(
      w,
      'ticket.retrieval_canceled',
      informed,
      { cycle_id: c1, previous_status: 'requested' },
      async (tx) => {
        await tx.query(
          `UPDATE retrieval_cycles SET closed_at = now(), outcome = 'canceled', canceled_at = now() WHERE id = $1`,
          [c1],
        );
        await tx.query(`UPDATE tickets SET status = 'parked', active_cycle_id = NULL WHERE id = $1`, [
          informed.id,
        ]);
      },
    );
    await w.flush();
    expect((await sentFor(informed)).map((m) => m.templateName)).toEqual([
      TEMPLATE['W-02'],
      TEMPLATE['W-07'],
    ]);

    const silent = await createTicket(w, { status: 'requested' });
    const c2 = await createCycle(w, silent, { requestedEarly: true });
    await emit(w, 'ticket.retrieval_canceled', silent, { cycle_id: c2, previous_status: 'requested' });
    await w.flush();
    expect(await notificationsOf(w, silent.id)).toEqual([]);
  });

  /** A ticket in `retrieving` with its active cycle, and the `ticket.retrieving` event (→ W-04). */
  const retrieving = async (o: Parameters<typeof createTicket>[1] = {}) => {
    const t = await createTicket(w, { status: 'retrieving', ...o });
    const cycle = await createCycle(w, t, o.customerId ? { customerId: o.customerId } : {});
    return {
      t,
      emitW04: () => emit(w, 'ticket.retrieving', t, { cycle_id: cycle, task_id: null, retrieved_by: null }),
    };
  };

  it('paper tickets and unlinked tickets never get a message', async () => {
    const paper = await createTicket(w, {
      channel: 'paper',
      customerId: null,
      waLinkStatus: 'none',
      status: 'retrieving',
    });
    const failed = await retrieving({ waLinkStatus: 'failed' });
    await emit(w, 'ticket.retrieving', paper, {
      cycle_id: '0190d2a4-0000-7000-8000-0000000000bb',
      task_id: null,
    });
    await failed.emitW04();
    await w.flush();
    expect(await notificationsOf(w, paper.id)).toEqual([]);
    expect(await notificationsOf(w, failed.t.id)).toEqual([]);
  });

  it('the per-recipient bucket (6, then one every 6 s) spans the tickets of one customer (12 §5.7)', async () => {
    const customer = await newCustomer('+966512340007');
    const tickets: Awaited<ReturnType<typeof retrieving>>[] = [];
    for (let i = 0; i < 7; i++) tickets.push(await retrieving({ customerId: customer }));
    for (const t of tickets) await t.emitW04();
    await w.drain();
    expect(await w.sim.client.listMessages({ to: '+966512340007' })).toHaveLength(6);
    w.clock.advance(6_000);
    await w.drain();
    expect(await w.sim.client.listMessages({ to: '+966512340007' })).toHaveLength(7);
  });

  it('an attempt whose outcome was never recorded: acceptance proven by the webhook is kept, nothing is resent (12 §5.13)', async () => {
    const { t, emitW04 } = await retrieving();
    await emitW04();
    const [n] = await notificationsOf(w, t.id);
    // the worker crashed after Meta accepted the call; the status webhook already stored the wamid
    await w.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, notification_id, customer_id, ticket_id, venue_id, kind,
              template_name, purpose, status, status_rank, wa_message_id, ordering_key, queued_at, created_at)
       SELECT $1, id, 'outbound', $2, $3, $4::uuid, $5, 'template', $6, 'W-04', 'sent', 1, 'wamid.crash.recovered',
              $4::uuid::text, $7, $7
         FROM whatsapp_channel WHERE org_id = $1 AND is_active`,
      [ORG, n!.id, CUS1, t.id, RMS, TEMPLATE['W-04'], w.clock.now()],
    );
    await w.db.query(
      `INSERT INTO notification_attempts (notification_id, attempt_no, started_at) VALUES ($1, 1, $2)`,
      [n!.id, w.clock.now()],
    );
    await w.db.query(`UPDATE notifications SET attempts = 1 WHERE id = $1`, [n!.id]);
    const before = (await w.sim.client.sendAttempts()).length;
    await w.flush();
    expect((await w.sim.client.sendAttempts()).length).toBe(before);
    expect((await notificationsOf(w, t.id))[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await attempts(n!.id)).rows).toEqual([
      expect.objectContaining({ attempt_no: 1, outcome: 'success' }),
    ]);
  });

  it('staging guard: a recipient outside WA_TEST_RECIPIENT_ALLOWLIST is never messaged', async () => {
    const { t, emitW04 } = await retrieving();
    await emitW04();
    const guarded = new WhatsappRuntime({
      env: { ...w.env, WA_TEST_RECIPIENT_ALLOWLIST: '+966500009999' },
      logger: silentLogger,
    });
    const d = new OutboxDispatcher(w.db, w.clock, silentLogger, {
      workerId: 'staging-worker',
      concurrency: 1,
    });
    for (const h of whatsappJobs({ runtime: guarded })) d.register(h);
    const before = (await w.sim.client.sendAttempts()).length;
    await d.drain();
    expect((await w.sim.client.sendAttempts()).length).toBe(before);
    expect((await notificationsOf(w, t.id))[0]).toMatchObject({
      status: 'failed',
      last_error_code: 'WA_SEND_FAILED',
    });
    expect((await alerts(t.id)).rowCount).toBe(0);
  });

  it('channel down, then back: sending stops, wa_channel_down per venue, only current-state messages afterwards', async () => {
    const t = await createTicket(w, { status: 'requested' });
    const cycle = await createCycle(w, t);
    await w.sim.client.setChannel({ state: 'down', code: 190 });
    await emit(w, 'ticket.retrieval_requested', t, { cycle_id: cycle, cycle_no: 1, requested_early: false });
    await w.drain();
    expect(await health()).toBe('down');
    const down = await w.db.query(
      `SELECT venue_id, status FROM alerts WHERE type = 'wa_channel_down' ORDER BY venue_id`,
    );
    expect(down.rows).toEqual(
      [
        { venue_id: RMS, status: 'open' },
        { venue_id: LYL, status: 'open' },
      ].sort((a, b) => a.venue_id.localeCompare(b.venue_id)),
    );
    const [n02] = await notificationsOf(w, t.id);
    expect(n02).toMatchObject({ status: 'pending', attempts: 0, last_error_code: 'WA_CHANNEL_UNAVAILABLE' });

    // while down the drive starts; then the provider comes back
    await emit(w, 'ticket.retrieving', t, { cycle_id: cycle, task_id: null }, (tx) =>
      tx.query(`UPDATE tickets SET status = 'retrieving' WHERE id = $1`, [t.id]).then(() => undefined),
    );
    await w.flush(90_000);
    expect(await sentFor(t)).toEqual([]);
    await w.sim.client.setChannel({ state: 'up' });
    await w.flush(5 * 60_000);
    expect((await sentFor(t)).map((m) => m.templateName)).toEqual([TEMPLATE['W-04']]);
    expect((await notificationsOf(w, t.id)).map((n) => [n.purpose, n.status, n.skipped_reason])).toEqual([
      ['W-02', 'skipped', 'superseded'],
      ['W-04', 'sent', null],
    ]);
    expect(await health()).toBe('healthy');
    const resolved = await w.db.query(`SELECT status FROM alerts WHERE type = 'wa_channel_down'`);
    expect(resolved.rows.every((a) => a.status === 'resolved')).toBe(true);
    const transitions = await w.db.query(
      `SELECT payload->'payload'->>'to' AS to FROM outbox_events WHERE type = 'wa.channel_health_changed' ORDER BY seq`,
    );
    expect(transitions.rows.map((r) => r.to)).toEqual(['down', 'healthy']);
  });

  it('temporary errors are retried 1, 4, 16, 64 s and the notification fails after wa.send_max_attempts', async () => {
    const { t, emitW04 } = await retrieving();
    await w.sim.client.addFault({ httpStatus: 503, count: 5, match: { template: TEMPLATE['W-04'] } });
    await emitW04();
    await w.flush(10 * 60_000);
    const [n] = await notificationsOf(w, t.id);
    expect(n).toMatchObject({ status: 'failed', attempts: 5, last_error_code: 'WA_SEND_FAILED' });
    const a = (await attempts(n!.id)).rows;
    expect(a.map((x) => x.outcome)).toEqual(Array(5).fill('retryable_error'));
    const gaps = a
      .slice(1)
      .map((x, i) => (new Date(x.started_at).getTime() - new Date(a[i].started_at).getTime()) / 1000);
    [1, 4, 16, 64].forEach((s, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(s * 0.8);
      expect(gaps[i]).toBeLessThanOrEqual(s * 1.2);
    });
    expect((await alerts(t.id)).rows[0]).toMatchObject({
      type: 'wa_send_failed',
      details: expect.objectContaining({ reason: 'attempts_exhausted' }),
    });
  });
});
