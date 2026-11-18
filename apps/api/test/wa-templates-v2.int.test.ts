import { assertTemplateApproved } from '@point/server';
import {
  WA_CUSTOMER_OTP_TEMPLATE_NAME,
  WA_TEMPLATE_NAMES,
  WA_TEMPLATE_NAMES_V2,
  renderWaText,
} from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORG,
  createClaimCode,
  createCycle,
  createTicket,
  createWaTestApp,
  emit,
  type TicketFixture,
  type WaTestApp,
} from './wa-harness.js';

const APP_LINK = 'https://apps.example.org/point';

/**
 * V2-050 (DEC-555, DEC-556): a server whose live template set is `v2` sends the `point_*_v2` templates — the venue in
 * every message, the operator in W-01 — syncs only that set (the earlier `v1` is no longer created), checks the `v2`
 * names early, and adds the app line to W-10 when CUSTOMER_APP_LINK is set.
 */
describe('WhatsApp template set v2 and the app line (V2-050)', () => {
  let w: WaTestApp;
  let operator: string;
  beforeAll(async () => {
    w = await createWaTestApp({ env: { WA_TEMPLATE_SET: 'v2', CUSTOMER_APP_LINK: APP_LINK } });
    await w.syncTemplates();
    operator = (await w.db.query(`SELECT name_ar FROM organizations WHERE id = $1`, [ORG])).rows[0].name_ar;
  });
  afterAll(async () => w?.close());

  const sentFor = async (t: TicketFixture) =>
    (await w.sim.client.listMessages({ type: 'template' })).filter(
      (m) => m.bodyParams[m.purpose === 'W-01' ? 1 : 0] === String(t.displayNumber),
    );

  it('the sync stores the v2 set and the sign-in template; nothing of v1 is created', async () => {
    const r = await w.get('/v1/admin/whatsapp/templates', 'OWN1');
    expect(r.body.data.map((t: { name: string; language: string }) => `${t.name}:${t.language}`)).toEqual([
      ...WA_TEMPLATE_NAMES_V2.map((n) => `${n}:ar`),
      `${WA_CUSTOMER_OTP_TEMPLATE_NAME}:ar`,
      `${WA_CUSTOMER_OTP_TEMPLATE_NAME}:en`,
    ]);
    expect(w.rt.catalog.syncDefinitions.map((d) => d.name)).toEqual([...WA_TEMPLATE_NAMES_V2]);
    expect(
      (
        await w.db.query(`SELECT 1 FROM whatsapp_templates WHERE name = ANY($1::text[])`, [
          [...WA_TEMPLATE_NAMES],
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('W-01: point_ticket_issued_v2 with the venue, the ticket, the operator and the vehicle; one «طلب السيارة»', async () => {
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
      templateName: 'point_ticket_issued_v2',
      bodyParams: ['قاعة ريماس', String(t.displayNumber), operator, 'تويوتا كامري بيضاء — لوحة 4821'],
    });
    expect(m!.buttons).toHaveLength(1);
    expect(m!.renderedText).toContain(`تشغيل: ${operator}`);
    const row = (
      await w.db.query(
        `SELECT template_name, body_redacted FROM whatsapp_messages WHERE ticket_id = $1 AND direction = 'outbound'`,
        [t.id],
      )
    ).rows[0];
    expect(row.template_name).toBe('point_ticket_issued_v2');
    expect(row.body_redacted).toBe(
      renderWaText(w.rt.catalog.byId('W-01').body_ar, [
        'قاعة ريماس',
        String(t.displayNumber),
        operator,
        'تويوتا كامري بيضاء — لوحة 4821',
      ]),
    );
  });

  it('W-05: point_vehicle_ready_v2 names the venue; the code is {{3}}, masked in our rows', async () => {
    const t = await createTicket(w, { status: 'ready' });
    const cycle = await createCycle(w, t);
    const claim = await createClaimCode(w, t, cycle, '613204');
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
      templateName: 'point_vehicle_ready_v2',
      bodyParams: [String(t.displayNumber), 'قاعة ريماس', '613204'],
    });
    expect((await w.sim.client.claimCodeDetails('+966551234567'))?.code).toBe('613204');
    const row = (
      await w.db.query(
        `SELECT m.body_redacted FROM claim_codes c JOIN whatsapp_messages m ON m.id = c.sent_message_id WHERE c.id = $1`,
        [claim],
      )
    ).rows[0];
    expect(row.body_redacted).toContain('في قاعة ريماس.\nرمز التسليم: ••••••');
    expect(JSON.stringify(row)).not.toContain('613204');
  });

  it('the early checks test the live set: a paused point_ticket_issued_v2 refuses W-01 (WA_TEMPLATE_NOT_APPROVED)', async () => {
    await w.db.query(`UPDATE whatsapp_templates SET status = 'paused' WHERE org_id = $1 AND name = $2`, [
      ORG,
      'point_ticket_issued_v2',
    ]);
    try {
      await expect(w.db.transaction((tx) => assertTemplateApproved(tx, ORG, 'W-01'))).rejects.toMatchObject({
        code: 'WA_TEMPLATE_NOT_APPROVED',
        details: { template_name: 'point_ticket_issued_v2', template_status: 'paused' },
      });
    } finally {
      await w.db.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE org_id = $1 AND name = $2`, [
        ORG,
        'point_ticket_issued_v2',
      ]);
    }
    await w.db.transaction((tx) => assertTemplateApproved(tx, ORG, 'W-01'));
  });

  it('W-10 carries the app line with CUSTOMER_APP_LINK (session text, no link preview)', async () => {
    await w.sim.client.sendText({ from: '+966559876543', body: 'السلام عليكم', timestamp: w.ts() });
    await w.flush();
    const [reply] = await w.sim.client.listMessages({ to: '+966559876543', type: 'text' });
    expect(reply!.text).toBe(w.rt.catalog.messageText('W-10'));
    expect(reply!.text).toContain(`\n\nلطلب سيارتك ومتابعتها في زيارتك القادمة، حمّل تطبيق `);
    expect(reply!.text!.endsWith(APP_LINK)).toBe(true);
    expect((reply!.request as { text: { preview_url: boolean } }).text.preview_url).toBe(false);
  });
});
