import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  changeWaLinkStatus,
  lockTickets,
  publishRealtime,
  recordMessageStatusChange,
  setChannelHealth,
} from '@point/server';
import {
  REALTIME_PAYLOAD_SCHEMAS,
  realtimeEnvelopeSchema,
  rooms,
  type PublishedRealtimeEvent,
} from '@point/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  completeParking,
  keyPickup,
  liveOffer,
  nextSlot,
  nextSpot,
  ok,
  one,
  paperTicketInParking,
  requestRetrieval,
  startDuty,
  startIntake,
  U,
  EVT_R1,
  POOL_R,
  RMS,
  LYL,
} from './dispatch-fixtures.js';
import { SEED_IDS } from './harness.js';
import { createPushTestApp, type Note, type PushTestApp } from './push-harness.js';
import { ORIGIN } from './test-env.js';

const ORG = SEED_IDS.org;
const POOL_L = SEED_IDS.pools['POOL-L'];
const SUP_RMS = rooms.venueSupervisors(RMS);

/** The frame the gateway emits for a relayed publication (RealtimeServer.envelope, canon §7 / 07 §4.2). */
const frameOf = (n: Note) => ({
  id: n.message.id,
  type: n.message.event,
  occurred_at: n.message.occurred_at,
  org_id: n.org_id,
  venue_id: n.message.venue_id ?? null,
  dispatch_pool_id: n.message.dispatch_pool_id ?? null,
  event_id: n.message.event_id ?? null,
  aggregate: n.message.aggregate ?? null,
  actor: n.message.actor ?? { type: 'system', id: null },
  payload: n.message.data,
});

