import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCustomerApp,
  freshDriver,
  messagesTo,
  park,
  settle,
  tablesContaining,
  ticketRow,
  whatsappTicket,
  type CustomerApp,
} from './customer-harness.js';
import {
  accept,
  auditCount,
  err,
  expectConsistent,
  handover,
  keyPickup,
  markReady,
  ok,
  outboxEvents,
  requestRetrieval,
  startRetrieval,
} from './dispatch-fixtures.js';
import { newKey } from './harness.js';
import { ORG } from './wa-harness.js';

let phoneSeq = 5_300_000;
const newPhone = () => `+96655${phoneSeq++}`;

const resend = (w: CustomerApp, as: string, ticketId: string, key?: string) =>
  w.command('post', `/v1/tickets/${ticketId}/handover-code/resend`, { as, body: {}, key });
const codes = async (w: CustomerApp, ticketId: string) =>
  (
    await w.db.query(`SELECT * FROM claim_codes WHERE ticket_id = $1 ORDER BY issued_at, resend_no`, [
      ticketId,
    ])
  ).rows;
const byCode = (code: string) => ({ verification: { method: 'code', code } });
/** A 6-digit value bounded by non-hex characters (a uuid or a hash never matches by accident). */
const codePattern = (code: string) => new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`);

describe('S3 handover codes (PNT-047)', () => {
  let w: CustomerApp;
  beforeAll(async () => {
    w = await createCustomerApp();
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
    w.clock.advance(10 * 60_000);
    await w.drain();
  });

  /** WhatsApp ticket → W-01 → parked → request on behalf → accepted by the offered driver → started → ready. */
  async function readyTicket(o: { eventId?: string; ready?: boolean } = {}) {
    const intake = await freshDriver(w);
    const phone = newPhone();
    const t = await whatsappTicket(w, intake, phone);
    expect(t.submit!.status).toBe(200);
    await settle(w, phone);
    const { slotId } = await park(w, intake, t.taskId);
    ok(await requestRetrieval(w, intake, t.ticketId), 201);
    const offer = (
      await w.db.query<{ id: string; task_id: string; user_id: string }>(
        `SELECT o.id, o.task_id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
           JOIN tasks k ON k.id = o.task_id
          WHERE k.ticket_id = $1 AND o.status = 'active'`,
        [t.ticketId],
      )
    ).rows[0]!;
    const driver = offer.user_id;
    ok(await accept(w, driver, offer.id));
    ok(await keyPickup(w, driver, offer.task_id, slotId));
    ok(await startRetrieval(w, driver, offer.task_id));
    const ready = o.ready === false ? null : ok(await markReady(w, driver, offer.task_id));
    await settle(w, phone);
    const code = ready ? await w.sim.client.claimCode(phone) : null;
    return { ...t, phone, intake, driver, taskId: offer.task_id, ready, code };
  }

  it('ready issues the code: HMAC + the single ciphertext, purged after the provider accepted W-05; the code reaches only the customer (AC-09, TC-027)', async () => {
    const t = await readyTicket();
    expect(t.code).toMatch(/^[0-9]{6}$/);
    const [c] = await codes(w, t.ticketId);
    expect(c).toMatchObject({
      code_ciphertext: null,
      attempts: 0,
      max_attempts: 5,
      resend_no: 0,
      consumed_at: null,
    });
    expect(c.sent_message_id).toBeTruthy();
    expect(new Date(c.expires_at).getTime() - new Date(c.issued_at).getTime()).toBe(30 * 60_000);
    const ready = (await outboxEvents(w.db, 'ticket.ready')).find(
      (e) => e.payload.payload.ticket.ticket_id === t.ticketId,
    )!;
    expect(ready.payload.payload).toMatchObject({
      expected_method: 'code',
      claim_code_id: c.id,
      code_expires_at: new Date(c.expires_at).toISOString(),
    });
    const issued = (await outboxEvents(w.db, 'handover.code_issued')).filter(
      (e) => e.payload.payload.ticket_id === t.ticketId,
    );
    expect(issued.map((e) => e.payload.payload)).toEqual([
      {
        ticket_id: t.ticketId,
        cycle_id: c.cycle_id,
        claim_code_id: c.id,
        expires_at: new Date(c.expires_at).toISOString(),
        resend_no: 0,
      },
    ]);
    const timer = (
      await w.db.query(
        `SELECT available_at FROM outbox_events WHERE type = 'job.claim_code_expire' AND dedupe_key = $1`,
        [`claim_code_expire:${c.id}`],
      )
    ).rows[0];
    expect(new Date(timer.available_at).getTime()).toBe(new Date(c.expires_at).getTime());
    const w05 = (await messagesTo(w, t.phone)).filter((m) => m.purpose === 'W-05');
    expect(w05).toHaveLength(1);
    // staff never see it: the ready answer, the ticket for the driver and the supervisor, the home snapshot
    const detail = ok(await w.get(`/v1/tickets/${t.ticketId}`, t.driver));
    expect(detail.claim_code).toMatchObject({
      attempts: 0,
      max_attempts: 5,
      attempts_left: 5,
      resend_no: 0,
      resends_left: 3,
    });
    expect(['sent', 'delivered', 'read']).toContain(detail.claim_code.sent_status);
    const sup = ok(await w.get(`/v1/tickets/${t.ticketId}`, 'SUP-R'));
    const home = ok(await w.get('/v1/me/home', t.driver));
    for (const body of [t.ready, detail, sup, home])
      expect(JSON.stringify(body)).not.toMatch(codePattern(t.code!));
    // …nor any table: outbox, audit, timeline, messages (body masked), attempts, idempotency answers
    expect(await tablesContaining(w, t.code!, codePattern(t.code!))).toEqual([]);
  });

  it('TC-028: the code delivers once — a new key afterwards is TICKET_CLOSED, the same key replays the saved 200; W-06 follows', async () => {
    const t = await readyTicket();
    const key = newKey();
    const first = await w.command('post', `/v1/tickets/${t.ticketId}/handover`, {
      as: t.driver,
      body: byCode(t.code!),
      key,
    });
    const done = ok(first);
    expect(done.ticket).toMatchObject({ status: 'delivered' });
    expect(done.cycle).toMatchObject({ outcome: 'delivered' });
    const [c] = await codes(w, t.ticketId);
    expect(c).toMatchObject({ consumed_by: t.driver, revoked_at: null });
    expect(c.consumed_at).toBeTruthy();
    const replay = await w.command('post', `/v1/tickets/${t.ticketId}/handover`, {
      as: t.driver,
      body: byCode(t.code!),
      key,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);
    err(await handover(w, t.driver, t.ticketId, byCode(t.code!)), 'TICKET_CLOSED', 409);
    await settle(w, t.phone);
    // W-02 / W-04 were still queued when the car became ready: only the current state is sent (12 §5.5)
    expect((await messagesTo(w, t.phone)).map((m) => m.purpose)).toEqual(['W-01', 'W-05', 'W-06']);
    const skipped = await w.db.query(
      `SELECT purpose, status, skipped_reason FROM notifications WHERE ticket_id = $1 AND purpose IN ('W-02','W-04') ORDER BY purpose`,
      [t.ticketId],
    );
    expect(skipped.rows).toEqual([
      { purpose: 'W-02', status: 'skipped', skipped_reason: 'superseded' },
      { purpose: 'W-04', status: 'skipped', skipped_reason: 'superseded' },
    ]);
    await expectConsistent(w.db);
  });

  it('TC-029: wrong codes count and commit — INVALID with attempts_left 4…1, the 5th LOCKED (423) + handover_code_locked; then even the right code is LOCKED', async () => {
    const t = await readyTicket();
    const wrong = t.code === '000000' ? '111111' : '000000';
    const key = newKey();
    const r1 = await w.command('post', `/v1/tickets/${t.ticketId}/handover`, {
      as: t.driver,
      body: byCode(wrong),
      key,
    });
    expect(err(r1, 'HANDOVER_CODE_INVALID', 422)).toEqual({ attempts_left: 4 });
    // the same key replays the saved error without a second attempt
    const again = await w.command('post', `/v1/tickets/${t.ticketId}/handover`, {
      as: t.driver,
      body: byCode(wrong),
      key,
    });
    expect(err(again, 'HANDOVER_CODE_INVALID', 422)).toEqual({ attempts_left: 4 });
    expect((await codes(w, t.ticketId))[0].attempts).toBe(1);
    for (const left of [3, 2, 1])
      expect(
        err(await handover(w, t.driver, t.ticketId, byCode(wrong)), 'HANDOVER_CODE_INVALID', 422),
      ).toEqual({
        attempts_left: left,
      });
    const locked = err(await handover(w, t.driver, t.ticketId, byCode(wrong)), 'HANDOVER_CODE_LOCKED', 423);
    const alert = (
      await w.db.query(
        `SELECT id, type, status FROM alerts WHERE ticket_id = $1 AND type = 'handover_code_locked'`,
        [t.ticketId],
      )
    ).rows;
    expect(alert).toEqual([{ id: locked.alert_id, type: 'handover_code_locked', status: 'open' }]);
    expect((await codes(w, t.ticketId))[0]).toMatchObject({ attempts: 5 });
    expect((await codes(w, t.ticketId))[0].locked_at).toBeTruthy();
    expect(
      err(await handover(w, t.driver, t.ticketId, byCode(t.code!)), 'HANDOVER_CODE_LOCKED', 423),
    ).toMatchObject({
      alert_id: locked.alert_id,
    });
    const failed = (await outboxEvents(w.db, 'handover.code_attempt_failed')).filter(
      (e) => e.payload.payload.ticket_id === t.ticketId,
    );
    expect(failed.map((e) => e.payload.payload.attempts_left)).toEqual([4, 3, 2, 1, 0]);
    expect(
      (await outboxEvents(w.db, 'handover.code_locked')).filter(
        (e) => e.payload.payload.ticket_id === t.ticketId,
      ),
    ).toHaveLength(1);
    expect((await ticketRow(w, t.ticketId)).status).toBe('ready');
    // the assignee cannot reissue a locked code; the supervisor can, which lifts the lock alert
    expect(err(await resend(w, t.driver, t.ticketId), 'HANDOVER_CODE_LOCKED', 423)).toMatchObject({
      alert_id: locked.alert_id,
    });
    const state = ok(await resend(w, 'SUP-R', t.ticketId));
    expect(state).toMatchObject({
      attempts: 0,
      attempts_left: 5,
      resend_no: 1,
      resends_left: 2,
      locked_at: null,
    });
    expect(
      (await w.db.query(`SELECT status FROM alerts WHERE id = $1`, [locked.alert_id])).rows[0].status,
    ).toBe('resolved');
    await settle(w, t.phone);
    const fresh = await w.sim.client.claimCode(t.phone);
    expect(fresh).not.toBe(t.code);
    ok(await handover(w, t.driver, t.ticketId, byCode(fresh!)));
  });

  it('TC-030: an expired code → HANDOVER_CODE_EXPIRED and its cleanup (expired_cleanup, copy purged); resend × 3 new codes, the 4th RESEND_LIMIT_REACHED; an old code is refused', async () => {
    const t = await readyTicket();
    w.clock.advance(31 * 60_000);
    const expired = err(
      await handover(w, t.driver, t.ticketId, byCode(t.code!)),
      'HANDOVER_CODE_EXPIRED',
      410,
    );
    const [c0] = await codes(w, t.ticketId);
    expect(expired).toEqual({ expired_at: new Date(c0.expires_at).toISOString() });
    await w.drain(); // job.claim_code_expire
    expect((await codes(w, t.ticketId))[0]).toMatchObject({
      revoke_reason: 'expired_cleanup',
      code_ciphertext: null,
    });
    err(await handover(w, t.driver, t.ticketId, byCode(t.code!)), 'HANDOVER_CODE_EXPIRED', 410);

    const sent: string[] = [];
    for (const n of [1, 2, 3]) {
      const s = ok(await resend(w, n === 2 ? 'SUP-R' : t.driver, t.ticketId));
      expect(s).toMatchObject({ resend_no: n, resends_left: 3 - n, attempts_left: 5 });
      expect(JSON.stringify(s)).not.toMatch(/"code"/);
      await settle(w, t.phone);
      sent.push((await w.sim.client.claimCode(t.phone))!);
    }
    expect(new Set(sent).size).toBe(3);
    expect(err(await resend(w, t.driver, t.ticketId), 'RESEND_LIMIT_REACHED', 429)).toEqual({
      max_resends: 3,
    });
    const all = await codes(w, t.ticketId);
    expect(all.map((c) => [c.resend_no, c.revoke_reason])).toEqual([
      [0, 'expired_cleanup'],
      [1, 'resend'],
      [2, 'resend'],
      [3, null],
    ]);
    expect(all.every((c) => c.code_ciphertext === null)).toBe(true);
    expect((await messagesTo(w, t.phone)).filter((m) => m.purpose === 'W-05')).toHaveLength(4);
    const old = sent[0] === sent[2] ? null : sent[0]!;
    if (old) err(await handover(w, t.driver, t.ticketId, byCode(old)), 'HANDOVER_CODE_INVALID', 422);
    ok(await handover(w, t.driver, t.ticketId, byCode(sent[2]!)));
    expect(await auditCount(w.db, 'handover.resend_code', t.ticketId)).toBe(3);
  });

  it('resend errors: TICKET_NOT_FOUND, NOT_TASK_ASSIGNEE, HANDOVER_NOT_READY, WA_NOT_LINKED, WA_CUSTOMER_OPTED_OUT, WA_CHANNEL_UNAVAILABLE, WA_TEMPLATE_NOT_APPROVED; HANDOVER_CODE_CONSUMED is defensive', async () => {
    err(await resend(w, 'SUP-R', '00000000-0000-4000-8000-0000deadbeef'), 'TICKET_NOT_FOUND', 404);
    const t = await readyTicket({ ready: false }); // retrieving
    err(await resend(w, 'SUP-R', t.ticketId), 'HANDOVER_NOT_READY', 409);
    ok(await markReady(w, t.driver, t.taskId));
    const other = await freshDriver(w);
    err(await resend(w, other, t.ticketId), 'NOT_TASK_ASSIGNEE', 403);
    await w.db.query(
      `UPDATE whatsapp_channel SET health_status = 'down', health_changed_at = now() WHERE org_id = $1`,
      [ORG],
    );
    expect(err(await resend(w, t.driver, t.ticketId), 'WA_CHANNEL_UNAVAILABLE', 503)).toMatchObject({
      health_status: 'down',
    });
    await w.db.query(`UPDATE whatsapp_channel SET health_status = 'healthy' WHERE org_id = $1`, [ORG]);
    // W-05 not approved: refused only when the customer's 24 h window is closed (12 §8.4)
    await w.db.query(
      `UPDATE whatsapp_templates SET status = 'paused' WHERE org_id = $1 AND name = 'masaf_vehicle_ready_v1'`,
      [ORG],
    );
    await w.db.query(
      `UPDATE customers SET last_inbound_at = $2 WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
      [t.ticketId, new Date(w.clock.now().getTime() - 25 * 3_600_000)],
    );
    expect(err(await resend(w, t.driver, t.ticketId), 'WA_TEMPLATE_NOT_APPROVED', 409)).toEqual({
      template_name: 'masaf_vehicle_ready_v1',
      template_status: 'paused',
    });
    await w.db.query(
      `UPDATE customers SET last_inbound_at = $2 WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
      [t.ticketId, w.clock.now()],
    );
    ok(await resend(w, t.driver, t.ticketId)); // window open: the session fallback carries W-05
    await w.db.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE org_id = $1`, [ORG]);
    await w.db.query(
      `UPDATE customers SET wa_opted_out_at = now() WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
      [t.ticketId],
    );
    err(await resend(w, t.driver, t.ticketId), 'WA_CUSTOMER_OPTED_OUT', 409);
    await w.db.query(
      `UPDATE customers SET wa_opted_out_at = NULL WHERE id = (SELECT customer_id FROM tickets WHERE id = $1)`,
      [t.ticketId],
    );
    await w.db.query(`UPDATE tickets SET wa_link_status = 'failed' WHERE id = $1`, [t.ticketId]);
    expect(err(await resend(w, t.driver, t.ticketId), 'WA_NOT_LINKED', 409)).toEqual({
      wa_link_status: 'failed',
    });
    await w.db.query(`UPDATE tickets SET wa_link_status = 'linked' WHERE id = $1`, [t.ticketId]);
    // defensive: the cycle's code consumed while the ticket is still ready
    await w.db.query(
      `UPDATE claim_codes SET consumed_at = now(), consumed_by = $2 WHERE ticket_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [t.ticketId, t.driver],
    );
    err(await handover(w, t.driver, t.ticketId, byCode('123456')), 'HANDOVER_CODE_CONSUMED', 409);
  });
});
