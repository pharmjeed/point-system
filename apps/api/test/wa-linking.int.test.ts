import { createHash } from 'node:crypto';
import { waMessageText } from '@point/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCustomerApp,
  DISPLAY_PHONE,
  freshDriver,
  messagesTo,
  onDuty,
  park,
  purposes,
  settle,
  tablesContaining,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import {
  addPhotos,
  err,
  newDraft,
  ok,
  outboxEvents,
  PAPER_DRAFT,
  patchIntake,
  submitIntake,
  U,
} from './dispatch-fixtures.js';
import { ORG } from './wa-harness.js';

let phoneSeq = 3_100_000;
const newPhone = () => `+96655${phoneSeq++}`;
const link = (w: CustomerApp, as: string, ticketId: string, method: 'direct' | 'qr') =>
  w.command('post', `/v1/tickets/${ticketId}/whatsapp-link`, { as, body: { method } });
const confirm = (w: CustomerApp, as: string, ticketId: string, linkCodeId: string, matches: boolean) =>
  w.command('post', `/v1/tickets/${ticketId}/whatsapp-link/confirm`, {
    as,
    body: { link_code_id: linkCodeId, matches },
  });
const detail = async (w: CustomerApp, as: string, ticketId: string) =>
  ok(await w.get(`/v1/tickets/${ticketId}`, as));
const texts = async (w: CustomerApp, phone: string) =>
  (await messagesTo(w, phone)).map((m) => m.renderedText);

let qrSeq = 0;
/** A WhatsApp draft without a phone (QR mode of D-05), with its photos, not submitted yet. */
async function qrDraft(w: CustomerApp, as: string) {
  const d = await newDraft(w, as);
  const n = ++qrSeq;
  const p = ok(
    await patchIntake(w, as, d.ticketId, {
      expected_version: d.version,
      ...PAPER_DRAFT('X', `QK-${n}`, String(3000 + n)),
      channel: 'whatsapp',
      paper_serial: null,
    }),
  );
  await addPhotos(w.db, d.ticketId, as);
  return { ...d, version: p.version as number };
}

