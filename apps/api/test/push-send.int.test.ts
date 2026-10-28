import { PushPayloadSchema } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  liveOffer,
  ok,
  one,
  parkedPaperTicket,
  requestRetrieval,
  rows,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { SEED_IDS } from './harness.js';
import { createPushTestApp, pushRows, type PushDevice, type PushTestApp } from './push-harness.js';
import { CSRF } from './test-env.js';

const ORG = SEED_IDS.org;
const noDashes = (id: string) => id.replace(/-/g, '');
const kinds = (t: PushTestApp, d: PushDevice) => t.sentTo(d.endpoint).map((p) => (p.json as any).kind);

/** The plate, key tag, paper serial and phone of a ticket: none may reach a lock screen (DEC-23). */
async function sensitiveOf(t: PushTestApp, ticketId: string): Promise<string[]> {
  const k = await one(
    t.db,
    `SELECT t.plate_digits, t.plate_letters_ar, t.key_tag, t.paper_serial, c.phone_e164
       FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id WHERE t.id = $1`,
    [ticketId],
  );
  return [k.plate_digits, k.plate_letters_ar, k.key_tag, k.paper_serial, k.phone_e164].filter(Boolean);
}

/**
 * PNT-072 (backend): staff Web Push through the real routes — the planner writes `notifications` +
 * `job.push_send` in the command's transaction, the worker sends with the dev/test sender (no network) and
 * records the outcome. Payloads are asserted exactly (14 §6.2, DEC-23).
 */
describe('Web Push — offers, claims and the send pipeline', () => {
  let t: PushTestApp;
  let d1: PushDevice;
  let d2: PushDevice;
  let ticket: Awaited<ReturnType<typeof parkedPaperTicket>>;
  let offer: { id: string; task_id: string };

  beforeAll(async () => {
    t = await createPushTestApp();
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV1'), 201);
    d1 = await t.device('DRV1');
    d2 = await t.device('DRV2');
    ticket = await parkedPaperTicket(t, 'DRV1');
  });
  afterAll(async () => t.close());

  it('a single offer pushes `offer` to the recipient only, with the exact payload and headers', async () => {
    t.clock.advanceSeconds(30);
    ok(await requestRetrieval(t, 'SUP-R', ticket.ticketId), 201);
    offer = (await liveOffer(t.db, U.DRV2))!;
    expect(offer).toBeTruthy();
    const planned = await pushRows(t, d2.deviceId);
    expect(planned).toMatchObject([
      {
        purpose: 'offer',
        status: 'pending',
        dedupe_key: `push:offer:${offer.task_id}:1:${d2.deviceId}`,
        task_id: offer.task_id,
        ticket_id: ticket.ticketId,
        venue_id: RMS,
        recipient_user_id: U.DRV2,
      },
    ]);
    const job = await one(
      t.db,
      `SELECT payload, ordering_key FROM outbox_events WHERE type = 'job.push_send' AND payload->>'notification_id' = $1`,
      [planned[0].id],
    );
    expect(job).toEqual({
      payload: { notification_id: planned[0].id, offer_id: offer.id },
      ordering_key: null,
    });
    expect(await pushRows(t, d1.deviceId)).toEqual([]);

    await t.drain();
    const sent = t.sentTo(d2.endpoint);
    expect(sent).toHaveLength(1);
    const round = await one(t.db, `SELECT expires_at FROM task_offers WHERE id = $1`, [offer.id]);
    expect(sent[0]!.json).toEqual({
      v: 1,
      kind: 'offer',
      tag: `task:${offer.task_id}`,
      title: 'STAFF_AR — طلب إحضار',
      body: `تذكرة ${ticket.displayNumber} — افتح التطبيق للقبول`,
      ticket_no: ticket.displayNumber,
      task_id: offer.task_id,
      offer_id: offer.id,
      url: '/d',
      renotify: true,
      silent: false,
      sent_at: t.clock.now().toISOString(),
      expires_at: new Date(round.expires_at).toISOString(),
    });
    expect(PushPayloadSchema.safeParse(sent[0]!.json).success).toBe(true);
    expect(sent[0]).toMatchObject({ ttlSeconds: 30, urgency: 'high', topic: noDashes(offer.task_id) });
    for (const s of await sensitiveOf(t, ticket.ticketId)) expect(sent[0]!.payload).not.toContain(s);
    expect(t.sentTo(d1.endpoint)).toEqual([]);

    expect(await pushRows(t, d2.deviceId)).toMatchObject([{ status: 'sent', attempts: 1 }]);
    expect(
      await rows(
        t.db,
        `SELECT attempt_no, outcome, http_status FROM notification_attempts WHERE notification_id = $1`,
        [planned[0].id],
      ),
    ).toEqual([{ attempt_no: 1, outcome: 'success', http_status: 201 }]);
    const r = await one(
      t.db,
      `SELECT notified_push_at FROM offer_recipients WHERE offer_id = $1 AND user_id = $2`,
      [offer.id, U.DRV2],
    );
    expect(r.notified_push_at).not.toBeNull();
  });

  it('accepting replaces the notification quietly under the same tag (DEC-23)', async () => {
    t.clock.advanceSeconds(3);
    ok(await accept(t, 'DRV2', offer.id));
    const planned = await pushRows(t, d2.deviceId);
    expect(planned.map((p) => [p.purpose, p.dedupe_key])).toEqual([
      ['offer', `push:offer:${offer.task_id}:1:${d2.deviceId}`],
      ['closed', `push:closed:${offer.task_id}:1:${d2.deviceId}`],
    ]);
    await t.drain();
    const closed = t.sentTo(d2.endpoint)[1]!;
    expect(closed.json).toMatchObject({
      kind: 'closed',
      tag: `task:${offer.task_id}`,
      title: 'STAFF_AR',
      body: 'تم قبول الطلب',
      renotify: false,
      silent: true,
      expires_at: null,
    });
    expect(closed).toMatchObject({ ttlSeconds: 300, topic: noDashes(offer.task_id) });
    // DRV1 never had a request on screen: nothing to replace, nothing sent
    expect(t.sentTo(d1.endpoint)).toEqual([]);
  });

  it('a device without a granted permission, a subscription or a live session is never pushed (14 §6.1)', async () => {
    const denied = await t.device('DRV3', { permission: 'denied' });
    const unsubscribed = await t.device('DRV4', { subscribe: false });
    const loggedOut = await t.device('DRV5');
    await t.db.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [
      loggedOut.sessionId,
    ]);
    await t.emit({
      type: 'task.broadcast_opened',
      orgId: ORG,
      venueId: RMS,
      aggregate: { type: 'task', id: offer.task_id, version: 99 },
      actor: { type: 'system', id: null },
      payload: {
        task_id: offer.task_id,
        ticket_id: ticket.ticketId,
        offer_id: offer.id,
        round_no: 9,
        recipients: [U.DRV3, U.DRV4, U.DRV5, U.DRV1].map((user_id) => ({ user_id, eligible_as: 'accept' })),
      },
    });
    for (const d of [denied, unsubscribed, loggedOut]) expect(await pushRows(t, d.deviceId)).toEqual([]);
    // the control: a live device is planned (and skipped at send time: that round is not live)
    expect(await pushRows(t, d1.deviceId)).toMatchObject([{ purpose: 'broadcast', status: 'pending' }]);
    await t.drain();
    expect(await pushRows(t, d1.deviceId)).toMatchObject([{ status: 'skipped', skipped_reason: 'stale' }]);
    expect(t.sentTo(d1.endpoint)).toEqual([]);
  });
});

