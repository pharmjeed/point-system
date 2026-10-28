import { SEED_IDS } from '@point/db/seed';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  createS2App,
  err,
  EVT_L1,
  newDraft,
  ok,
  one,
  paperTicketInParking,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { deliveredTicket, DUMMY, ORG, whatsappTicket } from './supervisor-fixtures.js';

const CHANNEL = SEED_IDS.whatsappChannel;

/** PNT-076 — GET /v1/tickets/{ticketId}/timeline (S-03; 09 §5.1). */
describe('ticket timeline', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV3'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
  });
  afterEach(async () => t.close());

  const timeline = (as: string, ticketId: string) => t.get(`/v1/tickets/${ticketId}/timeline`, as);

  it('staff read everything, oldest first: events, the custody chain, cycles, tasks, payments, incidents and signed photo URLs', async () => {
    const d = await deliveredTicket(t);
    ok(
      await t.command('post', '/v1/incidents', {
        as: 'SUP-R',
        body: {
          venue_id: SEED_IDS.venues.RMS,
          ticket_id: d.ticketId,
          type: 'other',
          description: 'ملاحظة بعد التسليم',
        },
      }),
      201,
    );
    const tl = ok(await timeline('SUP-R', d.ticketId));
    expect(tl.ticket).toMatchObject({ id: d.ticketId, status: 'delivered', display_number: d.displayNumber });
    const types = tl.events.map((e: any) => e.type);
    for (const type of [
      'ticket.intake_submitted',
      'ticket.parked',
      'ticket.retrieval_requested',
      'task.claimed',
      'ticket.ready',
      'ticket.delivered',
    ])
      expect(types).toContain(type);
    expect(types.indexOf('ticket.parked')).toBeLessThan(types.indexOf('ticket.delivered'));
    const ids = tl.events.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
    expect(tl.events[0]).toMatchObject({
      id: expect.any(Number),
      actor_type: 'user',
      ticket_version: expect.any(Number),
    });
    expect(
      tl.custody.map((c: any) => `${c.subject}:${c.reason}:${c.from_holder_type}>${c.to_holder_type}`),
    ).toEqual([
      'vehicle:intake:customer>driver',
      'key:intake:customer>driver',
      'vehicle:parked:driver>spot',
      'key:key_deposited:driver>key_slot',
      'key:key_pickup:key_slot>driver',
      'vehicle:retrieval_start:spot>driver',
      'vehicle:handover:driver>customer',
      'key:handover:driver>customer',
    ]);
    expect(tl.custody[0].actor).toMatchObject({ id: U.DRV2, full_name: expect.any(String) });
    expect(tl.cycles).toHaveLength(1);
    expect(tl.cycles[0]).toMatchObject({ id: d.cycleId, outcome: 'delivered', cycle_no: 1 });
    expect(tl.tasks.map((k: any) => [k.type, k.status])).toEqual([
      ['park', 'completed'],
      ['retrieve', 'completed'],
    ]);
    expect(tl.tasks[1].assignee).toMatchObject({ id: U.DRV1 });
    expect(tl.payments).toEqual([]);
    expect(tl.incidents).toHaveLength(1);
    expect(tl.incidents[0]).toMatchObject({ ticket_id: d.ticketId, type: 'other' });
    // four uploaded inspection photos, each with a short-lived signed URL (09 §6.3)
    expect(tl.media).toHaveLength(4);
    for (const m of tl.media) {
      expect(m.upload_status).toBe('uploaded');
      expect(m.read_url).toMatchObject({ url: expect.any(String), expires_at: expect.any(String) });
      expect(new Date(m.read_url.expires_at).getTime() - t.clock.now().getTime()).toBeLessThanOrEqual(
        300_000,
      );
      expect(m).not.toHaveProperty('storage_key');
    }
    // admin and owner read it too; the timeline needs no Idempotency-Key and is never cached
    const res = await timeline('ADM1', d.ticketId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    ok(await timeline('OWN1', d.ticketId));
  });

  it('the handover code never appears; what the customer typed is masked (phone, code, link code)', async () => {
    const w = await whatsappTicket(t, 'DRV2', { phone: '0557654321', park: true });
    await t.db.query(`UPDATE tickets SET wa_link_status = 'linked' WHERE id = $1`, [w.ticketId]);
    const ticketId = w.ticketId;
    const customer = (await one(t.db, `SELECT customer_id FROM tickets WHERE id = $1`, [ticketId]))
      .customer_id;
    const cycle = await one(
      t.db,
      `INSERT INTO retrieval_cycles (org_id, venue_id, ticket_id, cycle_no, requested_at, request_source, requested_by_user_id, request_reason)
       SELECT org_id, venue_id, id, 9, now(), 'staff', $2, 'اختبار' FROM tickets WHERE id = $1 RETURNING id`,
      [ticketId, U['SUP-R']],
    );
    const code = '482913';
    await t.db.query(
      `INSERT INTO claim_codes (org_id, ticket_id, cycle_id, code_hash, code_ciphertext, expires_at)
       VALUES ($1, $2, $3, 'hash-of-482913', 'cipher-xyz', now() + interval '30 minutes')`,
      [ORG, ticketId, cycle.id],
    );
    const insert = (direction: string, kind: string, status: string, purpose: string | null, body: string) =>
      t.db.query(
        `INSERT INTO whatsapp_messages (org_id, channel_id, direction, customer_id, ticket_id, venue_id, kind, purpose, body_redacted, status, status_rank,
                                        received_at, queued_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, CASE WHEN $3 = 'inbound' THEN now() END, CASE WHEN $3 = 'outbound' THEN now() END, now(), now())`,
        [ORG, CHANNEL, direction, customer, ticketId, SEED_IDS.venues.RMS, kind, purpose, body, status],
      );
    await insert('outbound', 'template', 'sent', 'W-05', 'سيارتك جاهزة. رمز التسليم: ••••••');
    await insert('outbound', 'template', 'failed', 'W-04', 'جارٍ إحضار سيارتك');
    await insert(
      'inbound',
      'inbound_text',
      'received',
      null,
      `رمزي ${code} ورقمي 0557654321 وربط تذكرة مصاف K7Q29F`,
    );
    const tl = ok(await timeline('SUP-R', ticketId));
    const json = JSON.stringify(tl);
    for (const secret of [code, 'cipher-xyz', 'hash-of-482913', '0557654321', '557654321', 'K7Q29F'])
      expect(json).not.toContain(secret);
    const inbound = tl.messages.find((m: any) => m.direction === 'inbound');
    expect(inbound.body_redacted).toBe('رمزي •••••• ورقمي •••••• وربط تذكرة مصاف ••••••');
    expect(tl.messages.find((m: any) => m.purpose === 'W-05').body_redacted).toBe(
      'سيارتك جاهزة. رمز التسليم: ••••••',
    );
    expect(tl.messages[0]).not.toHaveProperty('recipient_wa_id');
  });

  it('a driver: only the assignee or the intake creator, his own steps, no customer message bodies', async () => {
    const w = await whatsappTicket(t, 'DRV2', { park: true });
    await t.db.query(`UPDATE tickets SET wa_link_status = 'linked' WHERE id = $1`, [w.ticketId]);
    await t.db.query(
      `INSERT INTO whatsapp_messages (org_id, channel_id, direction, ticket_id, kind, purpose, body_redacted, status, status_rank, queued_at, created_at, updated_at)
       VALUES ($1, $2, 'outbound', $3, 'template', 'W-01', 'تذكرتك في مصاف', 'sent', 1, now(), now(), now()),
              ($1, $2, 'outbound', $3, 'template', 'W-02', 'تم تسجيل طلبك', 'sent', 1, now(), now(), now())`,
      [ORG, CHANNEL, w.ticketId],
    );
    // DRV2 parked it: once parked he is no longer eligible (no open task, intake over)
    err(await timeline('DRV2', w.ticketId), 'TICKET_NOT_FOUND', 404);
    t.clock.advanceSeconds(1);
    ok(
      await t.command('post', `/v1/tickets/${w.ticketId}/retrievals`, {
        as: 'SUP-R',
        body: { reason: 'العميل عند البوابة' },
      }),
      201,
    );
    const offer = await one(
      t.db,
      `SELECT o.id FROM task_offers o JOIN tasks k ON k.id = o.task_id WHERE k.ticket_id = $1 AND o.status = 'active'`,
      [w.ticketId],
    );
    ok(await t.command('post', `/v1/task-offers/${offer.id}/accept`, { as: 'DRV1', body: {} }));
    const mine = ok(await timeline('DRV1', w.ticketId));
    // his task only, his cycle, no intake steps of DRV2, no incidents, W-01 status without its text, no W-02
    expect(mine.tasks.map((k: any) => k.type)).toEqual(['retrieve']);
    expect(mine.cycles).toHaveLength(1);
    expect(mine.events.map((e: any) => e.type)).not.toContain('ticket.intake_submitted');
    expect(mine.events.map((e: any) => e.type)).toContain('task.claimed');
    expect(mine.custody).toEqual([]); // nothing of his yet: the key is still on the board
    expect(mine.messages.map((m: any) => [m.purpose, m.status, m.body_redacted])).toEqual([
      ['W-01', 'sent', null],
    ]);
    expect(mine.incidents).toEqual([]);
    expect(mine.payments).toEqual([]);
    // other drivers of the venue, staff outside the scope, unknown tickets
    err(await timeline('DRV3', w.ticketId), 'TICKET_NOT_FOUND', 404);
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(await timeline('SUP-R', lyl.ticketId), 'TICKET_NOT_FOUND', 404);
    err(await timeline('DRV1', lyl.ticketId), 'TICKET_NOT_FOUND', 404);
    err(await timeline('SUP-R', DUMMY), 'TICKET_NOT_FOUND', 404);
    err(await timeline('SUP-R', 'x'), 'TICKET_NOT_FOUND', 404);
    // the intake creator during intake reads his draft
    const p = await paperTicketInParking(t, 'DRV3');
    const creator = ok(await timeline('DRV3', p.ticketId));
    expect(creator.events.map((e: any) => e.type)).toContain('ticket.intake_submitted');
    expect(creator.media.every((m: any) => m.read_url)).toBe(true);
  });

  it('supervisor actions are refused to drivers on the server whatever the UI shows (PNT-076 AC2)', async () => {
    const p = await paperTicketInParking(t, 'DRV1');
    const body = { reason: 'محاولة من سائق', evidence: { paper_log_ref: '1' }, target_status: 'parked' };
    for (const path of ['reveal-phone', 'inspection-exception', 'manual-reconcile'])
      err(
        await t.command('post', `/v1/tickets/${p.ticketId}/${path}`, { as: 'DRV1', body }),
        'PERMISSION_DENIED',
        403,
      );
    err(
      await t.command('post', `/v1/tickets/${p.ticketId}/custody-transfers`, {
        as: 'DRV1',
        body: { subject: 'key', to_holder_type: 'unknown', reason: 'سائق' },
      }),
      'PERMISSION_DENIED',
      403,
    );
    err(await t.get(`/v1/events/${SEED_IDS.events['EVT-R1']}/operations`, 'DRV1'), 'PERMISSION_DENIED', 403);
  });
});