describe('S3 linking — direct W-01 (PNT-043) and QR (PNT-044)', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
    await onDuty(w, 'DRV2', 'DRV7');
  });
  afterAll(async () => w?.close());
  beforeEach(async () => {
    await w.sim.client.clearFaults();
    await w.db.query(
      `UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1 AND is_active`,
      [ORG],
    );
    await w.db.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE org_id = $1`, [ORG]);
    w.rt.probes.clear();
    w.clock.advance(10 * 60_000); // fresh throttles and recipient buckets
  });

  describe('PNT-043 — direct link with verbal consent', () => {
    it('submit → pending_send → one W-01 with the single «طلب السيارة» button → accepted → linked; only sha256(token) is stored', async () => {
      const drv = await freshDriver(w);
      const phone = newPhone();
      const t = await whatsappTicket(w, drv, phone);
      expect(t.submit!.status).toBe(200);
      expect(t.submit!.body.data).toMatchObject({ status: 'parking', wa_link_status: 'pending_send' });
      const changed = (await outboxEvents(w.db, 'ticket.wa_link_changed'))
        .map((e) => e.payload)
        .filter((e) => e.aggregate.id === t.ticketId);
      expect(changed.map((e) => e.payload)).toEqual([
        expect.objectContaining({ from: 'none', to: 'pending_send', method: 'direct', link_version: 1 }),
      ]);
      const notes = (
        await w.db.query(`SELECT purpose, dedupe_key FROM notifications WHERE ticket_id = $1`, [t.ticketId])
      ).rows;
      expect(notes).toEqual([{ purpose: 'W-01', dedupe_key: `wa:W-01:${t.ticketId}:lv1` }]);

      await settle(w, phone);
      const sent = await messagesTo(w, phone);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        purpose: 'W-01',
        templateName: 'masaf_ticket_issued_v1',
        phoneNumberId: 'SIM-PHONE',
      });
      expect(sent[0]!.buttons).toEqual([expect.objectContaining({ text: 'طلب السيارة' })]);
      expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('linked');
      const token = sent[0]!.buttons[0]!.payload!;
      const rows = (await w.db.query(`SELECT * FROM action_tokens WHERE ticket_id = $1`, [t.ticketId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
      // the raw token is in no column of any table (16 PNT-043 acceptance 2)
      expect(await tablesContaining(w, token)).toEqual([]);
    });

    it('WA_TEMPLATE_NOT_APPROVED at submit when W-01 is not approved (nothing changes)', async () => {
      await w.db.query(
        `UPDATE whatsapp_templates SET status = 'paused' WHERE org_id = $1 AND name = 'masaf_ticket_issued_v1'`,
        [ORG],
      );
      const t = await whatsappTicket(w, await freshDriver(w), newPhone());
      expect(err(t.submit!, 'WA_TEMPLATE_NOT_APPROVED', 409)).toEqual({
        template_name: 'masaf_ticket_issued_v1',
        template_status: 'paused',
      });
      expect(await ticketRow(w, t.ticketId)).toMatchObject({ status: 'received', wa_link_status: 'none' });
      expect(
        (await w.db.query(`SELECT 1 FROM notifications WHERE ticket_id = $1`, [t.ticketId])).rowCount,
      ).toBe(0);
    });

    it('a number not on WhatsApp (…0000, 131026): failed, wa_send_failed, D-07 sees it; the direct retry plans a new W-01 (link_version + 1)', async () => {
      const drv = await freshDriver(w);
      const phone = '+966500010000';
      const t = await whatsappTicket(w, drv, phone);
      await w.drain(); // accepted by the provider, not delivered
      const [m] = await messagesTo(w, phone);
      await w.sim.client.emitStatuses({ wamid: m!.wamid, timestamp: w.ts() }); // the planned async failure
      await w.drain();
      expect(await ticketRow(w, t.ticketId)).toMatchObject({ wa_link_status: 'failed', link_version: 1 });
      const alerts = (
        await w.db.query(`SELECT type FROM alerts WHERE ticket_id = $1 AND status <> 'resolved'`, [
          t.ticketId,
        ])
      ).rows;
      expect(alerts).toEqual([{ type: 'wa_send_failed' }]);
      expect((await detail(w, drv, t.ticketId)).wa_link_status).toBe('failed');

      const r = ok(await link(w, drv, t.ticketId, 'direct'));
      expect(r).toEqual({
        method: 'direct',
        wa_link_status: 'pending_send',
        channel_health: 'healthy',
        qr: null,
      });
      expect(await ticketRow(w, t.ticketId)).toMatchObject({
        wa_link_status: 'pending_send',
        link_version: 2,
      });
      const keys = (
        await w.db.query(
          `SELECT dedupe_key FROM notifications WHERE ticket_id = $1 AND purpose = 'W-01' ORDER BY dedupe_key`,
          [t.ticketId],
        )
      ).rows.map((x) => x.dedupe_key);
      expect(keys).toEqual([`wa:W-01:${t.ticketId}:lv1`, `wa:W-01:${t.ticketId}:lv2`]);
      const audits = await w.db.query(
        `SELECT metadata FROM audit_log WHERE action = 'wa.link' AND entity_id = $1`,
        [t.ticketId],
      );
      expect(audits.rows).toEqual([{ metadata: expect.objectContaining({ method: 'direct' }) }]);
    });

    it('whatsapp-link errors: TICKET_NOT_FOUND, DUTY_REQUIRED, TICKET_CLOSED, INVALID_STATE_TRANSITION, PHONE_INVALID, WA_CONSENT_MISSING, WA_CUSTOMER_OPTED_OUT, WA_CHANNEL_UNAVAILABLE, WA_TEMPLATE_NOT_APPROVED', async () => {
      const drv = await freshDriver(w);
      err(await link(w, drv, '00000000-0000-4000-8000-0000deadbeef', 'direct'), 'TICKET_NOT_FOUND', 404);
      const lyl = await whatsappTicket(w, 'DRV7', newPhone(), { venue: 'LYL' });
      err(await link(w, drv, lyl.ticketId, 'direct'), 'TICKET_NOT_FOUND', 404); // another venue
      const t = await whatsappTicket(w, drv, newPhone());
      err(await link(w, 'DRV3', t.ticketId, 'direct'), 'DUTY_REQUIRED', 409); // DRV3 is not on duty
      await settle(w, t.phone);
      expect(err(await link(w, drv, t.ticketId, 'direct'), 'INVALID_STATE_TRANSITION', 409).reason).toBe(
        'already_linked',
      );
      // a draft is linked by its submit
      const draft = await whatsappTicket(w, await freshDriver(w), newPhone(), { submit: false });
      expect(err(await link(w, drv, draft.ticketId, 'direct'), 'INVALID_STATE_TRANSITION', 409).reason).toBe(
        'submit_intake_links_directly',
      );
      // no phone on the ticket (QR mode)
      const qrDrv = await freshDriver(w);
      const qr = await qrDraft(w, qrDrv);
      ok(await link(w, qrDrv, qr.ticketId, 'qr'));
      ok(await submitIntake(w, qrDrv, qr.ticketId, { expected_version: qr.version }));
      expect(err(await link(w, qrDrv, qr.ticketId, 'direct'), 'PHONE_INVALID', 422)).toEqual({
        field: 'customer_phone',
        issue: 'missing',
      });
      // consent revoked by the staff, then an opted-out customer
      const fDrv = await freshDriver(w);
      const f = await whatsappTicket(w, fDrv, '+966500020000');
      await settle(w, f.phone);
      await w.db.query(`UPDATE tickets SET wa_link_status = 'failed' WHERE id = $1`, [f.ticketId]);
      await w.db.query(
        `UPDATE customer_consents SET revoked_at = now(), revoke_source = 'staff' WHERE ticket_id = $1`,
        [f.ticketId],
      );
      err(await link(w, fDrv, f.ticketId, 'direct'), 'WA_CONSENT_MISSING', 409);
      const customerOf = `(SELECT customer_id FROM tickets WHERE id = $1)`;
      await w.db.query(`UPDATE customers SET wa_opted_out_at = now() WHERE id = ${customerOf}`, [f.ticketId]);
      err(await link(w, fDrv, f.ticketId, 'direct'), 'WA_CUSTOMER_OPTED_OUT', 409);
      await w.db.query(`UPDATE customers SET wa_opted_out_at = NULL WHERE id = ${customerOf}`, [f.ticketId]);
      await w.db.query(
        `INSERT INTO customer_consents (org_id, customer_id, ticket_id, method, captured_by)
         SELECT org_id, customer_id, id, 'verbal_staff_confirmed', $2 FROM tickets WHERE id = $1`,
        [f.ticketId, fDrv],
      );
      await w.db.query(
        `UPDATE whatsapp_templates SET status = 'rejected' WHERE org_id = $1 AND name = 'masaf_ticket_issued_v1'`,
        [ORG],
      );
      expect(err(await link(w, fDrv, f.ticketId, 'direct'), 'WA_TEMPLATE_NOT_APPROVED', 409)).toMatchObject({
        template_status: 'rejected',
      });
      await w.db.query(
        `UPDATE whatsapp_channel SET health_status = 'down', health_changed_at = now() WHERE org_id = $1`,
        [ORG],
      );
      expect(err(await link(w, fDrv, f.ticketId, 'direct'), 'WA_CHANNEL_UNAVAILABLE', 503)).toMatchObject({
        health_status: 'down',
      });
      await w.db.query(`UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1`, [ORG]);
      // a paper ticket, a closed ticket
      const pDrv = await freshDriver(w);
      const paper = await newDraft(w, pDrv);
      ok(
        await patchIntake(w, pDrv, paper.ticketId, {
          expected_version: paper.version,
          ...PAPER_DRAFT('S-L1', 'K-L1'),
        }),
      );
      expect(err(await link(w, pDrv, paper.ticketId, 'qr'), 'INVALID_STATE_TRANSITION', 409).reason).toBe(
        'paper_channel',
      );
      await w.db.query(
        `UPDATE tickets SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'test' WHERE id = $1`,
        [paper.ticketId, U['SUP-R']],
      );
      err(await link(w, pDrv, paper.ticketId, 'qr'), 'TICKET_CLOSED', 409);
    });
  });

  describe('PNT-044 — QR linking (D-07)', () => {
    it('QR code and wa.me panel; scanning alone changes nothing; the message → pending_confirmation + W-11; confirm → customer_initiated consent with evidence + W-01', async () => {
      const drv = await freshDriver(w);
      const d = await qrDraft(w, drv);
      const r = ok(await link(w, drv, d.ticketId, 'qr'));
      expect(r).toMatchObject({ method: 'qr', wa_link_status: 'none', channel_health: 'healthy' });
      const qr = r.qr;
      expect(qr.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      expect(qr.status).toBe('active');
      expect(qr.prefilled_text).toBe(`ربط تذكرة مصاف ${qr.code}`);
      expect(qr.wa_me_url).toBe(
        `https://wa.me/${DISPLAY_PHONE.slice(1)}?text=${encodeURIComponent(qr.prefilled_text)}`,
      );
      expect(qr.qr_text).toBe(qr.wa_me_url);
      expect(new Date(qr.expires_at).getTime() - w.clock.now().getTime()).toBe(10 * 60_000);
      const timer = (
        await w.db.query(
          `SELECT available_at, payload FROM outbox_events WHERE type = 'job.link_code_expire' AND dedupe_key = $1`,
          [`link_code_expire:${qr.link_code_id}`],
        )
      ).rows[0];
      expect(new Date(timer.available_at).toISOString()).toBe(qr.expires_at);
      expect(timer.payload).toEqual({ link_code_id: qr.link_code_id });
      // the QR draft is submitted without a phone; scanning sends nothing, so nothing changes
      const s = ok(await submitIntake(w, drv, d.ticketId, { expected_version: d.version }));
      expect(s).toMatchObject({ status: 'parking', wa_link_status: 'none', customer: null });
      w.clock.advance(60_000);
      await w.drain();
      expect(await ticketRow(w, d.ticketId)).toMatchObject({ wa_link_status: 'none', customer_id: null });

      const phone = newPhone();
      await w.sim.client.sendLinkCode(phone, qr.code, { timestamp: w.ts() });
      await w.drain();
      expect(await ticketRow(w, d.ticketId)).toMatchObject({ wa_link_status: 'pending_confirmation' });
      expect(await texts(w, phone)).toEqual([waMessageText('W-11', 'received')]);
      const lc = (await w.db.query(`SELECT * FROM link_codes WHERE id = $1`, [qr.link_code_id])).rows[0];
      expect(lc).toMatchObject({
        status: 'pending_confirmation',
        inbound_phone_e164: phone,
        inbound_wa_id: phone.slice(1),
      });
      const view = await detail(w, drv, d.ticketId);
      expect(view.wa_link_pending).toMatchObject({
        link_code_id: qr.link_code_id,
        inbound_phone_masked: `05${'•'.repeat(5)}${phone.slice(-3)}`,
      });

      // a second number sending the same code (qr_race) gets «invalid» and changes nothing
      const other = newPhone();
      await w.sim.client.sendLinkCode(other, qr.code, { timestamp: w.ts() });
      await w.drain();
      expect(await texts(w, other)).toEqual([waMessageText('W-11', 'invalid')]);

      const c = ok(await confirm(w, drv, d.ticketId, qr.link_code_id, true));
      expect(c).toMatchObject({ wa_link_status: 'linked', wa_link_pending: null });
      const t = await ticketRow(w, d.ticketId);
      expect(t).toMatchObject({ wa_link_status: 'linked', link_version: 1 });
      const consent = (await w.db.query(`SELECT * FROM customer_consents WHERE ticket_id = $1`, [d.ticketId]))
        .rows;
      expect(consent).toEqual([
        expect.objectContaining({
          customer_id: t.customer_id,
          method: 'customer_initiated',
          evidence_message_id: lc.inbound_message_id,
          revoked_at: null,
        }),
      ]);
      expect(
        (await w.db.query(`SELECT * FROM link_codes WHERE id = $1`, [qr.link_code_id])).rows[0],
      ).toMatchObject({
        status: 'consumed',
        confirmed_by: drv,
      });
      await settle(w, phone);
      const conversation = await messagesTo(w, phone);
      expect(conversation.map((m) => m.purpose ?? m.renderedText)).toEqual([
        waMessageText('W-11', 'received'),
        'W-01',
      ]);
      expect(conversation[1]!.buttons).toHaveLength(1);
      const tokens = await w.db.query(`SELECT count(*)::int AS n FROM action_tokens WHERE ticket_id = $1`, [
        d.ticketId,
      ]);
      expect(tokens.rows[0].n).toBe(1);
    });

    it('the driver rejects the match: code revoked, link back to none, nothing sent; a new code replaces an active one (regenerated); one live code per ticket', async () => {
      const drv = await freshDriver(w);
      const d = await qrDraft(w, drv);
      const first = ok(await link(w, drv, d.ticketId, 'qr')).qr;
      const second = ok(await link(w, drv, d.ticketId, 'qr')).qr;
      expect(second.code).not.toBe(first.code);
      expect(
        (await w.db.query(`SELECT status, revoke_reason FROM link_codes WHERE id = $1`, [first.link_code_id]))
          .rows[0],
      ).toEqual({ status: 'revoked', revoke_reason: 'regenerated' });
      const phone = newPhone();
      await w.sim.client.sendLinkCode(phone, first.code, { timestamp: w.ts() });
      await w.drain();
      expect(await texts(w, phone)).toEqual([waMessageText('W-11', 'invalid')]);
      await w.sim.client.sendLinkCode(phone, second.code, { timestamp: w.ts() });
      await w.drain();
      // the message moved the link to pending_confirmation (version + 1): D-07 refetches before submitting
      ok(
        await submitIntake(w, drv, d.ticketId, {
          expected_version: (await ticketRow(w, d.ticketId)).version,
        }),
      );
      expect((await ticketRow(w, d.ticketId)).wa_link_status).toBe('pending_confirmation');
      const before = (await messagesTo(w, phone)).length;
      const r = ok(await confirm(w, drv, d.ticketId, second.link_code_id, false));
      expect(r).toMatchObject({ wa_link_status: 'none', customer: null });
      expect(
        (
          await w.db.query(`SELECT status, revoke_reason FROM link_codes WHERE id = $1`, [
            second.link_code_id,
          ])
        ).rows[0],
      ).toEqual({ status: 'revoked', revoke_reason: 'driver_rejected_match' });
      await w.drain();
      expect((await messagesTo(w, phone)).length).toBe(before);
      const third = ok(await link(w, drv, d.ticketId, 'qr')).qr;
      expect(third.status).toBe('active');
      await expect(
        w.db.query(
          `INSERT INTO link_codes (org_id, ticket_id, code, status, created_by, expires_at)
           VALUES ($1, $2, 'ZZZZZ9', 'active', $3, now() + interval '5 minutes')`,
          [ORG, d.ticketId, drv],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'uq_link_codes_live_ticket' });
    });

    it('an expired code: WA_LINK_CODE_EXPIRED at confirm; job.link_code_expire → expired and the link back to none', async () => {
      const drv = await freshDriver(w);
      const d = await qrDraft(w, drv);
      const qr = ok(await link(w, drv, d.ticketId, 'qr')).qr;
      ok(await submitIntake(w, drv, d.ticketId, { expected_version: d.version }));
      const phone = newPhone();
      await w.sim.client.sendLinkCode(phone, qr.code, { timestamp: w.ts() });
      await w.drain();
      expect((await ticketRow(w, d.ticketId)).wa_link_status).toBe('pending_confirmation');
      w.clock.advance(10 * 60_000 + 1);
      expect(
        err(await confirm(w, drv, d.ticketId, qr.link_code_id, true), 'WA_LINK_CODE_EXPIRED', 410),
      ).toEqual({
        expired_at: qr.expires_at,
      });
      await w.drain();
      expect(
        (await w.db.query(`SELECT status FROM link_codes WHERE id = $1`, [qr.link_code_id])).rows[0].status,
      ).toBe('expired');
      expect(await ticketRow(w, d.ticketId)).toMatchObject({ wa_link_status: 'none', customer_id: null });
      err(await confirm(w, drv, d.ticketId, qr.link_code_id, true), 'WA_LINK_CODE_EXPIRED', 410);
      await w.sim.client.sendLinkCode(phone, qr.code, { timestamp: w.ts() });
      await w.drain();
      expect(await texts(w, phone)).toEqual([
        waMessageText('W-11', 'received'),
        waMessageText('W-11', 'invalid'),
      ]);
    });

    it('confirm errors: the code still waits for a message (INVALID_STATE_TRANSITION), another driver (PERMISSION_DENIED), an unknown code (RESOURCE_NOT_FOUND); a supervisor may confirm', async () => {
      const drv = await freshDriver(w);
      const d = await qrDraft(w, drv);
      const qr = ok(await link(w, drv, d.ticketId, 'qr')).qr;
      expect(
        err(await confirm(w, drv, d.ticketId, qr.link_code_id, true), 'INVALID_STATE_TRANSITION', 409),
      ).toMatchObject({
        entity_type: 'link_code',
        current_status: 'active',
        allowed_from: ['pending_confirmation'],
      });
      ok(await submitIntake(w, drv, d.ticketId, { expected_version: d.version }));
      await w.sim.client.sendLinkCode(newPhone(), qr.code, { timestamp: w.ts() });
      await w.drain();
      expect(
        err(await confirm(w, 'DRV2', d.ticketId, qr.link_code_id, true), 'PERMISSION_DENIED', 403),
      ).toMatchObject({ reason: 'not_link_code_creator' });
      expect(
        err(
          await confirm(w, drv, d.ticketId, '00000000-0000-4000-8000-0000deadbeef', true),
          'RESOURCE_NOT_FOUND',
          404,
        ),
      ).toEqual({ resource: 'link_code' });
      err(await confirm(w, drv, d.ticketId, 'not-a-uuid', true), 'VALIDATION_FAILED', 422);
      ok(await confirm(w, 'SUP-R', d.ticketId, qr.link_code_id, true));
      expect((await ticketRow(w, d.ticketId)).wa_link_status).toBe('linked');
    });

    it('QR after a failed direct link; a BSUID-only sender (…2222) becomes the customer and his W-01 goes to `recipient` (TC-WA-23)', async () => {
      const drv = await freshDriver(w);
      const t = await whatsappTicket(w, drv, '+966500030000');
      await w.drain();
      const [m] = await messagesTo(w, t.phone);
      await w.sim.client.emitStatuses({ wamid: m!.wamid, timestamp: w.ts() });
      await w.drain();
      expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('failed');
      await park(w, drv, t.taskId);
      const qr = ok(await link(w, drv, t.ticketId, 'qr')).qr;
      await w.sim.client.sendLinkCode('+966500032222', qr.code, { timestamp: w.ts() });
      await w.drain();
      expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('pending_confirmation');
      ok(await confirm(w, drv, t.ticketId, qr.link_code_id, true));
      const after = await ticketRow(w, t.ticketId);
      expect(after).toMatchObject({ wa_link_status: 'linked', link_version: 2 }); // new customer, new buttons
      const customer = (
        await w.db.query(`SELECT phone_e164, wa_user_id FROM customers WHERE id = $1`, [after.customer_id])
      ).rows[0];
      expect(customer.phone_e164).toBeNull();
      expect(customer.wa_user_id).toBeTruthy();
      expect(
        (
          await w.db.query(
            `SELECT method, revoked_at IS NOT NULL AS revoked FROM customer_consents WHERE ticket_id = $1 ORDER BY captured_at, method DESC`,
            [t.ticketId],
          )
        ).rows,
      ).toEqual([
        { method: 'verbal_staff_confirmed', revoked: true },
        { method: 'customer_initiated', revoked: false },
      ]);
      await settle(w, '+966500032222');
      const w01 = (await w.sim.client.listMessages({ purpose: 'W-01' })).filter(
        (x) => x.recipient === customer.wa_user_id,
      );
      expect(w01).toHaveLength(1);
      expect(w01[0]!.to).toBeNull();
    });

    it('a customer who opted out comes back through his own QR message (12 §7.6): consent resumed at confirm', async () => {
      const drv = await freshDriver(w);
      const phone = newPhone();
      const t = await whatsappTicket(w, drv, phone);
      await settle(w, phone);
      await w.sim.client.sendStop(phone, { timestamp: w.ts() });
      await w.drain();
      expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('opted_out');
      err(await link(w, drv, t.ticketId, 'direct'), 'WA_CUSTOMER_OPTED_OUT', 409);
      const qr = ok(await link(w, drv, t.ticketId, 'qr')).qr;
      await w.sim.client.sendLinkCode(phone, qr.code, { timestamp: w.ts() });
      await w.drain();
      ok(await confirm(w, drv, t.ticketId, qr.link_code_id, true));
      const c = (
        await w.db.query(
          `SELECT wa_opted_out_at FROM customers WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
          [t.ticketId],
        )
      ).rows[0];
      expect(c.wa_opted_out_at).toBeNull();
      expect(await ticketRow(w, t.ticketId)).toMatchObject({ wa_link_status: 'linked', link_version: 2 });
      await settle(w, phone);
      // W-12 is the only message after the stop: W-11 to his link message is skipped (opted_out) until the
      // driver's confirmation resumes the consent; then W-01 again
      expect(await purposes(w, phone)).toEqual(['W-01', null, 'W-01']);
      expect((await messagesTo(w, phone))[1]!.renderedText).toBe(waMessageText('W-12'));
      const w11 = await w.db.query(
        `SELECT status, skipped_reason FROM notifications WHERE purpose = 'W-11' AND recipient_customer_id = (SELECT customer_id FROM tickets WHERE id = $1)`,
        [t.ticketId],
      );
      expect(w11.rows).toEqual([{ status: 'skipped', skipped_reason: 'opted_out' }]);
    });
  });
});