/** 07 contract: every message of the notifications planners parses with its shared zod schema. */
function expectContract(notes: Note[]) {
  for (const n of notes) {
    const event = n.message.event as PublishedRealtimeEvent;
    const schema = REALTIME_PAYLOAD_SCHEMAS[event];
    if (!schema) continue;
    const r = realtimeEnvelopeSchema(event, schema).safeParse(frameOf(n));
    expect(r.success, `${event}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
  }
}

const ticketNotes = (notes: Note[], ticketId: string) =>
  notes.filter((n) => n.message.event === 'ticket.updated' && n.message.data.id === ticketId);
const byRooms = (notes: Note[]) => notes.map((n) => [...n.rooms].sort());

describe('ticket.updated — one TicketSummary per ticket and transaction (07 §4.3, 09 §5.1)', () => {
  let t: PushTestApp;
  let ticketId: string;
  let parkTaskId: string;

  beforeAll(async () => {
    t = await createPushTestApp();
    ok(await startDuty(t, 'DRV2'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV3'), 201);
  });
  afterAll(async () => t.close());

  it('intake: the supervisors and the creator, cause ticket.created, published once (3 events)', async () => {
    t.clearNotes();
    const created = ok(await startIntake(t, 'DRV1', { event_id: EVT_R1, channel: 'paper' }), 201);
    ticketId = created.ticket.id;
    parkTaskId = created.task.id;
    const notes = ticketNotes(await t.published(), ticketId);
    expect(byRooms(notes)).toEqual([[SUP_RMS], [rooms.user(U.DRV1)]]);
    for (const n of notes) {
      expect(n.message.data).toMatchObject({
        id: ticketId,
        cause: 'ticket.created',
        status: 'received',
        version: created.ticket.version,
        display_number: created.ticket.display_number,
      });
      expect(n.message.aggregate).toEqual({ type: 'ticket', id: ticketId, version: created.ticket.version });
      expect(n.message).toMatchObject({ venue_id: RMS, dispatch_pool_id: POOL_R, event_id: EVT_R1 });
      expect(n.message.actor).toEqual({ type: 'user', id: U.DRV1 });
    }
    expectContract(notes);
  });

  it('submit and park: the creator follows his intake; the previous holder sees the summary', async () => {
    const k = await paperTicketInParking(t, 'DRV3');
    t.clearNotes();
    ok(await completeParking(t, 'DRV3', k.taskId, { parking_spot_id: nextSpot(), key_slot_id: nextSlot() }));
    const notes = ticketNotes(await t.published(), k.ticketId);
    // ticket.parked + custody.changed ×2 + task.completed: one update; DRV3 was the holder (custody.changed)
    expect(notes.map((n) => [n.message.data.cause, ...n.rooms])).toEqual([
      ['ticket.parked', SUP_RMS],
      ['ticket.parked', rooms.user(U.DRV3)],
    ]);
    expect(notes[0]!.message.data.status).toBe('parked');
    expectContract(notes);

    t.clearNotes();
    t.clock.advanceSeconds(10);
    ok(await requestRetrieval(t, 'SUP-R', k.ticketId), 201);
    let req = ticketNotes(await t.published(), k.ticketId);
    expect(req.map((n) => [n.message.data.cause, ...n.rooms])).toEqual([
      ['ticket.retrieval_requested', SUP_RMS],
    ]);
    expect(req[0]!.message.data.requested_at).toBe(t.clock.now().toISOString());

    const offer = (await liveOffer(t.db, U.DRV2))!;
    t.clearNotes();
    ok(await accept(t, 'DRV2', offer.id));
    req = ticketNotes(await t.published(), k.ticketId);
    expect(req.map((n) => [n.message.data.cause, ...n.rooms])).toEqual([
      ['ticket.assigned', SUP_RMS],
      ['ticket.assigned', rooms.user(U.DRV2)],
    ]);

    t.clearNotes();
    const slotId = (await one(t.db, `SELECT current_key_slot_id FROM tickets WHERE id = $1`, [k.ticketId]))
      .current_key_slot_id;
    ok(await keyPickup(t, 'DRV2', offer.task_id, slotId));
    req = ticketNotes(await t.published(), k.ticketId);
    expect(req.map((n) => [n.message.data.cause, ...n.rooms])).toEqual([
      ['custody.changed', SUP_RMS],
      ['custody.changed', rooms.user(U.DRV2)],
    ]);
    expectContract(req);
    // no message to a driver the ticket no longer concerns
    expect(req.flatMap((n) => n.rooms)).not.toContain(rooms.user(U.DRV3));
    expect(req.flatMap((n) => n.rooms)).not.toContain(rooms.user(U.DRV1));
  });

  it('the WhatsApp adapter goes through the same builder: one update per transaction, W-01 state to the creator', async () => {
    const msgId = randomUUID();
    t.clearNotes();
    await t.db.transaction((tx) =>
      recordMessageStatusChange(
        tx,
        {
          id: msgId,
          org_id: ORG,
          notification_id: null,
          ticket_id: ticketId,
          venue_id: RMS,
          event_id: EVT_R1,
          purpose: 'W-01',
        },
        'delivered',
        2,
        null,
      ),
    );
    let notes = ticketNotes(await t.published(), ticketId);
    expect(byRooms(notes)).toEqual([[SUP_RMS], [rooms.user(U.DRV1)]]);
    for (const n of notes)
      expect(n.message.data).toMatchObject({
        cause: 'wa.message_status_changed',
        message: { id: msgId, purpose: 'W-01', status: 'delivered', status_rank: 2 },
      });
    expectContract(notes);

    // W-02 is not a driver's message (09 §5.1): the supervisors see it, the creator only the summary
    t.clearNotes();
    await t.db.transaction((tx) =>
      recordMessageStatusChange(
        tx,
        {
          id: randomUUID(),
          org_id: ORG,
          notification_id: null,
          ticket_id: ticketId,
          venue_id: RMS,
          event_id: EVT_R1,
          purpose: 'W-02',
        },
        'read',
        3,
        null,
      ),
    );
    notes = ticketNotes(await t.published(), ticketId);
    expect(notes.find((n) => n.rooms.includes(SUP_RMS))!.message.data.message).toMatchObject({
      purpose: 'W-02',
    });
    expect(notes.filter((n) => n.rooms.includes(SUP_RMS)).length).toBe(1);

    // a link change written by the adapter (event + direct update): still one publication per audience
    t.clearNotes();
    await t.db.transaction(async (tx) => {
      const [locked] = await lockTickets(tx, [ticketId]);
      await changeWaLinkStatus(tx, locked as never, 'failed', {
        method: 'provider_error',
        actor: { type: 'system', id: null },
        action: 'job.wa_send',
      });
    });
    notes = ticketNotes(await t.published(), ticketId);
    expect(notes.map((n) => [n.message.data.cause, ...n.rooms])).toEqual([
      ['ticket.wa_link_changed', SUP_RMS],
      ['ticket.wa_link_changed', rooms.user(U.DRV1)],
    ]);
    expect(notes[0]!.message.data.wa_link_status).toBe('failed');
    expectContract(notes);
  });

  it('incidents: incident.updated to the venue supervisors; ticket.updated for the supervisors only', async () => {
    const incidentId = randomUUID();
    await t.db.query(
      `INSERT INTO incidents (id, org_id, venue_id, event_id, ticket_id, type, severity, description, opened_by)
       VALUES ($1, $2, $3, $4, $5, 'key_missing', 'high', 'المفتاح ليس في خانته', $6)`,
      [incidentId, ORG, RMS, EVT_R1, ticketId, U['SUP-R']],
    );
    t.clearNotes();
    await t.emit({
      type: 'incident.opened',
      orgId: ORG,
      venueId: RMS,
      eventId: EVT_R1,
      aggregate: { type: 'incident', id: incidentId, version: 1 },
      actor: { type: 'user', id: U['SUP-R'] },
      payload: {
        incident_id: incidentId,
        type: 'key_missing',
        status: 'open',
        severity: 'high',
        ticket_id: ticketId,
      },
    });
    const all = await t.published();
    const inc = all.filter((n) => n.message.event === 'incident.updated');
    expect(inc).toHaveLength(1);
    expect(inc[0]!.rooms).toEqual([SUP_RMS]);
    expect(inc[0]!.message.data).toMatchObject({
      id: incidentId,
      cause: 'incident.opened',
      type: 'key_missing',
      status: 'open',
      severity: 'high',
      ticket_id: ticketId,
      description: 'المفتاح ليس في خانته',
      opened_by: { id: U['SUP-R'], employee_code: 'S-0001' },
      owner: null,
      version: 1,
    });
    expect(inc[0]!.message.aggregate).toEqual({ type: 'incident', id: incidentId, version: 1 });
    expect(byRooms(ticketNotes(all, ticketId))).toEqual([[SUP_RMS]]);
    expectContract(all);
    void parkTaskId;
  });
});

describe('sync.required, channel.status and the job.ws_publish fallback', () => {
  let t: PushTestApp;
  beforeAll(async () => {
    t = await createPushTestApp();
  });
  afterAll(async () => t.close());

  it('event opened (real route): the venue supervisors and the event pool, scope events', async () => {
    const draft = ok(
      await t.command('post', `/v1/venues/${RMS}/events`, {
        as: 'SUP-R',
        body: { name_ar: 'حفل اختبار', event_date: '2026-10-30', pricing_mode: 'included' },
      }),
      201,
    );
    t.clearNotes();
    ok(await t.command('post', `/v1/events/${draft.id}/open`, { as: 'SUP-R' }));
    const notes = await t.published('sync.required');
    expect(notes).toHaveLength(1);
    expect([...notes[0]!.rooms].sort()).toEqual([SUP_RMS, rooms.poolDrivers(POOL_R)].sort());
    expect(notes[0]!.message.data).toEqual({
      cause: 'event.opened',
      reason: 'event_status_changed',
      scope: 'events',
      event_id: draft.id,
      dispatch_pool_id: POOL_R,
    });
    expect(notes[0]!.message.aggregate).toMatchObject({ type: 'event', id: draft.id });
    expectContract(notes);

    for (const type of ['event.closing_started', 'event.closed'] as const) {
      t.clearNotes();
      await t.emit({
        type,
        orgId: ORG,
        venueId: RMS,
        eventId: draft.id,
        aggregate: { type: 'event', id: draft.id, version: 9 },
        actor: { type: 'user', id: U['SUP-R'] },
        payload: {
          event_id: draft.id,
          status: type === 'event.closed' ? 'closed' : 'closing',
          by: U['SUP-R'],
        },
      });
      const n = await t.published('sync.required');
      expect(n.map((x) => x.message.data.cause)).toEqual([type]);
      expect([...n[0]!.rooms].sort()).toEqual([SUP_RMS, rooms.poolDrivers(POOL_R)].sort());
    }
  });

  it('shift closed / opened (real routes): scope home; ended duties and assigned drivers by user room', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const session = await one(t.db, `SELECT id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [
      U.DRV1,
    ]);
    t.clearNotes();
    ok(await t.command('post', `/v1/shifts/${SEED_IDS.shifts['SHF-R']}/close`, { as: 'SUP-R' }));
    let notes = await t.published('sync.required');
    expect(notes).toHaveLength(1);
    expect([...notes[0]!.rooms].sort()).toEqual(
      [SUP_RMS, rooms.poolDrivers(POOL_R), rooms.user(U.DRV1)].sort(),
    );
    expect(notes[0]!.message.data).toEqual({
      cause: 'shift.closed',
      reason: 'shift_status_changed',
      scope: 'home',
      shift_id: SEED_IDS.shifts['SHF-R'],
      dispatch_pool_id: POOL_R,
    });
    expect(session.id).toBeTruthy();
    expectContract(notes);

    const shift = ok(
      await t.command('post', `/v1/venues/${RMS}/shifts`, {
        as: 'SUP-R',
        body: { starts_at: '2026-10-27T16:00:00Z' },
      }),
      201,
    );
    t.clearNotes();
    ok(await t.command('post', `/v1/shifts/${shift.id}/open`, { as: 'SUP-R' }));
    notes = await t.published('sync.required');
    expect(notes).toHaveLength(1);
    const drivers = ['DRV1', 'DRV2', 'DRV3', 'DRV4', 'DRV5', 'DRV6'].map((d) => rooms.user((U as any)[d]));
    expect([...notes[0]!.rooms].sort()).toEqual([SUP_RMS, rooms.poolDrivers(POOL_R), ...drivers].sort());
    expect(notes[0]!.message.data).toMatchObject({
      cause: 'shift.opened',
      scope: 'home',
      shift_id: shift.id,
    });
    expectContract(notes);
  });

  it('channel health: one channel.status for every staff room (07 §4.3), never twice', async () => {
    t.clearNotes();
    await t.db.transaction((tx) =>
      setChannelHealth(tx, SEED_IDS.whatsappChannel, 'down', 'test', 'job.wa_send'),
    );
    const notes = await t.published('channel.status');
    expect(notes).toHaveLength(1);
    expect([...notes[0]!.rooms].sort()).toEqual(
      [
        rooms.orgAdmins(ORG),
        rooms.venueSupervisors(RMS),
        rooms.venueSupervisors(LYL),
        rooms.poolDrivers(POOL_R),
        rooms.poolDrivers(POOL_L),
      ].sort(),
    );
    expect(notes[0]!.message.data).toEqual({
      cause: 'wa.channel_health_changed',
      whatsapp: 'down',
      changed_at: t.clock.now().toISOString(),
    });
    expect(notes[0]!.message.aggregate).toEqual({
      type: 'whatsapp_channel',
      id: SEED_IDS.whatsappChannel,
      version: null,
    });
    expectContract(notes);
    // the core alert of the same change is published separately (alert.raised), not by this planner
    expect((await t.published('alert.raised')).length).toBeGreaterThan(0);
  });

  it('a publication too large for NOTIFY becomes sync.required for its rooms (job.ws_publish)', async () => {
    const target = [rooms.user(U.DRV1), rooms.user(U.DRV2)];
    await t.db.transaction((tx) =>
      publishRealtime(tx, ORG, target, {
        event: 'ticket.updated',
        id: randomUUID(),
        aggregate: { type: 'ticket', id: randomUUID(), version: 3 },
        data: { cause: 'ticket.parked', filler: 'x'.repeat(9000) },
      }),
    );
    const job = await one(t.db, `SELECT payload FROM outbox_events WHERE type = 'job.ws_publish'`);
    expect(job.payload.rooms).toEqual(target);
    t.clearNotes();
    await t.drain();
    const notes = await t.published('sync.required');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.rooms).toEqual(target);
    expect(notes[0]!.message.data).toEqual({ cause: 'job.ws_publish', reason: 'publish_overflow' });
    expect((await one(t.db, `SELECT status FROM outbox_events WHERE type = 'job.ws_publish'`)).status).toBe(
      'done',
    );
    expectContract(notes);
  });
});

