import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerCopy } from './test-env.js';
import {
  CUS1,
  CUS2,
  ORG,
  createTicket,
  emit,
  notificationsOf,
  createWaTestApp,
  type WaTestApp,
} from './wa-harness.js';

/** PNT-041 (job.wa_process_inbound) and PNT-048 (free text, stop words) through real webhooks and jobs. */
describe('WhatsApp inbound processing', () => {
  let w: WaTestApp;
  beforeAll(async () => {
    w = await createWaTestApp();
    await w.syncTemplates();
  });
  afterAll(async () => w?.close());

  const inboundRows = (wamid: string) =>
    w.db.query(`SELECT * FROM whatsapp_messages WHERE direction = 'inbound' AND wa_message_id = $1`, [wamid]);
  const textsTo = async (to: string) =>
    (await w.sim.client.listMessages({ to, type: 'text' })).map((m) => m.text);
  const customerBy = async (where: string, value: string) =>
    (await w.db.query(`SELECT * FROM customers WHERE org_id = $1 AND ${where} = $2`, [ORG, value])).rows;

  it('free text: stored once, customer window anchored, wa.inbound_received without text or phone, W-10 sent', async () => {
    const r = await w.sim.client.sendText({
      from: '+966551234567',
      body: 'مرحبا، متى تصل سيارتي؟',
      timestamp: w.ts(),
    });
    await w.flush();
    const msg = (await inboundRows(r.wamids[0]!)).rows[0];
    expect(msg).toMatchObject({
      kind: 'inbound_text',
      status: 'received',
      sender_wa_id: '966551234567',
      customer_id: CUS1,
      body_redacted: 'مرحبا، متى تصل سيارتي؟',
    });
    const [cus] = await customerBy('id', CUS1);
    expect(new Date(cus.last_inbound_at).getTime()).toBe(w.ts() * 1000);
    expect(cus.wa_user_id).toBeTruthy(); // BSUID filled from the contact (DEC-35)
    const ev = (
      await w.db.query(
        `SELECT payload FROM outbox_events WHERE type = 'wa.inbound_received' AND aggregate_id = $1`,
        [msg.id],
      )
    ).rows[0].payload;
    expect(ev.payload).toMatchObject({
      whatsapp_message_id: msg.id,
      kind: 'inbound_text',
      customer_id: CUS1,
      matched: 'none',
    });
    expect(JSON.stringify(ev)).not.toMatch(/966551234567|مرحبا/);
    expect(await textsTo('+966551234567')).toEqual([customerCopy.messageText('W-10')]);
    const reply = (
      await w.db.query(
        `SELECT m.kind, m.purpose, m.status, m.wa_message_id, n.status AS n_status, n.dedupe_key
           FROM whatsapp_messages m JOIN notifications n ON n.id = m.notification_id
          WHERE m.direction = 'outbound' AND m.customer_id = $1`,
        [CUS1],
      )
    ).rows;
    expect(reply).toEqual([
      expect.objectContaining({
        kind: 'session_text',
        purpose: 'W-10',
        n_status: 'sent',
        dedupe_key: `wa:W-10:${msg.id}`,
      }),
    ]);
    const processed = await w.db.query(
      `SELECT status FROM whatsapp_inbound_events ORDER BY received_at DESC LIMIT 1`,
    );
    expect(processed.rows[0].status).toBe('processed');
  });

  it('W-10 is throttled to one reply per sender every 10 minutes', async () => {
    await w.sim.client.sendText({ from: '+966551234567', body: 'أهلا', timestamp: w.ts() });
    await w.flush();
    expect(await textsTo('+966551234567')).toHaveLength(1);
    w.clock.advance(11 * 60_000);
    await w.sim.client.sendText({ from: '+966551234567', body: 'هل من أحد؟', timestamp: w.ts() });
    await w.flush();
    expect(await textsTo('+966551234567')).toHaveLength(2);
  });

  it('the same message in different bodies (Meta retries) is stored and answered once (uq_whatsapp_messages_wamid)', async () => {
    const r = await w.sim.client.sendText({
      from: '+966511110001',
      body: 'مرحبا',
      timestamp: w.ts(),
      copies: 3,
      duplicateMode: 'same_wamid',
      identicalFirst: 1,
    });
    expect(new Set(r.wamids).size).toBe(1);
    await w.flush();
    expect((await inboundRows(r.wamids[0]!)).rows).toHaveLength(1);
    expect((await customerBy('phone_e164', '+966511110001')).length).toBe(1);
    expect(await textsTo('+966511110001')).toHaveLength(1);
    const events = await w.db.query(
      `SELECT count(*)::int AS n FROM whatsapp_inbound_events WHERE raw_body LIKE $1`,
      [`%${r.wamids[0]}%`],
    );
    expect(events.rows[0].n).toBe(3);
  });

  it('replaying a processed delivery or its job changes nothing', async () => {
    const r = await w.sim.client.sendText({ from: '+966511110002', body: 'test', timestamp: w.ts() });
    await w.flush();
    const ev = (
      await w.db.query(`SELECT id FROM whatsapp_inbound_events WHERE raw_body LIKE $1`, [`%${r.wamids[0]}%`])
    ).rows[0];
    // the row goes back to pending (a crash after the effects) and its job runs again
    await w.db.query(`UPDATE whatsapp_inbound_events SET status = 'pending' WHERE id = $1`, [ev.id]);
    await w.db.query(
      `INSERT INTO outbox_events (org_id, type, payload, available_at) VALUES ($1, 'job.wa_process_inbound', $2, $3)`,
      [ORG, JSON.stringify({ inbound_event_id: ev.id }), w.clock.now()],
    );
    await w.flush();
    expect((await inboundRows(r.wamids[0]!)).rows).toHaveLength(1);
    expect(await textsTo('+966511110002')).toHaveLength(1);
    const notes = await w.db.query(
      `SELECT count(*)::int AS n FROM notifications n JOIN customers c ON c.id = n.recipient_customer_id WHERE c.phone_e164 = '+966511110002'`,
    );
    expect(notes.rows[0].n).toBe(1);
  });

  it('a sender known only by BSUID (DEC-35): customer without phone, the reply goes to `recipient`', async () => {
    const r = await w.sim.client.sendText({ from: '+966500002222', body: 'hello', timestamp: w.ts() });
    await w.flush();
    const msg = (await inboundRows(r.wamids[0]!)).rows[0];
    expect(msg.sender_wa_id).toBeNull();
    expect(msg.sender_user_id).toBeTruthy();
    const [cus] = await customerBy('wa_user_id', msg.sender_user_id);
    expect(cus.phone_e164).toBeNull(); // wa_id is only learned later from a send answer (12 §5.12)
    const out = await w.sim.client.listMessages({ to: msg.sender_user_id, type: 'text' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      to: null,
      recipient: msg.sender_user_id,
      text: customerCopy.messageText('W-10'),
    });
  });

  it('statuses arriving out of order never move the rank down; read fills delivered_at (TC-WA-15)', async () => {
    const sent = (await w.sim.client.listMessages({ to: '+966511110001', type: 'text' }))[0]!;
    await w.sim.client.emitStatuses({
      wamid: sent.wamid,
      statuses: ['sent', 'delivered', 'read'],
      order: 'reversed',
      timestamp: w.ts(),
    });
    await w.sim.client.emitStatuses({ wamid: sent.wamid, statuses: ['sent'], timestamp: w.ts() });
    await w.flush();
    const row = (await w.db.query(`SELECT * FROM whatsapp_messages WHERE wa_message_id = $1`, [sent.wamid]))
      .rows[0];
    expect(row).toMatchObject({
      status: 'read',
      status_rank: 3,
      pricing_category: 'service',
      billable: false,
    });
    expect(row.sent_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
    expect(row.read_at).not.toBeNull();
    const changes = await w.db.query(
      `SELECT payload->'payload'->>'status' AS s FROM outbox_events WHERE type = 'wa.message_status_changed'
        AND payload->'payload'->>'whatsapp_message_id' = $1 ORDER BY seq`,
      [row.id],
    );
    expect(changes.rows.map((x) => x.s)).toEqual(['read']); // delivered/sent after read change nothing
  });

  it('a status for an unknown message is retried for about a minute, then dropped with a metric (12 §6.8)', async () => {
    const body = {
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
                statuses: [
                  {
                    id: 'wamid.unknown.1',
                    status: 'delivered',
                    timestamp: String(w.ts()),
                    recipient_id: '966500000001',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await w.sim.client.emitRaw({ body });
    await w.flush(120_000);
    const ev = (
      await w.db.query(
        `SELECT status, attempts FROM whatsapp_inbound_events WHERE raw_body LIKE '%wamid.unknown.1%'`,
      )
    ).rows[0];
    expect(ev).toMatchObject({ status: 'processed', attempts: 5 });
  });

  it('a link code answers W-11 (invalid until PNT-044 issues codes)', async () => {
    await w.sim.client.sendLinkCode('+966511110003', 'K7Q29F', { timestamp: w.ts() });
    await w.flush();
    expect(await textsTo('+966511110003')).toEqual([customerCopy.messageText('W-11', 'invalid')]);
  });

  it('an unknown button payload gets the W-10 guidance without ticket data', async () => {
    const body = {
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
                contacts: [{ profile: { name: 'x' }, wa_id: '966511110004' }],
                messages: [
                  {
                    from: '966511110004',
                    id: 'wamid.button.unknown.1',
                    timestamp: String(w.ts()),
                    type: 'button',
                    button: { payload: 'rq1.not-a-token', text: 'طلب السيارة' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await w.sim.client.emitRaw({ body });
    await w.flush();
    const msg = (await inboundRows('wamid.button.unknown.1')).rows[0];
    expect(msg.kind).toBe('inbound_button');
    expect(msg.button_payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(msg)).not.toContain('rq1.not-a-token');
    const pressed = (
      await w.db.query(
        `SELECT payload FROM outbox_events WHERE type = 'wa.button_pressed' AND aggregate_id = $1`,
        [msg.id],
      )
    ).rows[0].payload.payload;
    expect(pressed).toMatchObject({ outcome: 'rejected', reject_reason: 'unknown_token', ticket_id: null });
    expect(await textsTo('+966511110004')).toEqual([customerCopy.messageText('W-10')]);
  });

  describe('PNT-048 — «إيقاف»', () => {
    it('opts the customer out of every ticket, revokes consent, confirms with W-12; later sends are skipped', async () => {
      const t = await createTicket(w, { customerId: CUS2, status: 'parked', waLinkStatus: 'linked' });
      const r = await w.sim.client.sendStop('+966559876543', { timestamp: w.ts() });
      await w.flush();
      const [cus] = await customerBy('id', CUS2);
      expect(cus.wa_opted_out_at).not.toBeNull();
      const consents = await w.db.query(
        `SELECT revoked_at, revoke_source FROM customer_consents WHERE customer_id = $1`,
        [CUS2],
      );
      expect(consents.rows.every((c) => c.revoked_at && c.revoke_source === 'customer_opt_out')).toBe(true);
      const ticket = (await w.db.query(`SELECT wa_link_status FROM tickets WHERE id = $1`, [t.id])).rows[0];
      expect(ticket.wa_link_status).toBe('opted_out');
      const timeline = await w.db.query(`SELECT type, data FROM ticket_events WHERE ticket_id = $1`, [t.id]);
      expect(timeline.rows).toContainEqual(
        expect.objectContaining({
          type: 'ticket.wa_link_changed',
          data: expect.objectContaining({ from: 'linked', to: 'opted_out' }),
        }),
      );
      const opted = (
        await w.db.query(`SELECT payload FROM outbox_events WHERE type = 'wa.customer_opted_out'`)
      ).rows;
      expect(opted).toHaveLength(1);
      expect(opted[0].payload.payload).toMatchObject({ customer_id: CUS2, affected_ticket_ids: [t.id] });
      expect(await textsTo('+966559876543')).toEqual([customerCopy.messageText('W-12')]);
      const msg = (await inboundRows(r.wamids[0]!)).rows[0];
      expect(msg.kind).toBe('inbound_text');

      // a later status message of the ticket is planned (trace) but never sent
      await emit(w, 'ticket.retrieving', t, {
        cycle_id: '0190d2a4-0000-7000-8000-0000000000aa',
        task_id: null,
        retrieved_by: null,
      });
      await w.flush();
      expect(await notificationsOf(w, t.id)).toEqual([
        expect.objectContaining({ purpose: 'W-04', status: 'skipped', skipped_reason: 'opted_out' }),
      ]);
      expect(await w.sim.client.listMessages({ to: '+966559876543', type: 'template' })).toEqual([]);

      // the stop word again changes nothing and sends nothing
      await w.sim.client.sendStop('+966559876543', { timestamp: w.ts(), keyword: 'STOP' });
      await w.flush();
      expect(await textsTo('+966559876543')).toHaveLength(1);
      expect(
        (await w.db.query(`SELECT 1 FROM outbox_events WHERE type = 'wa.customer_opted_out'`)).rowCount,
      ).toBe(1);
    });
  });
});
