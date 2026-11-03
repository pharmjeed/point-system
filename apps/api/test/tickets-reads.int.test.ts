import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from './harness.js';
import {
  accept,
  createS2App,
  err,
  EVT_L1,
  EVT_R1,
  LYL,
  liveOffer,
  newDraft,
  ok,
  parkedPaperTicket,
  requestRetrieval,
  RMS,
  startDuty,
  U,
} from './dispatch-fixtures.js';

const DUMMY = '00000000-0000-4000-8000-0000deadbeef';

describe('GET /v1/me/home — DriverHome (full sync snapshot)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
  });
  afterEach(async () => t.close());

  it('off duty: venue, open events, assignment, shift open, checks', async () => {
    const h = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(h).toMatchObject({
      server_time: t.clock.now().toISOString(),
      user: { id: U.DRV1 },
      venue: { id: RMS, code: 'RMS' },
      shift_open: true,
      duty_session: null,
      driver_state: 'off_duty',
      connection_state: null,
      current_task: null,
      next_task: null,
      offer: null,
      draft_ticket_id: null,
      cash_outstanding_halalas: 0,
      checks: { audio_tested: false, push_enabled: false, pwa_installed: false },
      channel_health: 'healthy',
    });
    expect(h.active_assignment).toMatchObject({ venue_id: RMS, status: 'active' });
    expect(h.open_events.map((e: { id: string }) => e.id).sort()).toEqual(
      [EVT_R1, '00000000-0000-4000-8000-000700000002'].sort(),
    );
    // supervisors without can_drive have no duty.self (canon §10)
    err(await t.get('/v1/me/home', 'SUP-R'), 'PERMISSION_DENIED', 403);
  });

  it('the head offer card, then the current task card; the draft id while intake is open', async () => {
    ok(await startDuty(t, 'DRV1'), 201);
    t.clock.advanceSeconds(2);
    ok(await startDuty(t, 'DRV2'), 201);
    const p = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(10);
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    t.clock.advanceSeconds(7);
    const h = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(h.driver_state).toBe('available');
    expect(h.offer).toMatchObject({
      mode: 'single',
      eligible_as: 'accept',
      can_accept: true,
      can_reserve_next: false,
      server_time: t.clock.now().toISOString(),
      waiting_seconds: 7,
      ticket: { display_number: p.displayNumber, plate: { country: 'SA' } },
    });
    const offer = (await liveOffer(t.db, U.DRV1))!;
    expect(h.offer.offer_id).toBe(offer.id);
    ok(await accept(t, 'DRV1', offer.id));
    const h2 = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(h2.driver_state).toBe('retrieving');
    expect(h2.offer).toBeNull();
    expect(h2.current_task).toMatchObject({
      task: { id: offer.task_id, status: 'accepted' },
      ticket: { id: p.ticketId, display_number: p.displayNumber },
      key_slot: { id: p.slotId },
      parking: { spot_label: expect.any(String) },
    });
    const draft = await newDraft(t, 'DRV2');
    const h3 = ok(await t.get('/v1/me/home', 'DRV2'));
    expect(h3).toMatchObject({ draft_ticket_id: draft.ticketId, driver_state: 'intake_parking' });
    expect(h3.current_task.task.type).toBe('park');
  });

  it('the venue rules a driver screen needs (DEC-346) and the open shift with its open time (DEC-347)', async () => {
    const defaults = ok(await t.get('/v1/me/home', 'DRV1'));
    // canon §12 defaults when the venue stores nothing for these keys
    expect(defaults.settings).toEqual({
      inspection: {
        required_photos: ['photo_front', 'photo_rear', 'photo_left', 'photo_right'],
        max_extra_photos: 8,
      },
      parking: { mode: 'mixed' },
      keys: { require_slot: true },
      dispatch: { single_offer_ttl_s: 30 },
    });
    const prev = (await t.db.query(`SELECT settings FROM venues WHERE id = $1`, [RMS])).rows[0].settings;
    await t.db.query(`UPDATE venues SET settings = $2 WHERE id = $1`, [
      RMS,
      JSON.stringify({
        ...prev,
        keys: { require_slot: false },
        parking: { mode: 'assigned_spots' },
        inspection: { required_photos: ['photo_front', 'photo_rear'], max_extra_photos: 2 },
        dispatch: { single_offer_ttl_s: 45 },
      }),
    ]);
    const h = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(h.settings).toEqual({
      inspection: { required_photos: ['photo_front', 'photo_rear'], max_extra_photos: 2 },
      parking: { mode: 'assigned_spots' },
      keys: { require_slot: false },
      dispatch: { single_offer_ttl_s: 45 },
    });
    const shift = (
      await t.db.query<{ id: string; opened_at: Date }>(
        `SELECT id, opened_at FROM shifts WHERE venue_id = $1 AND status = 'open'`,
        [RMS],
      )
    ).rows[0]!;
    expect(h.shift_open).toBe(true);
    expect(h.shift).toEqual({ id: shift.id, status: 'open', opened_at: shift.opened_at.toISOString() });
    // no open shift for the pool → shift null (and shift_open false)
    await t.db.query(`UPDATE shifts SET status = 'closed', closed_at = now() WHERE id = $1`, [shift.id]);
    const closed = ok(await t.get('/v1/me/home', 'DRV1'));
    expect(closed).toMatchObject({ shift_open: false, shift: null });
  });
});