describe('ticket.updated over the wire (Socket.IO, 07 §4.2)', () => {
  let t: PushTestApp;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createPushTestApp();
    await t.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  const connect = async (as: string) => {
    const s = io(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: ORIGIN, cookie: await t.sessionFor(as as never) },
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  };
  const next = (s: Socket, event: string, ms = 2000) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      s.once(event, (m: any) => {
        clearTimeout(timer);
        resolve(m);
      });
    });

  it('the supervisor and the creator receive the frame; a driver it does not concern does not', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    const sup = await connect('SUP-R');
    const drv1 = await connect('DRV1');
    const drv2 = await connect('DRV2');
    let other = 0;
    drv2.on('ticket.updated', () => other++);
    const forSup = next(sup, 'ticket.updated');
    const forCreator = next(drv1, 'ticket.updated');
    const created = ok(await startIntake(t, 'DRV1', { event_id: EVT_R1 }), 201);
    const schema = realtimeEnvelopeSchema('ticket.updated', REALTIME_PAYLOAD_SCHEMAS['ticket.updated']);
    for (const frame of [await forSup, await forCreator]) {
      expect(schema.parse(frame)).toEqual(frame);
      expect(frame.payload).toMatchObject({
        id: created.ticket.id,
        cause: 'ticket.created',
        status: 'received',
      });
      expect(frame.payload).not.toHaveProperty('customer');
      expect(frame.payload).not.toHaveProperty('key_tag');
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(other).toBe(0);
  });
});
