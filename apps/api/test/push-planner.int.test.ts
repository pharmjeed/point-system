import { raiseAlert, releaseDriverWork, setChannelHealth } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  ok,
  one,
  parkedPaperTicket,
  POOL_R,
  requestRetrieval,
  rows,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import { SEED_IDS } from './harness.js';
import { createPushTestApp, pushRows, type PushDevice, type PushTestApp } from './push-harness.js';

const ORG = SEED_IDS.org;
const system = { type: 'system' as const, id: null };
const jsonOf = (t: PushTestApp, d: PushDevice) => t.sentTo(d.endpoint).map((p) => p.json as any);

describe('Web Push — escalation to supervisors (critical alerts only, 14 §8)', () => {
  let t: PushTestApp;
  const dev: Record<string, PushDevice> = {};

  beforeAll(async () => {
    t = await createPushTestApp();
    for (const u of ['SUP-R', 'SUP-RL', 'SUP-RD', 'ADM1', 'OWN1', 'DRV1']) dev[u] = await t.device(u);
  });
  afterAll(async () => t.close());

  it('no driver on duty: `escalation` to the venue supervisors only, ticket number only', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const k = await parkedPaperTicket(t, 'DRV1');
    ok(await t.command('post', '/v1/me/duty/end', { as: 'DRV1', body: {} }));
    t.clock.advanceSeconds(10);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    const alert = await one(
      t.db,
      `SELECT id, severity FROM alerts WHERE dedupe_key = $1 AND status = 'open'`,
      [`no_drivers_on_duty:${POOL_R}`],
    );
    expect(alert.severity).toBe('critical');
    await t.drain();
    for (const u of ['SUP-R', 'SUP-RL', 'SUP-RD']) {
      expect(jsonOf(t, dev[u]!)).toEqual([
        {
          v: 1,
          kind: 'escalation',
          tag: `alert:${alert.id}`,
          title: 'STAFF_AR — تنبيه عاجل',
          body: 'لا يوجد سائق متاح وهناك طلب إحضار مفتوح',
          ticket_no: null,
          task_id: null,
          offer_id: null,
          url: '/ops/alerts',
          renotify: true,
          silent: false,
          sent_at: t.clock.now().toISOString(),
          expires_at: null,
        },
      ]);
      expect(t.sentTo(dev[u]!.endpoint)[0]).toMatchObject({
        ttlSeconds: 600,
        topic: alert.id.replace(/-/g, ''),
      });
      expect((await pushRows(t, dev[u]!.deviceId))[0]).toMatchObject({
        dedupe_key: `push:escalation:${alert.id}:1:${dev[u]!.deviceId}`,
        venue_id: RMS,
      });
    }
    // a single-venue type reaches the admins through S-04, not their lock screens; drivers never
    for (const u of ['ADM1', 'OWN1', 'DRV1']) expect(await pushRows(t, dev[u]!.deviceId)).toEqual([]);
  });

  it('an alert acknowledged before the send is not pushed (stale)', async () => {
    await t.db.transaction((tx) =>
      raiseAlert(tx, {
        orgId: ORG,
        venueId: RMS,
        type: 'handover_code_locked',
        dedupeKey: 'handover_code_locked:test-cycle',
      }),
    );
    await t.db.query(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $1 WHERE dedupe_key = $2`,
      [U['SUP-R'], 'handover_code_locked:test-cycle'],
    );
    await t.drain();
    const last = (await pushRows(t, dev['SUP-R']!.deviceId)).at(-1);
    expect(last).toMatchObject({ purpose: 'escalation', status: 'skipped', skipped_reason: 'stale' });
    expect(jsonOf(t, dev['SUP-R']!)).toHaveLength(1);
  });

  it('a multi-venue type (one row per venue, DEC-46): one push per device and raise, admins included', async () => {
    await t.db.transaction((tx) =>
      setChannelHealth(tx, SEED_IDS.whatsappChannel, 'down', 'test outage', 'job.wa_send'),
    );
    const rowsDown = await rows(
      t.db,
      `SELECT id, venue_id FROM alerts WHERE type = 'wa_channel_down' ORDER BY venue_id`,
    );
    expect(rowsDown.map((r) => r.venue_id)).toEqual([SEED_IDS.venues.RMS, SEED_IDS.venues.LYL].sort());
    await t.drain();
    for (const u of ['SUP-R', 'SUP-RL', 'SUP-RD', 'ADM1', 'OWN1']) {
      const got = jsonOf(t, dev[u]!).filter((p) => p.body.startsWith('واتساب'));
      expect(got, u).toHaveLength(1);
      expect(got[0]).toMatchObject({
        kind: 'escalation',
        body: 'واتساب متعطل — اطلب من العملاء مراجعة السائق مباشرة',
        url: '/ops/alerts',
        ticket_no: null,
      });
      expect(rowsDown.map((r) => `alert:${r.id}`)).toContain(got[0].tag);
    }
    expect(await pushRows(t, dev.DRV1!.deviceId)).toEqual([]);
  });
});

describe('Web Push — broadcast, reminder, claim and withdrawal', () => {
  let t: PushTestApp;
  const dev: Record<string, PushDevice> = {};
  let taskId: string;
  let broadcastId: string;
  let ticketNo: number;

  beforeAll(async () => {
    t = await createPushTestApp();
    for (const u of ['DRV1', 'DRV2', 'DRV3']) {
      ok(await startDuty(t, u), 201);
      dev[u] = await t.device(u);
      t.clock.advanceSeconds(1);
    }
  });
  afterAll(async () => t.close());

  // drivers by role, taken from the order of the single rounds (the longest-idle driver first, 10 §4)
  let failing: string; // first single recipient; his push service refuses the broadcast and the reminder
  let seen: string; // second; sees the broadcast card, so no reminder
  let acceptor: string; // third; his expiry opens the broadcast in the same transaction, then he accepts it

  it('every driver tried once: single rounds expire, then the engine broadcasts and pushes every recipient', async () => {
    const k = await parkedPaperTicket(t, 'DRV1');
    ticketNo = k.displayNumber;
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    await t.drain();
    const order: string[] = [];
    const byId = new Map(['DRV1', 'DRV2', 'DRV3'].map((u) => [(U as Record<string, string>)[u]!, u]));
    for (let i = 0; i < 3; i++) {
      const live = await one(
        t.db,
        `SELECT o.id, r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
          JOIN tasks k ON k.id = o.task_id
         WHERE k.ticket_id = $1 AND o.status = 'active' AND o.mode = 'single'`,
        [k.ticketId],
      );
      order.push(byId.get(live.user_id)!);
      // before the last expiry (which opens the broadcast in its transaction) the first driver's service fails
      if (i === 2) t.push.respond(dev[order[0]!]!.endpoint, { statusCode: 400 }, { statusCode: 400 });
      await t.advance(32); // the single round expires (30 s + grace): next driver, then the broadcast (S4)
    }
    await t.drain();
    [failing, seen, acceptor] = order as [string, string, string];
    expect(new Set(order).size).toBe(3);
    const task = await one(t.db, `SELECT id, status FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`, [
      k.ticketId,
    ]);
    expect(task.status).toBe('broadcast'); // every driver tried once → the engine opened a broadcast (10 §6)
    taskId = task.id;
    const live = await one(
      t.db,
      `SELECT id, round_no FROM task_offers WHERE task_id = $1 AND status = 'active' AND mode = 'broadcast'`,
      [taskId],
    );
    broadcastId = live.id;
    expect(live.round_no).toBe(4);
    const recipients = await rows(
      t.db,
      `SELECT user_id FROM offer_recipients WHERE offer_id = $1 ORDER BY user_id`,
      [broadcastId],
    );
    expect(recipients.map((r) => r.user_id).sort()).toEqual([U.DRV1, U.DRV2, U.DRV3].sort());
    // the first two saw their own request and its quiet end, then the broadcast; the third's expiry and the
    // broadcast share one transaction and one tag, so only the broadcast reaches him (last request wins)
    expect(jsonOf(t, dev[seen]!).map((p) => p.kind)).toEqual(['offer', 'closed', 'broadcast']);
    expect(jsonOf(t, dev[acceptor]!).map((p) => p.kind)).toEqual(['offer', 'broadcast']);
    // the broadcast was attempted on the failing device too (refused below)
    expect(jsonOf(t, dev[failing]!).map((p) => p.kind)).toEqual(['offer', 'closed', 'broadcast']);
    for (const u of [seen, acceptor]) {
      const last = jsonOf(t, dev[u]!).at(-1);
      expect(last).toMatchObject({
        kind: 'broadcast',
        tag: `task:${taskId}`,
        title: 'STAFF_AR — طلب مفتوح',
        body: `تذكرة ${ticketNo} — افتح للقبول أو الحجز`,
        offer_id: broadcastId,
        expires_at: null,
      });
      expect(t.sentTo(dev[u]!.endpoint).at(-1)).toMatchObject({ ttlSeconds: 60 });
    }
    // the first driver's push service refused it (400): failed, nothing on his screen
    expect((await pushRows(t, dev[failing]!.deviceId)).at(-1)).toMatchObject({
      purpose: 'broadcast',
      status: 'failed',
      last_error_code: 'http_400',
    });
  });

  it('the reminder goes only to recipients who did not see the card (client.offer_seen)', async () => {
    await t.db.query(`UPDATE offer_recipients SET seen_at = now() WHERE offer_id = $1 AND user_id = $2`, [
      broadcastId,
      (U as Record<string, string>)[seen],
    ]);
    await t.emit({
      type: 'offer.reminded',
      orgId: ORG,
      venueId: RMS,
      aggregate: { type: 'task_offer', id: broadcastId, version: 1 },
      actor: system,
      payload: {
        offer_id: broadcastId,
        task_id: taskId,
        mode: 'broadcast',
        recipient_ids: [U.DRV1, U.DRV2, U.DRV3],
      },
    });
    // no reminder of the broadcast round (4) for the driver who saw it (the single rounds had their own, 10 §5.1)
    expect((await pushRows(t, dev[seen]!.deviceId)).map((p) => p.dedupe_key)).not.toContain(
      `push:reminder:${taskId}:4:${dev[seen]!.deviceId}`,
    );
    await t.drain();
    expect(jsonOf(t, dev[acceptor]!).at(-1)).toMatchObject({
      kind: 'reminder',
      body: `تذكرة ${ticketNo} ما زالت بانتظار القبول`,
      expires_at: null,
    });
    expect((await pushRows(t, dev[failing]!.deviceId)).at(-1)).toMatchObject({
      purpose: 'reminder',
      status: 'failed',
    });
  });

  it('a claim quietly replaces only what was shown: the driver whose pushes failed gets nothing', async () => {
    t.clock.advanceSeconds(2);
    ok(await accept(t, acceptor, broadcastId));
    await t.drain();
    expect(jsonOf(t, dev[seen]!).at(-1)).toMatchObject({
      kind: 'closed',
      body: 'تم قبول الطلب',
      silent: true,
    });
    expect(jsonOf(t, dev[acceptor]!).at(-1)).toMatchObject({ kind: 'closed', body: 'تم قبول الطلب' });
    expect((await pushRows(t, dev[failing]!.deviceId)).map((p) => p.dedupe_key)).not.toContain(
      `push:closed:${taskId}:4:${dev[failing]!.deviceId}`,
    );
    expect((await pushRows(t, dev[seen]!.deviceId)).at(-1).dedupe_key).toBe(
      `push:closed:${taskId}:4:${dev[seen]!.deviceId}`,
    );
  });

  it('a withdrawal tells the driver not to move the car, without a request on screen (14 §3.2)', async () => {
    await t.db.transaction((tx) =>
      releaseDriverWork(tx, {
        orgId: ORG,
        driverId: (U as Record<string, string>)[acceptor]!,
        poolId: POOL_R,
        reason: 'forced',
        actorId: U['SUP-R'],
      }),
    );
    const withdrawn = (await pushRows(t, dev[acceptor]!.deviceId)).at(-1);
    expect(withdrawn).toMatchObject({ purpose: 'closed', task_id: taskId, status: 'pending' });
    await t.drain();
    expect(jsonOf(t, dev[acceptor]!).at(-1)).toMatchObject({
      kind: 'closed',
      tag: `task:${taskId}`,
      body: `سُحبت مهمة تذكرة ${ticketNo} — لا تُحضر السيارة`,
      silent: true,
      renotify: false,
    });
  });

  it('within one transaction the last request per device and tag wins', async () => {
    const before = (await pushRows(t, dev.DRV1!.deviceId)).length;
    const max = (
      await one(t.db, `SELECT max(round_no)::int AS n FROM task_offers WHERE task_id = $1`, [taskId])
    ).n;
    // a round that was opened and revoked in the same transaction (as when its recipient accepts another)
    const revokedRound = await one(
      t.db,
      `INSERT INTO task_offers (org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, expires_at, closed_at, close_reason)
       VALUES ($1, $2, $3, 'single', $4, 'revoked', now(), now(), now(), 'recipient_unavailable') RETURNING id`,
      [ORG, taskId, POOL_R, max + 1],
    );
    const offered = (round: number, offerId: string | null) => ({
      type: 'task.offered',
      orgId: ORG,
      venueId: RMS,
      aggregate: { type: 'task', id: taskId, version: 30 + round },
      actor: system,
      payload: { task_id: taskId, ticket_id: null, offer_id: offerId, round_no: round, recipient_id: U.DRV1 },
    });
    const revoked = {
      type: 'offer.revoked',
      orgId: ORG,
      venueId: RMS,
      aggregate: { type: 'task_offer', id: revokedRound.id, version: 2 },
      actor: system,
      payload: {
        offer_id: revokedRound.id,
        task_id: taskId,
        mode: 'single',
        close_reason: 'recipient_unavailable',
        recipient_ids: [U.DRV1],
      },
    };
    // offered then revoked: the request never reaches the device, nor its replacement
    await t.emit(offered(max + 1, revokedRound.id), revoked);
    expect(await pushRows(t, dev.DRV1!.deviceId)).toHaveLength(before);
    // revoked then reopened for the same driver: only the new request
    await t.emit(revoked, offered(max + 2, null));
    const after = (await pushRows(t, dev.DRV1!.deviceId)).slice(before);
    expect(after.map((p) => [p.purpose, p.dedupe_key])).toEqual([
      ['offer', `push:offer:${taskId}:${max + 2}:${dev.DRV1!.deviceId}`],
    ]);
  });
});