describe('GET /v1/tickets and GET /v1/tickets/{ticketId}', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createS2App();
    ok(await startDuty(t, 'DRV1'), 201);
    ok(await startDuty(t, 'DRV2'), 201);
  });
  afterEach(async () => t.close());

  it('a driver lists the open tickets of his venue only, newest first, minimal projection; cursor pagination', async () => {
    const a = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(1);
    const b = await parkedPaperTicket(t, 'DRV1');
    t.clock.advanceSeconds(1);
    const c = await newDraft(t, 'DRV2');
    ok(await startDuty(t, 'DRV7'), 201);
    await newDraft(t, 'DRV7', EVT_L1); // LYL: never visible to RMS drivers
    const page1 = await t.get('/v1/tickets?limit=2', 'DRV1');
    expect(page1.status).toBe(200);
    expect(page1.body.data.map((x: { id: string }) => x.id)).toEqual([c.ticketId, b.ticketId]);
    expect(page1.body.data[0]).not.toHaveProperty('projection');
    expect(page1.body.data[0]).not.toHaveProperty('key_tag');
    const cursor = page1.body.meta.next_cursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await t.get(`/v1/tickets?limit=2&cursor=${encodeURIComponent(cursor)}`, 'DRV1');
    expect(page2.body.data.map((x: { id: string }) => x.id)).toEqual([a.ticketId]);
    expect(page2.body.meta.next_cursor).toBeNull();
    // closed tickets are not listed for drivers even with open_only=false
    await t.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'x' WHERE id = $1`,
      [c.ticketId],
    );
    await t.db.query(`UPDATE tasks SET status = 'canceled', canceled_at = now() WHERE ticket_id = $1`, [
      c.ticketId,
    ]);
    const open = ok(await t.get('/v1/tickets?open_only=false', 'DRV1'));
    expect(open.map((x: { id: string }) => x.id)).not.toContain(c.ticketId);
    const sup = ok(await t.get('/v1/tickets?open_only=false', 'SUP-R'));
    expect(sup.map((x: { id: string }) => x.id)).toContain(c.ticketId);
  });

  it('filters: q (plate digits or number), status, event outside scope → empty, venue outside scope → SCOPE_VENUE_DENIED', async () => {
    const a = await parkedPaperTicket(t, 'DRV1');
    const plateDigits = (await t.db.query(`SELECT plate_digits FROM tickets WHERE id = $1`, [a.ticketId]))
      .rows[0].plate_digits as string;
    const byPlate = ok(await t.get(`/v1/tickets?q=${plateDigits}`, 'DRV1'));
    expect(byPlate.map((x: { id: string }) => x.id)).toContain(a.ticketId);
    const byNumber = ok(await t.get(`/v1/tickets?q=${a.displayNumber}`, 'SUP-R'));
    expect(byNumber.map((x: { id: string }) => x.id)).toContain(a.ticketId);
    expect(
      ok(await t.get(`/v1/tickets?status=parked`, 'SUP-R')).map((x: { status: string }) => x.status),
    ).toEqual(['parked']);
    err(await t.get(`/v1/tickets?status=parked,bogus`, 'SUP-R'), 'VALIDATION_FAILED', 422);
    expect(ok(await t.get(`/v1/tickets?event_id=${EVT_L1}`, 'SUP-R'))).toEqual([]);
    expect(err(await t.get(`/v1/tickets?venue_id=${LYL}`, 'SUP-R'), 'SCOPE_VENUE_DENIED', 403)).toEqual({
      venue_id: LYL,
    });
    err(await t.get(`/v1/tickets?venue_id=${LYL}`, 'DRV1'), 'SCOPE_VENUE_DENIED', 403);
    err(await t.get(`/v1/tickets?cursor=garbage`, 'DRV1'), 'PAGINATION_CURSOR_INVALID', 400);
  });

  it('detail: full for the creator during intake and staff, minimal for another driver; closed or foreign → TICKET_NOT_FOUND', async () => {
    const d = await newDraft(t, 'DRV1');
    const own = ok(await t.get(`/v1/tickets/${d.ticketId}`, 'DRV1'));
    expect(own).toMatchObject({ projection: 'full', vehicle_holder: { type: 'driver', id: U.DRV1 } });
    expect(own).not.toHaveProperty('created_by');
    const other = ok(await t.get(`/v1/tickets/${d.ticketId}`, 'DRV2'));
    expect(other.projection).toBe('minimal');
    for (const k of [
      'key_tag',
      'vehicle_holder',
      'key_holder',
      'media',
      'customer',
      'paper_serial',
      'fee_halalas',
      'current_spot',
    ])
      expect(other).not.toHaveProperty(k);
    expect(other.open_task).toMatchObject({ type: 'park', status: 'in_progress', assignee: null });
    const sup = ok(await t.get(`/v1/tickets/${d.ticketId}`, 'SUP-R'));
    expect(sup).toMatchObject({
      projection: 'full',
      created_by: { id: U.DRV1 },
      fee_halalas: 0,
      payment: null,
    });
    expect(sup.open_task.assignee).toMatchObject({ id: U.DRV1 });
    err(await t.get(`/v1/tickets/${d.ticketId}`, 'DRV7'), 'TICKET_NOT_FOUND', 404);
    err(await t.get(`/v1/tickets/${DUMMY}`, 'DRV1'), 'TICKET_NOT_FOUND', 404);
    err(await t.get(`/v1/tickets/not-a-uuid`, 'DRV1'), 'TICKET_NOT_FOUND', 404);
    await t.db.query(
      `UPDATE tickets SET status = 'voided', voided_at = now(), void_reason = 'x' WHERE id = $1`,
      [d.ticketId],
    );
    err(await t.get(`/v1/tickets/${d.ticketId}`, 'DRV1'), 'TICKET_NOT_FOUND', 404);
    expect(ok(await t.get(`/v1/tickets/${d.ticketId}`, 'SUP-R')).status).toBe('voided');
  });

  it('the retrieval assignee sees spot, key slot and fee but never the paper serial (09 §5.1)', async () => {
    const p = await parkedPaperTicket(t, 'DRV2');
    t.clock.advanceSeconds(1);
    ok(await requestRetrieval(t, 'SUP-R', p.ticketId), 201);
    const offer = (await liveOffer(t.db, U.DRV1))!;
    ok(await accept(t, 'DRV1', offer.id));
    const v = ok(await t.get(`/v1/tickets/${p.ticketId}`, 'DRV1'));
    expect(v).toMatchObject({ projection: 'full', fee_halalas: 0, current_key_slot: { id: p.slotId } });
    expect(v.current_spot).toMatchObject({ id: p.spotId });
    expect(v).not.toHaveProperty('paper_serial');
    expect(v).not.toHaveProperty('parked_by');
    // the parking driver is no longer involved: minimal
    expect(ok(await t.get(`/v1/tickets/${p.ticketId}`, 'DRV2')).projection).toBe('minimal');
  });
});