describe('Web Push — expiry, failures and the push_failed_repeatedly alert', () => {
  let t: PushTestApp;
  let d1: PushDevice;
  let d2: PushDevice;

  beforeAll(async () => {
    t = await createPushTestApp();
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV1'), 201);
    d1 = await t.device('DRV1');
    d2 = await t.device('DRV2');
  });
  afterAll(async () => t.close());

  it('an expired round is quietly replaced and the next driver gets the offer', async () => {
    const k = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(30);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    const first = (await liveOffer(t.db, U.DRV2))!;
    await t.drain();
    expect(kinds(t, d2)).toEqual(['offer']);
    // 30 s + accept grace (1500 ms, DEC-47): job.offer_expire → offer.expired → closed; pass → DRV1
    await t.advance(32);
    await t.drain();
    expect(t.sentTo(d2.endpoint).map((p) => [(p.json as any).kind, (p.json as any).body])).toEqual([
      ['offer', `تذكرة ${k.displayNumber} — افتح التطبيق للقبول`],
      ['closed', 'انتهى العرض — افتح التطبيق لمعرفة الجديد'],
    ]);
    const second = (await liveOffer(t.db, U.DRV1))!;
    expect(second.task_id).toBe(first.task_id);
    expect(t.sentTo(d1.endpoint).map((p) => [(p.json as any).kind, (p.json as any).tag])).toEqual([
      ['offer', `task:${first.task_id}`],
    ]);
    expect((await pushRows(t, d1.deviceId))[0]).toMatchObject({
      dedupe_key: `push:offer:${first.task_id}:2:${d1.deviceId}`,
    });
    ok(await accept(t, 'DRV1', second.id));
    await t.drain();
    expect(kinds(t, d1)).toEqual(['offer', 'closed']);
  });

  it('404/410 clears the subscription; repeated failures alert the supervisors; success resolves', async () => {
    t.push.respond(d2.endpoint, { statusCode: 410 });
    const k = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    const o = (await liveOffer(t.db, U.DRV2))!;
    await t.drain();
    const gone = await pushRows(t, d2.deviceId);
    expect(gone.at(-1)).toMatchObject({
      purpose: 'offer',
      status: 'failed',
      last_error_code: 'http_410',
      attempts: 1,
    });
    expect(
      await one(
        t.db,
        `SELECT push_endpoint, push_p256dh, push_auth, push_failed_count FROM devices WHERE id = $1`,
        [d2.deviceId],
      ),
    ).toEqual({ push_endpoint: null, push_p256dh: null, push_auth: null, push_failed_count: 1 });
    expect(
      await rows(
        t.db,
        `SELECT outcome, http_status, provider_error_code FROM notification_attempts WHERE notification_id = $1`,
        [gone.at(-1).id],
      ),
    ).toEqual([{ outcome: 'permanent_error', http_status: 410, provider_error_code: 'http_410' }]);

    // subscribed again; the push service then fails three times in a row and recovers (14 §6.6)
    await t.db.query(
      `UPDATE devices SET push_endpoint = $2, push_p256dh = 'BTestP256dhKey', push_auth = 'testAuthSecret', push_failed_count = 0
        WHERE id = $1`,
      [d2.deviceId, d2.endpoint],
    );
    t.push.respond(
      d2.endpoint,
      { statusCode: 503 },
      { statusCode: 500 },
      { statusCode: 429, retryAfterMs: 1000 },
    );
    await t.emit({
      type: 'offer.reminded',
      orgId: ORG,
      venueId: RMS,
      aggregate: { type: 'task_offer', id: o.id, version: 1 },
      actor: { type: 'system', id: null },
      payload: { offer_id: o.id, task_id: o.task_id, mode: 'single', recipient_ids: [U.DRV2] },
    });
    await t.drain(); // attempt 1: 503
    await t.advance(2); // attempt 2: 500
    await t.advance(5); // attempt 3: 429 → 3 consecutive failures
    const alert = await one(
      t.db,
      `SELECT type, severity, status, venue_id, user_id, details FROM alerts WHERE dedupe_key = $1`,
      [`push_failed_repeatedly:${d2.deviceId}`],
    );
    expect(alert).toMatchObject({
      type: 'push_failed_repeatedly',
      severity: 'info',
      status: 'open',
      venue_id: RMS,
      user_id: U.DRV2,
      details: { device_id: d2.deviceId, consecutive_failures: 3, last_error: 'http_429' },
    });
    // an info alert never pushes (14 §10)
    expect(await rows(t.db, `SELECT 1 FROM notifications WHERE purpose = 'escalation'`)).toEqual([]);
    await t.advance(15); // attempt 4: 201
    const reminder = (await pushRows(t, d2.deviceId)).at(-1);
    expect(reminder).toMatchObject({ purpose: 'reminder', status: 'sent', attempts: 4 });
    expect(
      (
        await rows(
          t.db,
          `SELECT outcome FROM notification_attempts WHERE notification_id = $1 ORDER BY attempt_no`,
          [reminder.id],
        )
      ).map((r) => r.outcome),
    ).toEqual(['retryable_error', 'retryable_error', 'retryable_error', 'success']);
    expect((t.sentTo(d2.endpoint).at(-1)!.json as any).body).toBe(
      `تذكرة ${k.displayNumber} ما زالت بانتظار القبول`,
    );
    expect(
      await one(t.db, `SELECT status, resolved_by FROM alerts WHERE dedupe_key = $1`, [
        `push_failed_repeatedly:${d2.deviceId}`,
      ]),
    ).toEqual({ status: 'resolved', resolved_by: null });
    expect(
      (await one(t.db, `SELECT push_failed_count FROM devices WHERE id = $1`, [d2.deviceId]))
        .push_failed_count,
    ).toBe(0);
    ok(await accept(t, 'DRV2', o.id));
    await t.drain();
  });

  it('retries stop at the attempt limit within the TTL; a new subscription resolves the alert (14 §8)', async () => {
    ok(await startDuty(t, 'DRV3'), 201);
    const d3 = await t.device('DRV3');
    t.push.respond(
      d3.endpoint,
      { statusCode: 503 },
      { statusCode: 503 },
      { statusCode: 503 },
      { statusCode: 503 },
    );
    const k = await parkedPaperTicket(t, 'DRV3');
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    const o = (await liveOffer(t.db, U.DRV3))!;
    await t.drain(); // 1
    await t.advance(2); // 2
    await t.advance(5); // 3 → alert
    await t.advance(15); // 4: the last provider attempt, then failed
    const n = (await pushRows(t, d3.deviceId)).at(-1);
    expect(n).toMatchObject({ purpose: 'offer', status: 'failed', attempts: 4, last_error_code: 'http_503' });
    const key = `push_failed_repeatedly:${d3.deviceId}`;
    expect((await one(t.db, `SELECT status FROM alerts WHERE dedupe_key = $1`, [key])).status).toBe('open');
    const res = await t
      .http()
      .put(`/v1/me/devices/${d3.deviceId}`)
      .set(CSRF)
      .set('Cookie', d3.cookie)
      .send({
        push_subscription: { endpoint: `${d3.endpoint}-new`, keys: { p256dh: 'BNew', auth: 'newAuth' } },
      });
    expect(res.status).toBe(200);
    expect((await one(t.db, `SELECT status FROM alerts WHERE dedupe_key = $1`, [key])).status).toBe(
      'resolved',
    );
    ok(await accept(t, 'DRV3', o.id));
  });
});
