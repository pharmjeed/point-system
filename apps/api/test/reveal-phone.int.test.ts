import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newKey, type TestApp } from './harness.js';
import {
  createS2App,
  err,
  EVT_L1,
  newDraft,
  ok,
  one,
  parkedPaperTicket,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { DUMMY, ORG, whatsappTicket } from './supervisor-fixtures.js';

/** PNT-077 — POST /v1/tickets/{ticketId}/reveal-phone (09 §5.1 rule 2, §11; security.reveal_phone_per_hour). */
describe('reveal-phone', () => {
  let t: TestApp;
  let ticket: Awaited<ReturnType<typeof whatsappTicket>>;
  const PHONE = '+966551239876';
  beforeAll(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
    ticket = await whatsappTicket(t, 'DRV1', { phone: '0551239876', park: true });
  });
  afterAll(async () => t.close());

  const reveal = (as: string, ticketId: string, body: unknown, key = newKey()) =>
    t.command('post', `/v1/tickets/${ticketId}/reveal-phone`, { as, body, key });

  /** Every text column the audit, events and replay store could carry the number in. */
  const phoneAnywhere = async () =>
    one(
      t.db,
      `SELECT (SELECT count(*)::int FROM audit_log WHERE concat_ws(' ', reason, before::text, after::text, metadata::text) LIKE $1) AS audit,
              (SELECT count(*)::int FROM outbox_events WHERE payload::text LIKE $1) AS outbox,
              (SELECT count(*)::int FROM ticket_events WHERE data::text LIKE $1) AS ticket_events,
              (SELECT count(*)::int FROM idempotency_keys WHERE response_body::text LIKE $1) AS replays`,
      [`%551239876%`],
    );

  it('returns the full number once, no-store, with one audit row carrying the reason and the counter only', async () => {
    const before = await phoneAnywhere();
    const k = newKey();
    const res = await reveal('SUP-R', ticket.ticketId, { reason: 'التواصل مع العميل لعدم الحضور' }, k);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toEqual({ phone_e164: PHONE, revealed_at: t.clock.now().toISOString() });
    const a = await one(
      t.db,
      `SELECT actor_id, entity_type, entity_id, venue_id, reason, before, after, metadata FROM audit_log
        WHERE action = 'ticket.reveal_phone'`,
    );
    expect(a).toMatchObject({
      actor_id: U['SUP-R'],
      entity_type: 'ticket',
      entity_id: ticket.ticketId,
      reason: 'التواصل مع العميل لعدم الحضور',
      before: null,
      after: null,
    });
    expect(a.metadata).toMatchObject({ reveals_in_window: 1, reveal_phone_per_hour: 20 });
    // the number is nowhere new: not in the audit, the events or the stored replay (masked there)
    expect(await phoneAnywhere()).toEqual(before);
    const replay = await reveal('SUP-R', ticket.ticketId, { reason: 'التواصل مع العميل لعدم الحضور' }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.phone_e164).toBe('05•••••876');
    // the driver's ticket detail still shows only the masked number
    const detail = ok(await t.get(`/v1/tickets/${ticket.ticketId}`, 'SUP-R'));
    expect(detail.customer.phone_masked).toBe('05•••••876');
    expect(JSON.stringify(detail)).not.toContain('551239876');
  });

  it('REASON_REQUIRED without a reason; drivers are PERMISSION_DENIED; owner and admin may reveal', async () => {
    expect(err(await reveal('SUP-R', ticket.ticketId, {}), 'REASON_REQUIRED', 422)).toEqual({
      field: 'reason',
      min_length: 3,
    });
    err(await reveal('SUP-R', ticket.ticketId, { reason: '  ا ' }), 'REASON_REQUIRED', 422);
    err(await reveal('SUP-R', ticket.ticketId, { reason: 'سبب', extra: true }), 'VALIDATION_FAILED', 422);
    err(await reveal('DRV1', ticket.ticketId, { reason: 'أريد الرقم' }), 'PERMISSION_DENIED', 403);
    expect(ok(await reveal('ADM1', ticket.ticketId, { reason: 'تصحيح رقم' })).phone_e164).toBe(PHONE);
    expect(ok(await reveal('OWN1', ticket.ticketId, { reason: 'واقعة' })).phone_e164).toBe(PHONE);
  });

  it('TICKET_NOT_FOUND outside the scope or unknown; RESOURCE_NOT_FOUND for a ticket without a phone', async () => {
    const lyl = await newDraft(t, 'DRV7', EVT_L1);
    err(await reveal('SUP-R', lyl.ticketId, { reason: 'خارج النطاق' }), 'TICKET_NOT_FOUND', 404);
    err(await reveal('SUP-R', DUMMY, { reason: 'غير موجودة' }), 'TICKET_NOT_FOUND', 404);
    err(await reveal('SUP-R', 'abc', { reason: 'غير صالحة' }), 'TICKET_NOT_FOUND', 404);
    const paper = await parkedPaperTicket(t, 'DRV1');
    expect(
      err(await reveal('SUP-R', paper.ticketId, { reason: 'تذكرة ورقية' }), 'RESOURCE_NOT_FOUND', 404),
    ).toEqual({
      resource: 'customer',
    });
  });

  it('RATE_LIMITED with Retry-After beyond security.reveal_phone_per_hour per user (rolling hour); not stored', async () => {
    await t.db.query(
      `UPDATE organizations SET settings = jsonb_set(settings, '{security,reveal_phone_per_hour}', '2'::jsonb, true) WHERE id = $1`,
      [ORG],
    );
    try {
      // SUP-RL starts with an empty window
      ok(await reveal('SUP-RL', ticket.ticketId, { reason: 'أول كشف' }));
      t.clock.advanceSeconds(600);
      ok(await reveal('SUP-RL', ticket.ticketId, { reason: 'ثاني كشف' }));
      t.clock.advanceSeconds(60);
      const k = newKey();
      const r = await reveal('SUP-RL', ticket.ticketId, { reason: 'ثالث كشف' }, k);
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('RATE_LIMITED');
      // the first reveal leaves the window 3600 − 660 s from now
      expect(r.body.error.details).toEqual({ retry_after_s: 2940 });
      expect(r.headers['retry-after']).toBe('2940');
      expect(r.body.error.retryable).toBe(true);
      // 429 is not kept with the key (07 §1.4): the same key may be retried later
      expect(await one(t.db, `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [k])).toEqual({
        n: 0,
      });
      // another supervisor has his own counter
      ok(await reveal('SUP-R', ticket.ticketId, { reason: 'مشرف آخر' }));
      // once the first reveal left the window, the same key goes through
      t.clock.advanceSeconds(2940);
      expect(ok(await reveal('SUP-RL', ticket.ticketId, { reason: 'ثالث كشف' }, k)).phone_e164).toBe(PHONE);
      expect(
        await one(
          t.db,
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ticket.reveal_phone' AND actor_id = $1`,
          [U['SUP-RL']],
        ),
      ).toEqual({ n: 3 });
    } finally {
      await t.db.query(
        `UPDATE organizations SET settings = settings #- '{security,reveal_phone_per_hour}' WHERE id = $1`,
        [ORG],
      );
    }
  });
});
