import { emitEvent } from '@point/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, newKey, type TestApp } from './harness.js';
import {
  err,
  EVT_L1,
  EVT_R1,
  LYL,
  newDraft,
  ok,
  one,
  outboxEvents,
  parkedPaperTicket,
  POOL_R,
  RMS,
  rows,
  startDuty,
  U,
} from './dispatch-fixtures.js';
import {
  assignedRetrieval,
  auditRows,
  deliveredTicket,
  DUMMY,
  ORG,
  raise,
  realtimeListener,
  supervisorWorker,
} from './supervisor-fixtures.js';

let dedupeSeq = 0;
const key = (type: string) => `${type}:test-${dedupeSeq++}`;

describe('PNT-075 — alerts center (GET /v1/alerts, acknowledge, resolve)', () => {
  let t: TestApp;
  let rt: Awaited<ReturnType<typeof realtimeListener>>;
  beforeAll(async () => {
    t = await createTestApp();
    rt = await realtimeListener(t);
  });
  afterAll(async () => {
    await rt.close();
    await t.close();
  });
  beforeEach(async () => {
    await t.db.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE status <> 'resolved'`);
    rt.clear();
  });

  const ack = (as: string, id: string, body: unknown = {}, k?: string) =>
    t.command('post', `/v1/alerts/${id}/acknowledge`, { as, body, key: k });
  const resolve = (as: string, id: string, body: unknown = {}, k?: string) =>
    t.command('post', `/v1/alerts/${id}/resolve`, { as, body, key: k });

  it('lists the live alerts of the caller venues, newest first; filters; venue scope; signed cursor', async () => {
    const a1 = (
      await raise(t, { orgId: ORG, venueId: RMS, type: 'request_unaccepted', dedupeKey: key('ru') })
    ).alert;
    t.clock.advanceSeconds(1);
    const a2 = (
      await raise(t, { orgId: ORG, venueId: RMS, type: 'inspection_incomplete', dedupeKey: key('ii') })
    ).alert;
    t.clock.advanceSeconds(1);
    const a3 = (await raise(t, { orgId: ORG, venueId: LYL, type: 'draft_abandoned', dedupeKey: key('da') }))
      .alert;
    t.clock.advanceSeconds(1);
    const a4 = (await raise(t, { orgId: ORG, venueId: RMS, type: 'task_stuck', dedupeKey: key('ts') })).alert;
    ok(await ack('SUP-R', a4.id));

    // SUP-R (RMS): open + acknowledged by default, newest first; the LYL alert is not visible
    const page = ok(await t.get('/v1/alerts', 'SUP-R'));
    expect(page.map((a: any) => a.id)).toEqual([a4.id, a2.id, a1.id]);
    expect(page[0]).toMatchObject({
      id: a4.id,
      venue_id: RMS,
      type: 'task_stuck',
      severity: 'warning',
      status: 'acknowledged',
      acknowledged_by: U['SUP-R'],
    });
    expect(page[2]).toMatchObject({ type: 'request_unaccepted', severity: 'critical', status: 'open' });
    // SUP-RL and ADM1 see both venues
    expect(ok(await t.get('/v1/alerts', 'SUP-RL')).map((a: any) => a.id)).toEqual([
      a4.id,
      a3.id,
      a2.id,
      a1.id,
    ]);
    expect(ok(await t.get(`/v1/alerts?venue_id=${LYL}`, 'ADM1')).map((a: any) => a.id)).toEqual([a3.id]);
    // filters: status (repeated or comma list), type, severity
    expect(ok(await t.get('/v1/alerts?status=open', 'SUP-R')).map((a: any) => a.id)).toEqual([a2.id, a1.id]);
    expect(
      ok(await t.get('/v1/alerts?status=acknowledged&status=open', 'SUP-R')).map((a: any) => a.id),
    ).toEqual([a4.id, a2.id, a1.id]);
    expect(ok(await t.get('/v1/alerts?status=open,acknowledged', 'SUP-R')).length).toBe(3);
    expect(ok(await t.get('/v1/alerts?type=inspection_incomplete', 'SUP-R')).map((a: any) => a.id)).toEqual([
      a2.id,
    ]);
    expect(ok(await t.get('/v1/alerts?severity=critical', 'SUP-R')).map((a: any) => a.id)).toEqual([a1.id]);
    err(await t.get('/v1/alerts?status=closed', 'SUP-R'), 'VALIDATION_FAILED', 422);
    // a venue outside the scope is refused, not filtered to an empty list (08 §1.3)
    err(await t.get(`/v1/alerts?venue_id=${LYL}`, 'SUP-R'), 'SCOPE_VENUE_DENIED', 403);
    // drivers have no alert.read
    err(await t.get('/v1/alerts', 'DRV1'), 'PERMISSION_DENIED', 403);

    // keyset pagination with a signed cursor bound to the filters
    const p1 = await t.get('/v1/alerts?limit=2', 'SUP-R');
    expect(p1.body.data.map((a: any) => a.id)).toEqual([a4.id, a2.id]);
    const cursor = p1.body.meta.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    const p2 = await t.get(`/v1/alerts?limit=2&cursor=${encodeURIComponent(cursor)}`, 'SUP-R');
    expect(p2.body.data.map((a: any) => a.id)).toEqual([a1.id]);
    expect(p2.body.meta.next_cursor).toBeNull();
    err(
      await t.get(`/v1/alerts?limit=2&status=open&cursor=${encodeURIComponent(cursor)}`, 'SUP-R'),
      'PAGINATION_CURSOR_INVALID',
      400,
    );
    err(await t.get(`/v1/alerts?cursor=${cursor.slice(0, -2)}xx`, 'SUP-R'), 'PAGINATION_CURSOR_INVALID', 400);
  });

  it('dedupe is respected: a repeated condition refreshes the live alert; after resolution it raises a new one', async () => {
    const k = key('next');
    const first = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'next_task_waiting_long',
      dedupeKey: k,
      details: { waited_s: 300 },
    });
    const again = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'next_task_waiting_long',
      dedupeKey: k,
      details: { waited_s: 360 },
    });
    expect(again).toMatchObject({ created: false, alert: { id: first.alert.id } });
    const live = ok(await t.get('/v1/alerts?type=next_task_waiting_long', 'SUP-R'));
    expect(live).toHaveLength(1);
    expect(live[0].details).toEqual({ waited_s: 360 });
    ok(await resolve('SUP-R', first.alert.id, { note: 'تمت المتابعة' }));
    const fresh = await raise(t, { orgId: ORG, venueId: RMS, type: 'next_task_waiting_long', dedupeKey: k });
    expect(fresh.created).toBe(true);
    expect(fresh.alert.id).not.toBe(first.alert.id);
    const all = ok(await t.get('/v1/alerts?type=next_task_waiting_long&status=open,resolved', 'SUP-R'));
    expect(all.map((a: any) => [a.id, a.status])).toEqual([
      [fresh.alert.id, 'open'],
      [first.alert.id, 'resolved'],
    ]);
  });

  it('acknowledge: open → acknowledged, stops the escalation sound (alert.updated), audit; not twice', async () => {
    const { alert } = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'no_drivers_on_duty',
      dedupeKey: key('nd'),
      poolId: POOL_R,
    });
    await rt.settle();
    rt.clear();
    const k = newKey();
    t.clock.advanceSeconds(7);
    const r = ok(await ack('SUP-R', alert.id, { note: 'أتابع مع السائقين' }, k));
    expect(r).toMatchObject({
      id: alert.id,
      status: 'acknowledged',
      acknowledged_by: U['SUP-R'],
      acknowledged_at: t.clock.now().toISOString(),
      resolved_at: null,
    });
    // the same key replays the stored response; another key is an invalid transition
    expect(ok(await ack('SUP-R', alert.id, { note: 'أتابع مع السائقين' }, k))).toEqual(r);
    const d = err(await ack('SUP-R', alert.id), 'INVALID_STATE_TRANSITION', 409);
    expect(d).toMatchObject({
      entity_type: 'alert',
      entity_id: alert.id,
      current_status: 'acknowledged',
      command: 'POST /v1/alerts/{alertId}/acknowledge',
      allowed_from: ['open'],
    });
    const ev = (await outboxEvents(t.db, 'alert.acknowledged')).filter(
      (e) => e.payload.aggregate.id === alert.id,
    );
    expect(ev.map((e) => e.payload.payload)).toEqual([
      { alert_id: alert.id, type: 'no_drivers_on_duty', status: 'acknowledged', by: U['SUP-R'], auto: false },
    ]);
    await rt.settle();
    const frames = rt.notes.filter((n) => n.message.event === 'alert.updated');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.rooms).toEqual([`venue:${RMS}:supervisors`]);
    expect(frames[0]!.message.data).toMatchObject({
      cause: 'alert.acknowledged',
      id: alert.id,
      status: 'acknowledged',
    });
    const audits = await auditRows(t, 'alert.manage', alert.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: U['SUP-R'], entity_type: 'alert', venue_id: RMS });
    expect(audits[0].before).toEqual({ status: 'open' });
    expect(audits[0].after).toEqual({ status: 'acknowledged' });
    expect(audits[0].metadata).toMatchObject({ note: 'أتابع مع السائقين' });
    // acknowledging does not resolve: the alert stays live
    expect(ok(await t.get('/v1/alerts', 'SUP-R')).map((a: any) => a.id)).toContain(alert.id);
  });

  it('resolve: open or acknowledged → resolved with the note kept; realtime to the org admins for multi-venue types', async () => {
    const a = (
      await raise(t, { orgId: ORG, venueId: RMS, type: 'ready_not_collected', dedupeKey: key('rnc') })
    ).alert;
    const b = (await raise(t, { orgId: ORG, venueId: RMS, type: 'wa_channel_down', dedupeKey: key('wcd') }))
      .alert;
    ok(await ack('SUP-R', b.id));
    await rt.settle();
    rt.clear();
    const ra = ok(await resolve('SUP-R', a.id, { note: '  العميل استلم سيارته من البوابة  ' }));
    expect(ra).toMatchObject({
      status: 'resolved',
      resolved_by: U['SUP-R'],
      resolution_note: 'العميل استلم سيارته من البوابة',
      acknowledged_at: null,
    });
    const rb = ok(await resolve('ADM1', b.id, {}));
    expect(rb).toMatchObject({ status: 'resolved', resolved_by: U.ADM1, resolution_note: null });
    expect(
      (await one(t.db, `SELECT status, resolution_note FROM alerts WHERE id = $1`, [a.id])) as unknown,
    ).toEqual({ status: 'resolved', resolution_note: 'العميل استلم سيارته من البوابة' });
    const d = err(await resolve('SUP-R', a.id), 'INVALID_STATE_TRANSITION', 409);
    expect(d).toMatchObject({
      entity_type: 'alert',
      current_status: 'resolved',
      allowed_from: ['open', 'acknowledged'],
    });
    err(await ack('SUP-R', a.id), 'INVALID_STATE_TRANSITION', 409);
    const ev = (await outboxEvents(t.db, 'alert.resolved')).filter((e) =>
      [a.id, b.id].includes(e.payload.aggregate.id),
    );
    expect(ev.map((e) => e.payload.payload)).toEqual([
      { alert_id: a.id, type: 'ready_not_collected', status: 'resolved', by: U['SUP-R'], auto: false },
      { alert_id: b.id, type: 'wa_channel_down', status: 'resolved', by: U.ADM1, auto: false },
    ]);
    await rt.settle();
    const frames = rt.notes.filter((n) => n.message.event === 'alert.updated');
    expect(frames.map((f) => [f.message.data.id, f.rooms])).toEqual([
      [a.id, [`venue:${RMS}:supervisors`]],
      [b.id, [`venue:${RMS}:supervisors`, `org:${ORG}:admins`]],
    ]);
    expect((await auditRows(t, 'alert.manage', a.id))[0].metadata).toMatchObject({
      note: 'العميل استلم سيارته من البوابة',
    });
  });

  it('not found outside the scope, unknown or malformed ids; the note is bounded', async () => {
    const lyl = (await raise(t, { orgId: ORG, venueId: LYL, type: 'draft_abandoned', dedupeKey: key('l') }))
      .alert;
    expect(err(await ack('SUP-R', lyl.id), 'RESOURCE_NOT_FOUND', 404)).toEqual({ resource: 'alert' });
    err(await resolve('SUP-R', lyl.id), 'RESOURCE_NOT_FOUND', 404);
    err(await ack('SUP-R', DUMMY), 'RESOURCE_NOT_FOUND', 404);
    err(await resolve('SUP-R', 'not-a-uuid'), 'RESOURCE_NOT_FOUND', 404);
    const own = (await raise(t, { orgId: ORG, venueId: RMS, type: 'task_stuck', dedupeKey: key('n') })).alert;
    err(await resolve('SUP-R', own.id, { note: 'x'.repeat(301) }), 'VALIDATION_FAILED', 422);
    err(await resolve('SUP-R', own.id, { note: 'ok', extra: 1 }), 'VALIDATION_FAILED', 422);
    err(await ack('DRV1', own.id), 'PERMISSION_DENIED', 403);
    err(
      await t.command('post', `/v1/alerts/${own.id}/acknowledge`, { as: 'SUP-R', key: null }),
      'IDEMPOTENCY_KEY_REQUIRED',
      428,
    );
    // the SUP-RL in scope of LYL may resolve it
    ok(await resolve('SUP-RL', lyl.id));
    // a scope revoked after the guard is re-checked inside the transaction (TOCTOU, 09 §8.4)
    await t.db.query(`UPDATE role_scopes SET revoked_at = now() WHERE user_id = $1 AND venue_id = $2`, [
      U['SUP-RL'],
      RMS,
    ]);
    try {
      err(await ack('SUP-RL', own.id), 'RESOURCE_NOT_FOUND', 404);
    } finally {
      await t.db.query(`UPDATE role_scopes SET revoked_at = NULL WHERE user_id = $1 AND venue_id = $2`, [
        U['SUP-RL'],
        RMS,
      ]);
    }
  });
});

describe('PNT-075 — automatic resolution (AlertAutoResolver, 11 §6.10)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  it('task.claimed resolves request_unaccepted (resolved_by NULL, alert.resolved auto)', async () => {
    const worker = supervisorWorker(t);
    const p = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(1);
    const r = ok(
      await t.command('post', `/v1/tickets/${p.ticketId}/retrievals`, {
        as: 'SUP-R',
        body: { reason: 'العميل عند البوابة' },
      }),
      201,
    );
    const { alert } = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'request_unaccepted',
      dedupeKey: `request_unaccepted:${r.task.id}`,
      taskId: r.task.id,
      ticketId: p.ticketId,
    });
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM alerts WHERE id = $1`, [alert.id])).status).toBe('open');
    const offer = (
      await rows(t.db, `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active'`, [r.task.id])
    )[0];
    t.clock.advanceSeconds(3);
    ok(await t.command('post', `/v1/task-offers/${offer.id}/accept`, { as: 'DRV1', body: {} }));
    await worker.drain();
    // accept-offer resolves it inline; the projector repeats it idempotently (one alert.resolved only)
    expect(await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [alert.id])).toEqual({
      status: 'resolved',
      resolved_by: null,
    });
    const ev = (await outboxEvents(t.db, 'alert.resolved')).filter(
      (e) => e.payload.aggregate.id === alert.id,
    );
    expect(ev.map((e) => e.payload.payload)).toEqual([
      { alert_id: alert.id, type: 'request_unaccepted', status: 'resolved', by: null, auto: true },
    ]);
  });

  it('ticket.inspection_completed resolves inspection_incomplete; an alert raised after the event is left alone', async () => {
    const worker = supervisorWorker(t);
    const d = await newDraft(t, 'DRV2', EVT_R1);
    const ticket = await one(t.db, `SELECT * FROM tickets WHERE id = $1`, [d.ticketId]);
    const { alert } = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'inspection_incomplete',
      dedupeKey: `inspection_incomplete:${d.ticketId}`,
      ticketId: d.ticketId,
    });
    const emit = () =>
      t.db.transaction((tx) =>
        emitEvent(tx, {
          type: 'ticket.inspection_completed',
          orgId: ORG,
          venueId: RMS,
          aggregate: { type: 'ticket', id: d.ticketId, version: ticket.version },
          actor: { type: 'user', id: U.DRV2 },
          payload: {
            ticket: { ticket_id: d.ticketId, display_number: ticket.display_number, ticket_version: 1 },
            media_id: DUMMY,
          },
        }),
      );
    // the event is older than a re-raised alert: emitted first, alert resolved by hand and raised again later
    await emit();
    await t.db.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1`, [alert.id]);
    t.clock.advanceSeconds(10);
    const again = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'inspection_incomplete',
      dedupeKey: `inspection_incomplete:${d.ticketId}`,
      ticketId: d.ticketId,
    });
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM alerts WHERE id = $1`, [again.alert.id])).status).toBe(
      'open',
    );
    // a newer completion resolves it
    t.clock.advanceSeconds(1);
    await emit();
    await worker.drain();
    expect(await one(t.db, `SELECT status, resolved_by FROM alerts WHERE id = $1`, [again.alert.id])).toEqual(
      {
        status: 'resolved',
        resolved_by: null,
      },
    );
  });

  it('every rule of the table: the event clears exactly its dedupe keys', async () => {
    const worker = supervisorWorker(t);
    const T = '00000000-0000-4000-8000-00000000a001';
    const C = '00000000-0000-4000-8000-00000000c001';
    const K = '00000000-0000-4000-8000-00000000d001';
    const ref = { ticket_id: K, display_number: 1, ticket_version: 1 };
    const cases: [string, Record<string, unknown>, string[]][] = [
      ['task.claimed', { task_id: T }, [`request_unaccepted:${T}`]],
      [
        'task.started',
        { task_id: T },
        [`next_task_waiting_long:${T}`, `idle_driver_while_next_waiting:${T}`],
      ],
      [
        'task.promoted',
        { task_id: T },
        [`next_task_waiting_long:${T}`, `idle_driver_while_next_waiting:${T}`],
      ],
      [
        'task.reassigned',
        { task_id: T },
        [`next_task_waiting_long:${T}`, `idle_driver_while_next_waiting:${T}`],
      ],
      [
        'task.withdrawn',
        { task_id: T },
        [`next_task_waiting_long:${T}`, `idle_driver_while_next_waiting:${T}`],
      ],
      [
        'task.canceled',
        { task_id: T },
        [`request_unaccepted:${T}`, `next_task_waiting_long:${T}`, `idle_driver_while_next_waiting:${T}`],
      ],
      [
        'ticket.reparking',
        { ticket: ref, closed_cycle_id: C },
        [`ready_not_collected:${C}`, `handover_code_locked:${C}`],
      ],
      [
        'ticket.retrieval_canceled',
        { ticket: ref, cycle_id: C },
        [`ready_not_collected:${C}`, `handover_code_locked:${C}`],
      ],
      ['handover.code_issued', { ticket_id: K, cycle_id: C, resend_no: 1 }, [`handover_code_locked:${C}`]],
      ['handover.exception_approved', { ticket_id: K, cycle_id: C }, [`handover_code_locked:${C}`]],
      ['ticket.inspection_exception_approved', { ticket: ref }, [`inspection_incomplete:${K}`]],
      ['ticket.intake_submitted', { ticket: ref }, [`draft_abandoned:${K}`]],
      [
        'ticket.voided',
        { ticket: ref },
        [
          `draft_abandoned:${K}`,
          `inspection_incomplete:${K}`,
          `wa_send_failed:${K}:W-02`,
          `wa_send_failed:${K}:W-04`,
        ],
      ],
      [
        'ticket.manually_reconciled',
        { ticket: ref, target_status: 'delivered' },
        [`wa_send_failed:${K}:W-02`, `wa_send_failed:${K}:W-04`],
      ],
      ['ticket.manually_reconciled', { ticket: ref, target_status: 'parked' }, []],
    ];
    const all = [
      `request_unaccepted:${T}`,
      `next_task_waiting_long:${T}`,
      `idle_driver_while_next_waiting:${T}`,
      `ready_not_collected:${C}`,
      `handover_code_locked:${C}`,
      `inspection_incomplete:${K}`,
      `draft_abandoned:${K}`,
      `wa_send_failed:${K}:W-02`,
      `wa_send_failed:${K}:W-04`,
    ];
    const typeOf = (k: string) => k.split(':')[0] as any;
    for (const [type, payload, cleared] of cases) {
      await t.db.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE status <> 'resolved'`,
      );
      for (const k of all) await raise(t, { orgId: ORG, venueId: RMS, type: typeOf(k), dedupeKey: k });
      t.clock.advanceSeconds(1);
      await t.db.transaction((tx) =>
        emitEvent(tx, {
          type,
          orgId: ORG,
          venueId: RMS,
          aggregate: { type: 'ticket', id: K, version: 1 },
          actor: { type: 'system', id: null },
          payload,
        }),
      );
      await worker.drain();
      const live = (
        await rows(t.db, `SELECT dedupe_key FROM alerts WHERE status <> 'resolved' ORDER BY dedupe_key`)
      ).map((r) => r.dedupe_key);
      expect({ type, live }).toEqual({ type, live: all.filter((k) => !cleared.includes(k)).sort() });
    }
  });

  it('ticket.delivered resolves the cycle alerts and the ticket message failures', async () => {
    const worker = supervisorWorker(t);
    const a = await assignedRetrieval(t);
    const k1 = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'handover_code_locked',
      dedupeKey: `handover_code_locked:${a.cycleId}`,
    });
    const k2 = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'wa_send_failed',
      dedupeKey: `wa_send_failed:${a.ticketId}:W-04`,
    });
    const other = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'wa_send_failed',
      dedupeKey: `wa_send_failed:${DUMMY}:W-04`,
    });
    await t.command('post', `/v1/tasks/${a.retrieveTaskId}/key-pickup`, {
      as: 'DRV1',
      body: { key_slot_id: a.slotId },
    });
    await t.command('post', `/v1/tasks/${a.retrieveTaskId}/start-retrieval`, { as: 'DRV1', body: {} });
    await t.command('post', `/v1/tasks/${a.retrieveTaskId}/ready`, { as: 'DRV1', body: {} });
    ok(
      await t.command('post', `/v1/tickets/${a.ticketId}/handover`, {
        as: 'DRV1',
        body: { verification: { method: 'paper_stub', paper_serial: a.serial } },
      }),
    );
    await worker.drain();
    const status = async (id: string) =>
      (await one(t.db, `SELECT status FROM alerts WHERE id = $1`, [id])).status;
    expect(await status(k1.alert.id)).toBe('resolved');
    expect(await status(k2.alert.id)).toBe('resolved');
    expect(await status(other.alert.id)).toBe('open');
  });

  it('custody.changed: driver_connection_lost_with_custody clears once the driver holds nothing', async () => {
    const worker = supervisorWorker(t);
    const session = await one(t.db, `SELECT id FROM duty_sessions WHERE user_id = $1 AND ended_at IS NULL`, [
      U.DRV1,
    ]);
    const { alert } = await raise(t, {
      orgId: ORG,
      venueId: RMS,
      type: 'driver_connection_lost_with_custody',
      dedupeKey: `driver_connection_lost_with_custody:${session.id}`,
      userId: U.DRV1,
    });
    // DRV1 delivers a ticket: his custody ends with the handover
    await deliveredTicket(t);
    await worker.drain();
    expect((await one(t.db, `SELECT status FROM alerts WHERE id = $1`, [alert.id])).status).toBe('resolved');
  });
});

describe('PNT-083 — incidents (GET/POST /v1/incidents, GET/PATCH /v1/incidents/{incidentId})', () => {
  let t: TestApp;
  let rt: Awaited<ReturnType<typeof realtimeListener>>;
  let parked: Awaited<ReturnType<typeof parkedPaperTicket>>;
  let lylTicket: string;
  beforeAll(async () => {
    t = await createTestApp();
    rt = await realtimeListener(t);
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(5);
    ok(await startDuty(t, 'DRV2'), 201);
    ok(await startDuty(t, 'DRV7'), 201);
    parked = await parkedPaperTicket(t, 'DRV2');
    lylTicket = (await newDraft(t, 'DRV7', EVT_L1)).ticketId;
  });
  afterAll(async () => {
    await rt.close();
    await t.close();
  });

  const create = (as: string, body: unknown, k?: string) =>
    t.command('post', '/v1/incidents', { as, body, key: k });
  const patch = (as: string, id: string, body: unknown) =>
    t.command('patch', `/v1/incidents/${id}`, { as, body });

  it('a supervisor opens an incident on a ticket of his venue: 201, event from the ticket, incident.opened, audit', async () => {
    rt.clear();
    const res = await create('SUP-R', {
      venue_id: RMS,
      ticket_id: parked.ticketId,
      type: 'vehicle_damage',
      severity: 'high',
      description: '  خدش في الباب الأمامي الأيمن  ',
    });
    const i = ok(res, 201);
    expect(i).toMatchObject({
      venue_id: RMS,
      event_id: EVT_R1,
      ticket_id: parked.ticketId,
      type: 'vehicle_damage',
      status: 'open',
      severity: 'high',
      description: 'خدش في الباب الأمامي الأيمن',
      opened_by: { id: U['SUP-R'], full_name: expect.any(String) },
      owner: null,
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      closed_at: null,
      version: 1,
      created_at: t.clock.now().toISOString(),
    });
    const ev = (await outboxEvents(t.db, 'incident.opened')).filter((e) => e.payload.aggregate.id === i.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      venue_id: RMS,
      event_id: EVT_R1,
      aggregate: { type: 'incident', id: i.id, version: 1 },
      actor: { type: 'user', id: U['SUP-R'] },
      payload: {
        incident_id: i.id,
        type: 'vehicle_damage',
        status: 'open',
        severity: 'high',
        ticket_id: parked.ticketId,
        auto_created: false,
      },
    });
    const audits = await auditRows(t, 'incident.create', i.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: U['SUP-R'], venue_id: RMS });
    // no realtime from this module: the realtime planner relays the incident events (11 §8.8)
    await rt.settle();
    expect(rt.notes.filter((n) => n.message.event.startsWith('incident'))).toEqual([]);
    // the default severity is medium
    expect(
      ok(await create('SUP-R', { venue_id: RMS, type: 'other', description: 'ملاحظة عامة' }), 201),
    ).toMatchObject({
      severity: 'medium',
      ticket_id: null,
      event_id: null,
    });
  });

  it('venue and ticket scope: SCOPE_VENUE_DENIED, TICKET_NOT_FOUND, venue mismatches, event checks', async () => {
    err(
      await create('SUP-R', { venue_id: LYL, type: 'other', description: 'خارج النطاق' }),
      'SCOPE_VENUE_DENIED',
      403,
    );
    err(
      await create('SUP-R', {
        venue_id: RMS,
        ticket_id: lylTicket,
        type: 'other',
        description: 'تذكرة موقع آخر',
      }),
      'TICKET_NOT_FOUND',
      404,
    );
    err(
      await create('SUP-R', {
        venue_id: RMS,
        ticket_id: DUMMY,
        type: 'other',
        description: 'تذكرة غير موجودة',
      }),
      'TICKET_NOT_FOUND',
      404,
    );
    expect(
      err(
        await create('SUP-RL', {
          venue_id: LYL,
          ticket_id: parked.ticketId,
          type: 'other',
          description: 'موقع مختلف',
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'ticket_id', issue: 'venue_mismatch' }]);
    expect(
      err(
        await create('SUP-R', {
          venue_id: RMS,
          ticket_id: parked.ticketId,
          event_id: (
            await one(t.db, `SELECT id FROM events WHERE id <> $1 AND venue_id = $2 LIMIT 1`, [EVT_R1, RMS])
          ).id,
          type: 'other',
          description: 'حفل آخر',
        }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'event_id', issue: 'ticket_event_mismatch' }]);
    expect(
      err(
        await create('SUP-R', { venue_id: RMS, event_id: EVT_L1, type: 'other', description: 'حفل ليلتي' }),
        'RESOURCE_NOT_FOUND',
        404,
      ),
    ).toEqual({ resource: 'event' });
    expect(
      err(
        await create('SUP-RL', { venue_id: RMS, event_id: EVT_L1, type: 'other', description: 'حفل ليلتي' }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'event_id', issue: 'venue_mismatch' }]);
    // body validation: description 3…2000, canon types only, strict body
    err(await create('SUP-R', { venue_id: RMS, type: 'other', description: 'اب' }), 'VALIDATION_FAILED', 422);
    err(
      await create('SUP-R', { venue_id: RMS, type: 'flood', description: 'نوع غير معروف' }),
      'VALIDATION_FAILED',
      422,
    );
    err(
      await create('SUP-R', { venue_id: RMS, type: 'other', description: 'حقل زائد', status: 'resolved' }),
      'VALIDATION_FAILED',
      422,
    );
    // the owner has no incident.create (canon §10)
    err(
      await create('OWN1', { venue_id: RMS, type: 'other', description: 'المالك' }),
      'PERMISSION_DENIED',
      403,
    );
  });

  it('a driver opens incidents for the open tickets of his venue only', async () => {
    const i = ok(
      await create('DRV1', {
        venue_id: RMS,
        ticket_id: parked.ticketId,
        type: 'key_missing',
        description: 'المفتاح ليس في الخانة',
      }),
      201,
    );
    expect(i).toMatchObject({ opened_by: { id: U.DRV1 }, ticket_id: parked.ticketId, event_id: EVT_R1 });
    expect(
      err(
        await create('DRV1', { venue_id: RMS, type: 'other', description: 'دون تذكرة' }),
        'VALIDATION_FAILED',
        422,
      ).fields,
    ).toEqual([{ field: 'ticket_id', issue: 'required_for_driver' }]);
    err(
      await create('DRV1', { venue_id: LYL, ticket_id: lylTicket, type: 'other', description: 'موقع آخر' }),
      'SCOPE_VENUE_DENIED',
      403,
    );
    err(
      await create('DRV1', {
        venue_id: RMS,
        ticket_id: lylTicket,
        type: 'other',
        description: 'تذكرة موقع آخر',
      }),
      'TICKET_NOT_FOUND',
      404,
    );
    // a closed ticket does not exist for a driver
    const delivered = await deliveredTicket(t);
    err(
      await create('DRV1', {
        venue_id: RMS,
        ticket_id: delivered.ticketId,
        type: 'other',
        description: 'تذكرة مسلّمة',
      }),
      'TICKET_NOT_FOUND',
      404,
    );
    // … but staff may still document it
    ok(
      await create('SUP-R', {
        venue_id: RMS,
        ticket_id: delivered.ticketId,
        type: 'other',
        description: 'بعد التسليم',
      }),
      201,
    );
    // drivers read neither the list nor an incident (incident.read)
    err(await t.get('/v1/incidents', 'DRV1'), 'PERMISSION_DENIED', 403);
    err(await t.get(`/v1/incidents/${i.id}`, 'DRV1'), 'PERMISSION_DENIED', 403);
    err(await patch('DRV1', i.id, { expected_version: 1, severity: 'low' }), 'PERMISSION_DENIED', 403);
  });

  it('lists and reads within the scope; filters and signed cursor', async () => {
    const lyl = ok(
      await create('SUP-RL', {
        venue_id: LYL,
        ticket_id: lylTicket,
        type: 'custody_mismatch',
        description: 'عهدة ليلتي',
      }),
      201,
    );
    const mine = ok(await t.get('/v1/incidents?limit=200', 'SUP-R'));
    expect(mine.every((i: any) => i.venue_id === RMS)).toBe(true);
    expect(mine.map((i: any) => i.id)).not.toContain(lyl.id);
    const both = ok(await t.get('/v1/incidents?limit=200', 'SUP-RL'));
    expect(both.map((i: any) => i.id)).toContain(lyl.id);
    expect(both.length).toBe(mine.length + 1);
    // newest first
    const created = both.map((i: any) => i.created_at);
    expect([...created].sort().reverse()).toEqual(created);
    expect(
      ok(await t.get(`/v1/incidents?ticket_id=${parked.ticketId}`, 'SUP-R')).every(
        (i: any) => i.ticket_id === parked.ticketId,
      ),
    ).toBe(true);
    expect(ok(await t.get(`/v1/incidents?ticket_id=${lylTicket}`, 'SUP-R'))).toEqual([]); // intersected with the scope
    expect(ok(await t.get('/v1/incidents?type=key_missing', 'SUP-R')).map((i: any) => i.type)).toEqual([
      'key_missing',
    ]);
    expect(ok(await t.get(`/v1/incidents?event_id=${EVT_R1}&status=open`, 'SUP-R')).length).toBeGreaterThan(
      0,
    );
    err(await t.get(`/v1/incidents?venue_id=${LYL}`, 'SUP-R'), 'SCOPE_VENUE_DENIED', 403);
    err(await t.get('/v1/incidents?status=done', 'SUP-R'), 'VALIDATION_FAILED', 422);
    const p1 = await t.get('/v1/incidents?limit=1', 'SUP-R');
    const p2 = await t.get(
      `/v1/incidents?limit=1&cursor=${encodeURIComponent(p1.body.meta.next_cursor)}`,
      'SUP-R',
    );
    expect(p2.body.data[0].id).toBe(mine[1].id);
    err(
      await t.get(
        `/v1/incidents?limit=1&type=other&cursor=${encodeURIComponent(p1.body.meta.next_cursor)}`,
        'SUP-R',
      ),
      'PAGINATION_CURSOR_INVALID',
      400,
    );
    // read by id: in scope, outside the scope or unknown
    expect(ok(await t.get(`/v1/incidents/${lyl.id}`, 'SUP-RL'))).toMatchObject({
      id: lyl.id,
      type: 'custody_mismatch',
    });
    expect(err(await t.get(`/v1/incidents/${lyl.id}`, 'SUP-R'), 'RESOURCE_NOT_FOUND', 404)).toEqual({
      resource: 'incident',
    });
    err(await t.get(`/v1/incidents/${DUMMY}`, 'ADM1'), 'RESOURCE_NOT_FOUND', 404);
    err(await t.get('/v1/incidents/nope', 'ADM1'), 'RESOURCE_NOT_FOUND', 404);
    expect(ok(await t.get(`/v1/incidents/${lyl.id}`, 'OWN1')).id).toBe(lyl.id);
  });

  it('PATCH: transitions of 11 §6.11, resolution required, version guard, owner, one event per change', async () => {
    const i = ok(
      await create('SUP-R', {
        venue_id: RMS,
        ticket_id: parked.ticketId,
        type: 'lost_ticket',
        description: 'فقد العميل الكعب',
      }),
      201,
    );
    // open → closed is not a transition
    expect(
      err(
        await patch('SUP-R', i.id, { expected_version: 1, status: 'closed' }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      entity_type: 'incident',
      entity_id: i.id,
      current_status: 'open',
      current_version: 1,
      command: 'PATCH /v1/incidents/{incidentId}',
      allowed_from: ['resolved'],
    });
    // resolving without a resolution text
    expect(
      err(await patch('SUP-R', i.id, { expected_version: 1, status: 'resolved' }), 'VALIDATION_FAILED', 422)
        .fields,
    ).toEqual([{ field: 'resolution', issue: 'required' }]);
    err(
      await patch('SUP-R', i.id, { expected_version: 1, status: 'resolved', resolution: '   ' }),
      'VALIDATION_FAILED',
      422,
    );
    // owner: unknown, a driver, then a supervisor of the venue
    expect(
      err(await patch('SUP-R', i.id, { expected_version: 1, owner_id: DUMMY }), 'RESOURCE_NOT_FOUND', 404),
    ).toEqual({ resource: 'user' });
    expect(
      err(await patch('SUP-R', i.id, { expected_version: 1, owner_id: U.DRV1 }), 'VALIDATION_FAILED', 422)
        .fields,
    ).toEqual([{ field: 'owner_id', issue: 'not_eligible' }]);
    const r1 = ok(
      await patch('SUP-R', i.id, {
        expected_version: 1,
        status: 'in_review',
        owner_id: U['SUP-RL'],
        severity: 'high',
      }),
    );
    expect(r1).toMatchObject({
      status: 'in_review',
      owner: { id: U['SUP-RL'] },
      severity: 'high',
      version: 2,
    });
    // stale version
    expect(
      err(await patch('SUP-R', i.id, { expected_version: 1, severity: 'low' }), 'VERSION_CONFLICT', 409),
    ).toEqual({
      entity: 'incident',
      id: i.id,
      current_version: 2,
    });
    t.clock.advanceSeconds(30);
    const r2 = ok(
      await patch('SUP-R', i.id, {
        expected_version: 2,
        status: 'resolved',
        resolution: 'تحقق المشرف من الهوية وسُلّمت السيارة',
      }),
    );
    expect(r2).toMatchObject({
      status: 'resolved',
      resolution: 'تحقق المشرف من الهوية وسُلّمت السيارة',
      resolved_by: { id: U['SUP-R'] },
      resolved_at: t.clock.now().toISOString(),
      version: 3,
    });
    // clearing the resolution of a resolved incident is refused
    err(await patch('SUP-R', i.id, { expected_version: 3, resolution: null }), 'VALIDATION_FAILED', 422);
    // reopen: resolved → in_review clears the previous outcome; resolve again; close
    const r3 = ok(await patch('SUP-R', i.id, { expected_version: 3, status: 'in_review' }));
    expect(r3).toMatchObject({
      status: 'in_review',
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      version: 4,
    });
    ok(
      await patch('SUP-R', i.id, {
        expected_version: 4,
        status: 'resolved',
        resolution: 'أُغلقت بعد المراجعة',
      }),
    );
    const r5 = ok(await patch('ADM1', i.id, { expected_version: 5, status: 'closed' }));
    expect(r5).toMatchObject({
      status: 'closed',
      closed_at: t.clock.now().toISOString(),
      resolution: 'أُغلقت بعد المراجعة',
      version: 6,
    });
    // closed is final
    expect(
      err(
        await patch('SUP-R', i.id, { expected_version: 6, severity: 'low' }),
        'INVALID_STATE_TRANSITION',
        409,
      ),
    ).toMatchObject({
      current_status: 'closed',
      reason: 'incident_closed',
    });
    // a no-op PATCH changes nothing (no version bump, no event) but is audited
    const j = ok(await create('SUP-R', { venue_id: RMS, type: 'other', description: 'بلا تغيير' }), 201);
    expect(ok(await patch('SUP-R', j.id, { expected_version: 1, severity: 'medium' }))).toMatchObject({
      version: 1,
    });

    const events = (type: string) =>
      outboxEvents(t.db, type).then((es) =>
        es.filter((e) => e.payload.aggregate.id === i.id).map((e) => e.payload.payload.status),
      );
    expect(await events('incident.updated')).toEqual(['in_review', 'in_review', 'closed']);
    expect(await events('incident.resolved')).toEqual(['resolved', 'resolved']);
    expect(
      (await outboxEvents(t.db, 'incident.updated')).filter((e) => e.payload.aggregate.id === j.id),
    ).toEqual([]);
    const audits = await auditRows(t, 'incident.manage', i.id);
    expect(audits.map((a) => a.after.status ?? null)).toEqual([
      'in_review',
      'resolved',
      'in_review',
      'resolved',
      'closed',
    ]);
    expect(await auditRows(t, 'incident.manage', j.id)).toHaveLength(1);
    // a supervisor outside the scope cannot touch it
    const lyl = ok(
      await create('SUP-RL', { venue_id: LYL, ticket_id: lylTicket, type: 'other', description: 'ليلتي' }),
      201,
    );
    err(await patch('SUP-R', lyl.id, { expected_version: 1, severity: 'low' }), 'RESOURCE_NOT_FOUND', 404);
    err(await patch('OWN1', lyl.id, { expected_version: 1, severity: 'low' }), 'PERMISSION_DENIED', 403);
  });
});
