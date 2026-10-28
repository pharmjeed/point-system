import { raiseAlert, releaseDriverWork, setChannelHealth } from '@point/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  ok,
  one,
  openBroadcastBySql,
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

  it('every driver tried once: single rounds expire, then a broadcast pushes every recipient', async () => {
    const k = await parkedPaperTicket(t, 'DRV1');
    ticketNo = k.displayNumber;
    t.clock.advanceSeconds(5);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    for (let i = 0; i < 3; i++) {
      await t.drain();
      await t.advance(32); // each single round expires (30 s + grace) and goes to the next driver
    }
    await t.drain();
    const task = await one(t.db, `SELECT id, status FROM tasks WHERE ticket_id = $1 AND type = 'retrieve'`, [
      k.ticketId,
    ]);
    expect(task.status).toBe('queued'); // S2 keeps an exhausted request queued (DEC-PROPOSED-11 of S2)
    taskId = task.id;
    for (const u of ['DRV1', 'DRV2', 'DRV3'])
      expect(
        jsonOf(t, dev[u]!).map((p) => p.kind),
        u,
      ).toEqual(['offer', 'closed']);

    t.push.respond(dev.DRV3!.endpoint, { statusCode: 400 }, { statusCode: 400 });
    broadcastId = await openBroadcastBySql(t.db, taskId);
    const recipients = await rows(
      t.db,
      `SELECT user_id, eligible_as FROM offer_recipients WHERE offer_id = $1 ORDER BY user_id`,
      [broadcastId],
    );
    expect(recipients.map((r) => r.user_id).sort()).toEqual([U.DRV1, U.DRV2, U.DRV3].sort());
    await t.emit({
      type: 'task.broadcast_opened',
      orgId: ORG,
      venueId: RMS,
      dispatchPoolId: POOL_R,
      aggregate: { type: 'task', id: taskId, version: 20 },
      actor: system,
      payload: { task_id: taskId, ticket_id: k.ticketId, offer_id: broadcastId, round_no: 4, recipients },
    });
    await t.drain();
    for (const u of ['DRV1', 'DRV2']) {
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
    // DRV3's push service refused it (400): failed, nothing on his screen
    expect((await pushRows(t, dev.DRV3!.deviceId)).at(-1)).toMatchObject({
      purpose: 'broadcast',
      status: 'failed',
      last_error_code: 'http_400',
    });
  });

  it('the reminder goes only to recipients who did not see the card (client.offer_seen)', async () => {
    await t.db.query(`UPDATE offer_recipients SET seen_at = now() WHERE offer_id = $1 AND user_id = $2`, [
      broadcastId,
      U.DRV1,
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
    expect((await pushRows(t, dev.DRV1!.deviceId)).map((p) => p.purpose)).not.toContain('reminder');
    await t.drain();
    expect(jsonOf(t, dev.DRV2!).at(-1)).toMatchObject({
      kind: 'reminder',
      body: `تذكرة ${ticketNo} ما زالت بانتظار القبول`,
      expires_at: null,
    });
    expect((await pushRows(t, dev.DRV3!.deviceId)).at(-1)).toMatchObject({
      purpose: 'reminder',
      status: 'failed',
    });
  });

  it('a claim quietly replaces only what was shown: DRV3, whose pushes failed, gets nothing', async () => {
    t.clock.advanceSeconds(2);
    ok(await accept(t, 'DRV2', broadcastId));
    await t.drain();
    expect(jsonOf(t, dev.DRV1!).at(-1)).toMatchObject({
      kind: 'closed',
      body: 'تم قبول الطلب',
      silent: true,
    });
    expect(jsonOf(t, dev.DRV2!).at(-1)).toMatchObject({ kind: 'closed', body: 'تم قبول الطلب' });
    expect((await pushRows(t, dev.DRV3!.deviceId)).map((p) => p.dedupe_key)).not.toContain(
      `push:closed:${taskId}:4:${dev.DRV3!.deviceId}`,
    );
    expect((await pushRows(t, dev.DRV1!.deviceId)).at(-1).dedupe_key).toBe(
      `push:closed:${taskId}:4:${dev.DRV1!.deviceId}`,
    );
  });

  it('a withdrawal tells the driver not to move the car, without a request on screen (14 §3.2)', async () => {
    await t.db.transaction((tx) =>
      releaseDriverWork(tx, {
        orgId: ORG,
        driverId: U.DRV2,
        poolId: POOL_R,
        reason: 'forced',
        actorId: U['SUP-R'],
      }),
    );
    const withdrawn = (await pushRows(t, dev.DRV2!.deviceId)).at(-1);
    expect(withdrawn).toMatchObject({ purpose: 'closed', task_id: taskId, status: 'pending' });
    await t.drain();
    expect(jsonOf(t, dev.DRV2!).at(-1)).toMatchObject({
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
