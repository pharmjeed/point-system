import { REALTIME_PAYLOAD_SCHEMAS, realtimeEnvelopeSchema, renderWaText, rooms } from '@point/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customerCopy } from './test-env.js';
import {
  createCustomerApp,
  cyclesOf,
  freshDriver,
  messagesTo,
  park,
  press,
  settle,
  tasksOf,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import { auditCount, err, expectConsistent, ok, outboxEvents, patchIntake, U } from './dispatch-fixtures.js';
import { captureRealtime } from './dispatch-s4-fixtures.js';
import { ORG } from './wa-harness.js';

let phoneSeq = 4_200_000;
const newPhone = () => `+96655${phoneSeq++}`;

const notifications = async (w: CustomerApp, ticketId: string, purpose?: string) =>
  (
    await w.db.query<{ purpose: string; status: string; skipped_reason: string | null; dedupe_key: string }>(
      `SELECT purpose, status, skipped_reason, dedupe_key FROM notifications
        WHERE ticket_id = $1 AND ($2::text IS NULL OR purpose = $2) ORDER BY created_at, id`,
      [ticketId, purpose ?? null],
    )
  ).rows;
const texts = async (w: CustomerApp, phone: string) =>
  (await messagesTo(w, phone)).map((m) => m.renderedText);

describe('S3 «طلب السيارة» (PNT-045), phone change (PNT-049), one number for two venues (PNT-050)', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
  });
  afterAll(async () => w?.close());
  beforeEach(async () => {
    await w.sim.client.clearFaults();
    w.clock.advance(10 * 60_000); // fresh throttles and recipient buckets between tests
    await w.drain();
  });

  /** A WhatsApp ticket whose W-01 was delivered (linked), parked by its own driver unless `parking`. */
  async function linkedTicket(o: { phone?: string; venue?: 'RMS' | 'LYL'; parking?: boolean } = {}) {
    const venue = o.venue ?? 'RMS';
    const driver = await freshDriver(w, venue);
    const phone = o.phone ?? newPhone();
    const t = await whatsappTicket(w, driver, phone, { venue });
    expect(t.submit!.status).toBe(200);
    await settle(w, phone);
    const w01 = (await messagesTo(w, phone)).filter((m) => m.purpose === 'W-01').at(-1)!;
    if (!o.parking) await park(w, driver, t.taskId, venue);
    expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('linked');
    return { ...t, driver, w01 };
  }

  it('AC-01 / TC-001: the same press delivered 10 times (5 in parallel) → one inbound row, one cycle and task, one W-02', async () => {
    const t = await linkedTicket();
    const res = await press(w, t.phone, {
      wamid: t.w01.wamid,
      copies: 10,
      parallel: 5,
      duplicateMode: 'same_body',
    });
    expect(res.deliveries.every((d) => d.httpStatus === 200)).toBe(true);
    await settle(w, t.phone);
    const inbound = await w.db.query(
      `SELECT count(*)::int AS n FROM whatsapp_messages WHERE direction = 'inbound' AND wa_message_id = $1`,
      [res.wamids[0]],
    );
    expect(inbound.rows[0].n).toBe(1);
    const events = await w.db.query(
      `SELECT count(*)::int AS n FROM whatsapp_inbound_events WHERE raw_body LIKE $1`,
      [`%${res.wamids[0]}%`],
    );
    expect(events.rows[0].n).toBe(1);
    const cycles = await cyclesOf(w, t.ticketId);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ request_source: 'whatsapp', requested_early: false });
    expect((await tasksOf(w, t.ticketId)).filter((k) => k.type === 'retrieve')).toHaveLength(1);
    expect((await notifications(w, t.ticketId, 'W-02')).map((n) => n.status)).toEqual(['sent']);
    expect(await notifications(w, t.ticketId, 'W-09')).toEqual([]);
    const pressed = (await outboxEvents(w.db, 'wa.button_pressed')).filter(
      (e) => e.payload.payload.ticket_id === t.ticketId,
    );
    expect(pressed.map((e) => e.payload.payload.outcome)).toEqual(['request_created']);
    await expectConsistent(w.db);
  });

  it('AC-01 / TC-002: ten real taps (10 wamids) → one cycle; the first W-02, later taps a throttled W-09 with the state', async () => {
    const t = await linkedTicket();
    const res = await press(w, t.phone, { wamid: t.w01.wamid, copies: 10, duplicateMode: 'distinct' });
    expect(new Set(res.wamids).size).toBe(10);
    await settle(w, t.phone);
    expect(await cyclesOf(w, t.ticketId)).toHaveLength(1);
    expect((await tasksOf(w, t.ticketId)).filter((k) => k.type === 'retrieve')).toHaveLength(1);
    expect((await notifications(w, t.ticketId, 'W-02')).length).toBe(1);
    expect((await notifications(w, t.ticketId, 'W-09')).length).toBe(1); // 20 s throttle (14 §10)
    const stored = await w.db.query(
      `SELECT count(*)::int AS n FROM whatsapp_messages WHERE direction = 'inbound' AND wa_message_id = ANY($1::text[])`,
      [res.wamids],
    );
    expect(stored.rows[0].n).toBe(10);
    const status = (await ticketRow(w, t.ticketId)).status;
    expect(await texts(w, t.phone)).toContain(
      renderWaText(customerCopy.messageText('W-09', status), [String(t.displayNumber)]),
    );
  });

  it('AC-02 / TC-004: a forwarded button pressed from another number → no request, W-10 without ticket data, audited', async () => {
    const t = await linkedTicket();
    const before = await ticketRow(w, t.ticketId);
    const stranger = newPhone();
    await press(w, t.phone, { wamid: t.w01.wamid, from: stranger });
    await settle(w, stranger);
    expect(await cyclesOf(w, t.ticketId)).toHaveLength(0);
    expect(await ticketRow(w, t.ticketId)).toMatchObject({ status: 'parked', version: before.version });
    expect(await texts(w, stranger)).toEqual([customerCopy.messageText('W-10')]);
    expect((await texts(w, stranger)).join(' ')).not.toContain(String(t.displayNumber));
    const audit = (
      await w.db.query(
        `SELECT entity_type, metadata FROM audit_log WHERE action = 'wa.button_sender_mismatch'`,
      )
    ).rows;
    expect(audit).toEqual([
      { entity_type: 'action_token', metadata: expect.objectContaining({ ticket_id: t.ticketId }) },
    ]);
  });

  it('AC-03 / TC-006 / TC-007: two tickets of one number — only the pressed one is requested; free text chooses none', async () => {
    const phone = newPhone();
    const camry = await linkedTicket({ phone });
    const tahoe = await linkedTicket({ phone });
    await w.sim.client.sendText({ from: phone, body: 'أبغى سيارتي', timestamp: w.ts() });
    await settle(w, phone);
    expect((await texts(w, phone)).at(-1)).toBe(customerCopy.messageText('W-10'));
    expect(await cyclesOf(w, camry.ticketId)).toHaveLength(0);
    expect(await cyclesOf(w, tahoe.ticketId)).toHaveLength(0);

    await press(w, phone, { wamid: tahoe.w01.wamid });
    await settle(w, phone);
    expect(await cyclesOf(w, tahoe.ticketId)).toHaveLength(1);
    expect(await cyclesOf(w, camry.ticketId)).toHaveLength(0);
    expect((await ticketRow(w, camry.ticketId)).status).toBe('parked');
    const w02 = (await messagesTo(w, phone)).filter((m) => m.purpose === 'W-02');
    expect(w02).toHaveLength(1);
    expect(w02[0]!.bodyParams).toContain(String(tahoe.displayNumber));
  });

  it('AC-05 / TC-011–012: a press during parking → pending request (DEC-13) and W-02 once, no retrieve task; at parked the cycle keeps the press time', async () => {
    const t = await linkedTicket({ parking: true });
    const pressedAt = w.clock.now();
    await press(w, t.phone, { wamid: t.w01.wamid });
    await settle(w, t.phone);
    const row = await ticketRow(w, t.ticketId);
    expect(row).toMatchObject({ status: 'parking', pending_retrieval_source: 'whatsapp' });
    expect(new Date(row.pending_retrieval_at).getTime()).toBe(Math.floor(pressedAt.getTime() / 1000) * 1000);
    expect((await tasksOf(w, t.ticketId)).map((k) => k.type)).toEqual(['park']);
    const early = (await outboxEvents(w.db, 'ticket.retrieval_requested_early')).filter(
      (e) => e.payload.payload.ticket.ticket_id === t.ticketId,
    );
    expect(early.map((e) => e.payload.payload)).toEqual([
      expect.objectContaining({ request_source: 'whatsapp', parking_task_assignee_id: t.driver }),
    ]);
    expect((await notifications(w, t.ticketId, 'W-02')).length).toBe(1);
    // a second press while pending: W-09 «pending_early», no second request
    w.clock.advance(30_000);
    await press(w, t.phone, { wamid: t.w01.wamid });
    await settle(w, t.phone);
    expect((await texts(w, t.phone)).at(-1)).toBe(
      renderWaText(customerCopy.messageText('W-09', 'pending_early'), [String(t.displayNumber)]),
    );

    w.clock.advance(60_000);
    await park(w, t.driver, t.taskId);
    await settle(w, t.phone);
    const [cycle] = await cyclesOf(w, t.ticketId);
    expect(cycle).toMatchObject({ requested_early: true, request_source: 'whatsapp' });
    expect(new Date(cycle.requested_at).getTime()).toBe(new Date(row.pending_retrieval_at).getTime());
    expect((await notifications(w, t.ticketId, 'W-02')).length).toBe(1); // no second W-02
    await expectConsistent(w.db);
  });

  it('decisions:F6: «إيقاف» then a press during parking — the coalesced ticket.updated (cause ticket.wa_link_changed, DEC-265) carries pending_retrieval_at to the parking driver', async () => {
    const t = await linkedTicket({ parking: true });
    await w.sim.client.sendStop(t.phone, { timestamp: w.ts() });
    await settle(w, t.phone);
    expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('opted_out');
    const rt = await captureRealtime(w);
    try {
      await press(w, t.phone, { wamid: t.w01.wamid });
      await settle(w, t.phone);
      const row = await ticketRow(w, t.ticketId);
      expect(row).toMatchObject({ status: 'parking', wa_link_status: 'linked' });
      expect(row.pending_retrieval_at).toBeTruthy();
      await rt.settle();
      const toDriver = rt
        .of('ticket.updated', rooms.user(t.driver))
        .filter((m) => m.message.data.id === t.ticketId);
      // the press transaction: one merged update whose cause is the first ticket.* event (the consent resume)
      const press1 = toDriver.find((m) => m.message.data.cause === 'ticket.wa_link_changed')!;
      expect(press1).toBeTruthy();
      expect(toDriver.some((m) => m.message.data.cause === 'ticket.retrieval_requested_early')).toBe(false);
      // …and the client still reads the early request from the ticket state (14 §5.1 «طلب مبكر أثناء الصف»)
      expect(press1.message.data.pending_retrieval_at).toBe(new Date(row.pending_retrieval_at).toISOString());
      const schema = realtimeEnvelopeSchema('ticket.updated', REALTIME_PAYLOAD_SCHEMAS['ticket.updated']);
      const frame = {
        id: press1.message.id,
        type: 'ticket.updated',
        occurred_at: (press1.message as Record<string, unknown>).occurred_at,
        org_id: press1.org_id,
        venue_id: press1.message.venue_id ?? null,
        dispatch_pool_id: press1.message.dispatch_pool_id ?? null,
        event_id: (press1.message as Record<string, unknown>).event_id ?? null,
        aggregate: press1.message.aggregate ?? null,
        actor: (press1.message as Record<string, unknown>).actor ?? { type: 'system', id: null },
        payload: press1.message.data,
      };
      const r = schema.safeParse(frame);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    } finally {
      await rt.stop();
    }
  });

  it('inactive buttons: revoked or expired token → W-09 «inactive»; a delivered ticket → W-09 with its state; never a request', async () => {
    const revoked = await linkedTicket();
    await w.db.query(`UPDATE action_tokens SET revoked_at = now() WHERE ticket_id = $1`, [revoked.ticketId]);
    await press(w, revoked.phone, { wamid: revoked.w01.wamid });
    await settle(w, revoked.phone);
    expect((await texts(w, revoked.phone)).at(-1)).toBe(customerCopy.messageText('W-09', 'inactive'));
    expect(await cyclesOf(w, revoked.ticketId)).toHaveLength(0);

    const expired = await linkedTicket();
    w.clock.advance(72 * 3_600_000 + 1_000); // wa.action_token_ttl_h, no grace
    await press(w, expired.phone, { wamid: expired.w01.wamid });
    await settle(w, expired.phone);
    expect((await texts(w, expired.phone)).at(-1)).toBe(customerCopy.messageText('W-09', 'inactive'));
    expect(await cyclesOf(w, expired.ticketId)).toHaveLength(0);
    const reasons = (await outboxEvents(w.db, 'wa.button_pressed'))
      .map((e) => e.payload.payload)
      .filter((p) => p.ticket_id === revoked.ticketId || p.ticket_id === expired.ticketId)
      .map((p) => p.reject_reason);
    expect(reasons).toEqual(['revoked', 'expired']);

    const done = await linkedTicket();
    await w.db.query(
      `UPDATE tickets SET status = 'delivered', delivered_at = now(), delivered_by = $2, vehicle_holder_type = 'customer',
              vehicle_holder_id = NULL, key_holder_type = 'customer', key_holder_id = NULL WHERE id = $1`,
      [done.ticketId, done.driver],
    );
    await press(w, done.phone, { wamid: done.w01.wamid });
    await settle(w, done.phone);
    expect((await texts(w, done.phone)).at(-1)).toBe(
      renderWaText(customerCopy.messageText('W-09', 'delivered'), [String(done.displayNumber)]),
    );
    expect(await cyclesOf(w, done.ticketId)).toHaveLength(0);
  });

  it('TC-WA-18: «إيقاف» then the button → W-12, the press resumes the consent (button_resume) and creates the request + W-02', async () => {
    const t = await linkedTicket();
    await w.sim.client.sendStop(t.phone, { timestamp: w.ts() });
    await settle(w, t.phone);
    expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('opted_out');
    expect((await texts(w, t.phone)).at(-1)).toBe(customerCopy.messageText('W-12'));
    await press(w, t.phone, { wamid: t.w01.wamid });
    await settle(w, t.phone);
    const row = await ticketRow(w, t.ticketId);
    expect(row).toMatchObject({ wa_link_status: 'linked', status: 'requested' });
    const customer = (
      await w.db.query(`SELECT wa_opted_out_at FROM customers WHERE id = $1`, [row.customer_id])
    ).rows[0];
    expect(customer.wa_opted_out_at).toBeNull();
    const consents = (
      await w.db.query(
        `SELECT method, evidence_message_id IS NOT NULL AS evidence, revoked_at IS NULL AS live FROM customer_consents
          WHERE ticket_id = $1 ORDER BY captured_at, method DESC`,
        [t.ticketId],
      )
    ).rows;
    expect(consents).toEqual([
      { method: 'verbal_staff_confirmed', evidence: false, live: false },
      { method: 'customer_initiated', evidence: true, live: true },
    ]);
    const resumed = (await outboxEvents(w.db, 'ticket.wa_link_changed')).filter(
      (e) => e.payload.aggregate.id === t.ticketId && e.payload.payload.method === 'button_resume',
    );
    expect(resumed).toHaveLength(1);
    expect((await notifications(w, t.ticketId, 'W-02')).map((n) => n.status)).toEqual(['sent']);
  });

  it('TC-079: a late W-01 after the paper conversion (link_version + 1) → W-09 «inactive», no request', async () => {
    const driver = await freshDriver(w);
    const phone = newPhone();
    const t = await whatsappTicket(w, driver, phone);
    await w.drain(); // W-01 accepted, the customer has it
    const w01 = (await messagesTo(w, phone)).at(-1)!;
    const current = await ticketRow(w, t.ticketId);
    // linked tickets cannot convert: simulate the failure D-07 shows before the conversion
    await w.db.query(`UPDATE tickets SET wa_link_status = 'failed' WHERE id = $1`, [t.ticketId]);
    ok(
      await patchIntake(w, driver, t.ticketId, {
        expected_version: current.version,
        channel: 'paper',
        paper_serial: `PC-${phoneSeq}`,
      }),
    );
    await park(w, driver, t.taskId);
    await press(w, phone, { wamid: w01.wamid });
    await settle(w, phone);
    expect((await texts(w, phone)).at(-1)).toBe(customerCopy.messageText('W-09', 'inactive'));
    expect(await cyclesOf(w, t.ticketId)).toHaveLength(0);
  });

  describe('PNT-049 — PATCH /v1/tickets/{ticketId}/customer-phone', () => {
    const change = (as: string, ticketId: string, body: Record<string, unknown>) =>
      w.command('patch', `/v1/tickets/${ticketId}/customer-phone`, { as, body });
    const consent = { method: 'verbal_staff_confirmed', confirmed: true };

    it('TC-005 / TC-WA-19: the old number’s button answers W-09 «inactive», the new number gets W-01 and its button works', async () => {
      const t = await linkedTicket();
      const next = newPhone();
      const row = await ticketRow(w, t.ticketId);
      const d = ok(
        await change(t.driver, t.ticketId, {
          expected_version: row.version,
          customer_phone: `0${next.slice(4)}`,
          consent,
          reason: 'العميل أعطى رقم زوجته',
        }),
      );
      expect(d).toMatchObject({ wa_link_status: 'pending_send', projection: 'minimal' }); // the creator after parking
      const supView = ok(await w.get(`/v1/tickets/${t.ticketId}`, 'SUP-R'));
      expect(supView.customer).toMatchObject({ phone_masked: `05•••••${next.slice(-3)}`, opted_out: false });
      expect(supView.customer.consent).toMatchObject({ method: 'verbal_staff_confirmed', revoked_at: null });
      const after = await ticketRow(w, t.ticketId);
      expect(after).toMatchObject({ link_version: row.link_version + 1, wa_link_status: 'pending_send' });
      expect(
        (
          await w.db.query(
            `SELECT count(*)::int AS n FROM action_tokens WHERE ticket_id = $1 AND revoked_at IS NULL`,
            [t.ticketId],
          )
        ).rows[0].n,
      ).toBe(0);
      const changed = (await outboxEvents(w.db, 'ticket.customer_phone_changed')).filter(
        (e) => e.payload.aggregate.id === t.ticketId,
      );
      expect(changed.map((e) => e.payload.payload)).toEqual([
        expect.objectContaining({ changed_by: t.driver, reason: 'العميل أعطى رقم زوجته', link_version: 2 }),
      ]);
      const audit = (
        await w.db.query(
          `SELECT reason, before, after, metadata FROM audit_log WHERE action = 'ticket.change_phone' AND entity_id = $1`,
          [t.ticketId],
        )
      ).rows[0];
      expect(audit.before).toMatchObject({ phone_masked: `05•••••${t.phone.slice(-3)}`, link_version: 1 });
      expect(audit.after).toMatchObject({ phone_masked: `05•••••${next.slice(-3)}`, link_version: 2 });
      expect(JSON.stringify(audit)).not.toContain(next.slice(4));

      await settle(w, next);
      const newW01 = (await messagesTo(w, next)).filter((m) => m.purpose === 'W-01');
      expect(newW01).toHaveLength(1);
      await press(w, t.phone, { wamid: t.w01.wamid }); // the old number, the old button
      await settle(w, t.phone);
      expect((await texts(w, t.phone)).at(-1)).toBe(customerCopy.messageText('W-09', 'inactive'));
      expect(await cyclesOf(w, t.ticketId)).toHaveLength(0);
      await press(w, next, { wamid: newW01[0]!.wamid });
      await settle(w, next);
      expect(await cyclesOf(w, t.ticketId)).toHaveLength(1);
      expect((await messagesTo(w, next)).map((m) => m.purpose)).toEqual(['W-01', 'W-02']);
    });

    it('errors: REASON_REQUIRED, CONSENT_REQUIRED, PHONE_INVALID, TICKET_NOT_FOUND, PERMISSION_DENIED, VERSION_CONFLICT, WA_CUSTOMER_OPTED_OUT, TICKET_CLOSED', async () => {
      const t = await linkedTicket();
      const v = (await ticketRow(w, t.ticketId)).version;
      const body = { expected_version: v, customer_phone: newPhone(), consent, reason: 'رقم خاطئ' };
      expect(
        err(await change(t.driver, t.ticketId, { ...body, reason: 'x' }), 'REASON_REQUIRED', 422),
      ).toEqual({
        field: 'reason',
        min_length: 3,
      });
      expect(
        err(await change(t.driver, t.ticketId, { ...body, consent: undefined }), 'CONSENT_REQUIRED', 422),
      ).toEqual({
        field: 'consent',
      });
      err(
        await change(t.driver, t.ticketId, {
          ...body,
          consent: { method: 'verbal_staff_confirmed', confirmed: false },
        }),
        'CONSENT_REQUIRED',
        422,
      );
      expect(
        err(await change(t.driver, t.ticketId, { ...body, customer_phone: '12345' }), 'PHONE_INVALID', 422),
      ).toEqual({
        field: 'customer_phone',
      });
      err(await change(t.driver, '00000000-0000-4000-8000-0000deadbeef', body), 'TICKET_NOT_FOUND', 404);
      const other = await freshDriver(w);
      expect(err(await change(other, t.ticketId, body), 'PERMISSION_DENIED', 403)).toMatchObject({
        reason: 'not_creator_or_assignee',
      });
      expect(
        err(
          await change(t.driver, t.ticketId, { ...body, expected_version: v - 1 }),
          'VERSION_CONFLICT',
          409,
        ),
      ).toMatchObject({
        current_version: v,
      });
      expect(
        err(
          await change(t.driver, t.ticketId, { ...body, customer_phone: t.phone }),
          'VALIDATION_FAILED',
          422,
        ).fields,
      ).toEqual([{ field: 'customer_phone', issue: 'unchanged' }]);
      const optedOut = newPhone();
      await w.db.query(`INSERT INTO customers (org_id, phone_e164, wa_opted_out_at) VALUES ($1, $2, now())`, [
        ORG,
        optedOut,
      ]);
      err(
        await change(t.driver, t.ticketId, { ...body, customer_phone: optedOut }),
        'WA_CUSTOMER_OPTED_OUT',
        409,
      );
      // a supervisor may change it (no creator rule), a closed ticket is refused
      ok(await change('SUP-R', t.ticketId, body));
      await w.db.query(
        `UPDATE tickets SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'test' WHERE id = $1`,
        [t.ticketId, U['SUP-R']],
      );
      err(
        await change('SUP-R', t.ticketId, {
          ...body,
          expected_version: (await ticketRow(w, t.ticketId)).version,
          customer_phone: newPhone(),
        }),
        'TICKET_CLOSED',
        409,
      );
      expect(await auditCount(w.db, 'ticket.change_phone', t.ticketId)).toBe(1);
    });
  });

  it('PNT-050 / AC-20 / TC-058: one number, tickets in RMS and LYL — W-01 names each venue, everything leaves from the one phone_number_id, the LYL button reaches LYL drivers only', async () => {
    const phone = newPhone();
    const rms = await linkedTicket({ phone, venue: 'RMS' });
    const lyl = await linkedTicket({ phone, venue: 'LYL' });
    const sent = await messagesTo(w, phone);
    expect(new Set(sent.map((m) => m.phoneNumberId))).toEqual(new Set(['SIM-PHONE']));
    expect(rms.w01.bodyParams[0]).toBe('قاعة ريماس');
    expect(lyl.w01.bodyParams[0]).toBe('قاعة ليلتي');

    await press(w, phone, { wamid: lyl.w01.wamid });
    await settle(w, phone);
    expect(await cyclesOf(w, rms.ticketId)).toHaveLength(0);
    const [task] = (await tasksOf(w, lyl.ticketId)).filter((k) => k.type === 'retrieve');
    const lylVenue = (await ticketRow(w, lyl.ticketId)).venue_id;
    const pool = (
      await w.db.query(`SELECT venue_id FROM dispatch_pools WHERE id = $1`, [task.dispatch_pool_id])
    ).rows[0];
    expect(pool.venue_id).toBe(lylVenue);
    const recipients = (
      await w.db.query(
        `SELECT DISTINCT r.user_id, a.venue_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
           JOIN driver_assignments a ON a.driver_id = r.user_id AND a.status = 'active'
          WHERE o.task_id = $1`,
        [task.id],
      )
    ).rows;
    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients.every((r) => r.venue_id === lylVenue)).toBe(true);
    const w02 = (await messagesTo(w, phone)).filter((m) => m.purpose === 'W-02');
    expect(w02).toHaveLength(1);
    expect(w02[0]!.phoneNumberId).toBe('SIM-PHONE');
    expect(w02[0]!.bodyParams).toContain(String(lyl.displayNumber));
  });
});
