import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { SEED_IDS } from '@point/db/seed';
import { collectRoutes } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brand as simBrand } from '../../../tools/wa-simulator/src/catalog.js';
import { customerCopy, testEnv } from './test-env.js';
import {
  createCustomerApp,
  cyclesOf,
  messagesTo,
  onDuty,
  park,
  press,
  settle,
  tablesContaining,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import {
  accept,
  addPhotos,
  expectConsistent,
  handover,
  keyPickup,
  markReady,
  newDraft,
  ok,
  PAPER_DRAFT,
  patchIntake,
  startRetrieval,
  submitIntake,
  U,
} from './dispatch-fixtures.js';

const CUS1_PHONE = '+966551234567';
const CUS2_PHONE = '+966559876543';

async function liveOfferFor(w: CustomerApp, ticketId: string) {
  return (
    await w.db.query<{
      id: string;
      task_id: string;
      user_id: string;
      mode: string;
      dispatch_pool_id: string;
    }>(
      `SELECT o.id, o.task_id, o.mode, o.dispatch_pool_id, r.user_id FROM task_offers o
         JOIN offer_recipients r ON r.offer_id = o.id JOIN tasks k ON k.id = o.task_id
        WHERE k.ticket_id = $1 AND o.status = 'active'`,
      [ticketId],
    )
  ).rows;
}

/**
 * Gate G2 (16 PNT-051; 17 §5): a customer asks for his car and receives it without opening any web page —
 * W-01 → «طلب السيارة» → W-02 → offer and accept → W-04 → W-05 → handover with the code → W-06, through the
 * real routes, the worker jobs and the WhatsApp simulator; then the QR link, the opt-out and a second venue
 * on the same number; and the route check: no customer web route exists.
 */
describe('G2 — the customer through WhatsApp only (PNT-051)', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
    await onDuty(w, 'DRV2'); // idle longest: the request's single offer goes to him
    w.clock.advance(1_000);
    await onDuty(w, 'DRV1', 'DRV3', 'DRV7', 'DRV8');
  });
  afterAll(async () => w?.close());

  it('direct link → W-01 → the button → W-02 → offer/accept → W-04 → W-05 → handover with the code → W-06 (AC-18, AC-19, AC-09)', async () => {
    const t = await whatsappTicket(w, 'DRV1', CUS1_PHONE);
    expect(t.submit!.body.data).toMatchObject({ status: 'parking', wa_link_status: 'pending_send' });
    await settle(w, CUS1_PHONE);
    const w01 = (await messagesTo(w, CUS1_PHONE)).at(-1)!;
    expect(w01).toMatchObject({ purpose: 'W-01', phoneNumberId: 'SIM-PHONE' });
    expect((await ticketRow(w, t.ticketId)).wa_link_status).toBe('linked');
    w.clock.advance(1_000);
    const { slotId, spot } = await park(w, 'DRV1', t.taskId);

    w.clock.advance(5_000);
    await press(w, CUS1_PHONE, { wamid: w01.wamid });
    await w.drain();
    const [cycle] = await cyclesOf(w, t.ticketId);
    expect(cycle).toMatchObject({
      request_source: 'whatsapp',
      requested_by_customer_id: SEED_IDS.customers.CUS1,
      requested_early: false,
    });
    const [offer] = await liveOfferFor(w, t.ticketId);
    expect(offer).toMatchObject({ mode: 'single', user_id: U.DRV2 });
    await settle(w, CUS1_PHONE);

    // one second between the driver's steps keeps the custody chain ordered by time
    ok(await accept(w, 'DRV2', offer!.id));
    await settle(w, CUS1_PHONE);
    w.clock.advance(1_000);
    ok(await keyPickup(w, 'DRV2', offer!.task_id, slotId));
    w.clock.advance(1_000);
    ok(await startRetrieval(w, 'DRV2', offer!.task_id));
    await settle(w, CUS1_PHONE);
    w.clock.advance(1_000);
    ok(await markReady(w, 'DRV2', offer!.task_id));
    await settle(w, CUS1_PHONE);
    w.clock.advance(1_000);
    const code = await w.sim.client.claimCode(CUS1_PHONE);
    expect(code).toMatch(/^[0-9]{6}$/);
    const done = ok(await handover(w, 'DRV2', t.ticketId, { verification: { method: 'code', code } }));
    expect(done.ticket).toMatchObject({ status: 'delivered' });
    await settle(w, CUS1_PHONE);

    const conversation = await messagesTo(w, CUS1_PHONE);
    expect(conversation.map((m) => m.purpose)).toEqual(['W-01', 'W-02', 'W-04', 'W-05', 'W-06']);
    expect(new Set(conversation.map((m) => m.phoneNumberId))).toEqual(new Set(['SIM-PHONE']));
    // AC-18 / TC-056: the only button of the whole conversation is W-01's «طلب السيارة»
    const buttons = conversation.flatMap((m) => m.buttons.map((b) => ({ purpose: m.purpose, text: b.text })));
    expect(buttons).toEqual([{ purpose: 'W-01', text: 'طلب السيارة' }]);
    // canon §1 (DEC-470): only the customer brand — the simulator renders its approved bodies with its own
    // configured brand, our copy (body_redacted) carries the API's BRAND_CUSTOMER_NAME_AR
    const staffBrand = testEnv().BRAND_STAFF_NAME_AR;
    for (const m of conversation) expect(m.renderedText ?? '').not.toContain(staffBrand);
    expect(conversation[0]!.renderedText).toContain(simBrand().customerNameAr);
    const w01Copy = await w.db.query<{ body_redacted: string }>(
      `SELECT body_redacted FROM whatsapp_messages WHERE direction = 'outbound' AND purpose = 'W-01' AND ticket_id = $1`,
      [t.ticketId],
    );
    expect(w01Copy.rows.map((r) => r.body_redacted.startsWith(`${customerCopy.customerBrandAr} — `))).toEqual(
      [true],
    );

    // AC-19: each act by its actor
    const ticket = await ticketRow(w, t.ticketId);
    expect(ticket).toMatchObject({
      created_by: U.DRV1,
      parked_by: U.DRV1,
      retrieved_by: U.DRV2,
      delivered_by: U.DRV2,
      status: 'delivered',
    });
    const closed = (await cyclesOf(w, t.ticketId))[0];
    expect(closed).toMatchObject({
      accepted_by: U.DRV2,
      retrieved_by: U.DRV2,
      delivered_by: U.DRV2,
      handover_method: 'code',
    });
    const chain = (
      await w.db.query(
        `SELECT subject, from_holder_type, to_holder_type, reason, actor_id FROM custody_events WHERE ticket_id = $1 ORDER BY occurred_at, id`,
        [t.ticketId],
      )
    ).rows;
    expect(
      chain
        .filter((c) => c.subject === 'vehicle')
        .map((c) => [c.from_holder_type, c.to_holder_type, c.reason, c.actor_id]),
    ).toEqual([
      ['customer', 'driver', 'intake', U.DRV1],
      ['driver', 'spot', 'parked', U.DRV1],
      ['spot', 'driver', 'retrieval_start', U.DRV2],
      ['driver', 'customer', 'handover', U.DRV2],
    ]);
    expect(spot).toBeTruthy();
    // AC-09: the code was never stored in clear, logged, audited or put in an event; its copy is purged
    const claim = (
      await w.db.query(`SELECT code_ciphertext, consumed_by FROM claim_codes WHERE ticket_id = $1`, [
        t.ticketId,
      ])
    ).rows;
    expect(claim).toEqual([{ code_ciphertext: null, consumed_by: U.DRV2 }]);
    expect(await tablesContaining(w, code!, new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`))).toEqual([]);
    await expectConsistent(w.db);
  });

  it('QR link (customer-initiated), «إيقاف» then the button (consent resumed), and a second venue on the same number', async () => {
    // QR: the draft has no phone; the customer sends the prefilled text, the driver confirms the match
    const d = await newDraft(w, 'DRV3');
    const p = ok(
      await patchIntake(w, 'DRV3', d.ticketId, {
        expected_version: d.version,
        ...PAPER_DRAFT('X', 'G2-QR', '6262'),
        channel: 'whatsapp',
        paper_serial: null,
      }),
    );
    await addPhotos(w.db, d.ticketId, U.DRV3);
    const qr = ok(
      await w.command('post', `/v1/tickets/${d.ticketId}/whatsapp-link`, {
        as: 'DRV3',
        body: { method: 'qr' },
      }),
    ).qr;
    ok(await submitIntake(w, 'DRV3', d.ticketId, { expected_version: p.version }));
    await w.sim.client.sendLinkCode(CUS2_PHONE, qr.code, { timestamp: w.ts() });
    await w.drain();
    expect((await messagesTo(w, CUS2_PHONE)).map((m) => m.renderedText)).toEqual([
      customerCopy.messageText('W-11', 'received'),
    ]);
    ok(
      await w.command('post', `/v1/tickets/${d.ticketId}/whatsapp-link/confirm`, {
        as: 'DRV3',
        body: { link_code_id: qr.link_code_id, matches: true },
      }),
    );
    await settle(w, CUS2_PHONE);
    expect(await ticketRow(w, d.ticketId)).toMatchObject({
      wa_link_status: 'linked',
      customer_id: SEED_IDS.customers.CUS2,
    });
    await park(w, 'DRV3', d.taskId);

    // «إيقاف»: W-12 only; then the button press resumes the consent and requests the car (TC-WA-18)
    await w.sim.client.sendStop(CUS2_PHONE, { timestamp: w.ts() });
    await settle(w, CUS2_PHONE);
    expect((await ticketRow(w, d.ticketId)).wa_link_status).toBe('opted_out');
    const qrW01 = (await messagesTo(w, CUS2_PHONE)).find((m) => m.purpose === 'W-01')!;
    w.clock.advance(20_000);
    await press(w, CUS2_PHONE, { wamid: qrW01.wamid });
    await settle(w, CUS2_PHONE);
    expect(await ticketRow(w, d.ticketId)).toMatchObject({ wa_link_status: 'linked', status: 'requested' });
    expect((await messagesTo(w, CUS2_PHONE)).map((m) => m.purpose ?? m.renderedText)).toEqual([
      customerCopy.messageText('W-11', 'received'),
      'W-01',
      customerCopy.messageText('W-12'),
      'W-02',
    ]);

    // a second venue on the same number: LYL ticket, its button reaches the LYL pool only
    const lyl = await whatsappTicket(w, 'DRV7', CUS2_PHONE, { venue: 'LYL' });
    await settle(w, CUS2_PHONE);
    await park(w, 'DRV7', lyl.taskId, 'LYL');
    const lylW01 = (await messagesTo(w, CUS2_PHONE)).filter((m) => m.purpose === 'W-01').at(-1)!;
    expect(lylW01.bodyParams[0]).toBe('قاعة ليلتي');
    await press(w, CUS2_PHONE, { wamid: lylW01.wamid });
    await w.drain();
    const offers = await liveOfferFor(w, lyl.ticketId);
    expect(offers.length).toBe(1);
    expect([U.DRV7, U.DRV8]).toContain(offers[0]!.user_id);
    expect(offers[0]!.dispatch_pool_id).toBe(SEED_IDS.pools['POOL-L']);
    expect((await cyclesOf(w, d.ticketId)).length).toBe(1); // the RMS ticket was not requested twice
    await settle(w, CUS2_PHONE);
    expect((await messagesTo(w, CUS2_PHONE)).every((m) => m.phoneNumberId === 'SIM-PHONE')).toBe(true);
  });

  it('PNT-051 acceptance 1: no customer web route — every route without a session is login, MFA, health or the signed webhook', () => {
    const routes = collectRoutes(
      w.app.get(DiscoveryService),
      w.app.get(MetadataScanner),
      w.app.get(Reflector),
    );
    const open = routes
      .filter((r) => r.public)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(open).toEqual(
      [
        'GET /health/live',
        'GET /health/ready',
        'GET /webhooks/whatsapp',
        'POST /v1/auth/login',
        'POST /v1/auth/mfa/verify',
        // V2-002: the platform console's own sign-in steps (staff of the platform, never a customer, DEC-462)
        'POST /v1/platform/auth/login',
        'POST /v1/platform/auth/mfa/verify',
        'POST /webhooks/whatsapp',
      ].filter((x) => open.includes(x)),
    );
    expect(
      open.every((x) =>
        /^(GET|POST) \/(health|webhooks\/whatsapp|v1\/(platform\/)?auth\/(login|mfa\/verify)$)/.test(x),
      ),
    ).toBe(true);
    // the ticket and customer routes all need a staff permission
    const customerSide = routes.filter((r) => /tickets|customer|handover|whatsapp-link/.test(r.path));
    expect(customerSide.length).toBeGreaterThan(10);
    expect(customerSide.every((r) => !r.public && !!r.permission)).toBe(true);
  });
});
