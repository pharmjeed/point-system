import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SEED_IDS, type TestApp } from './harness.js';
import { auditRows, insertTicket, outboxTypes } from './venues-fixtures.js';

// PNT-019: event lifecycle — create (draft), PATCH, open (draft → open, closing → open), cancel (canon §9.5).
describe('PNT-019 event lifecycle', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const RMS = SEED_IDS.venues.RMS;
  const LYL = SEED_IDS.venues.LYL;
  const POOL_R = SEED_IDS.pools['POOL-R'];
  const fields = (r: { body: { error: { details: { fields: { field: string; issue: string }[] } } } }) =>
    r.body.error.details.fields.map((f) => `${f.field}:${f.issue}`);
  let displayNumber = 900;

  const create = (body: Record<string, unknown>, as = 'SUP-R', venueId: string = RMS) =>
    t.command('post', `/v1/venues/${venueId}/events`, { as, body });

  async function draft(extra: Record<string, unknown> = {}, venueId: string = RMS) {
    const r = await create(
      { name_ar: 'حفل زواج آل فلان', event_date: '2026-10-30', pricing_mode: 'included', ...extra },
      venueId === RMS ? 'SUP-R' : 'SUP-RL',
      venueId,
    );
    expect(r.status).toBe(201);
    return r.body.data as { id: string; version: number; status: string; dispatch_pool_id: string };
  }

  async function setStatus(eventId: string, status: 'closing' | 'closed') {
    await t.db.query(
      `UPDATE events SET status = $2, closing_started_at = now(),
              closed_at = CASE WHEN $2 = 'closed' THEN now() END, version = version + 1 WHERE id = $1`,
      [eventId, status],
    );
    const r = await t.db.query(`SELECT version FROM events WHERE id = $1`, [eventId]);
    return r.rows[0].version as number;
  }

  async function ticketOf(eventId: string, status: 'parked' | 'delivered' | 'voided') {
    return insertTicket(t.db, {
      eventId,
      venueId: RMS,
      poolId: POOL_R,
      displayNumber: displayNumber++,
      status,
      createdBy: SEED_IDS.users.DRV1,
      vehicle: status === 'parked' ? { type: 'spot', id: null } : { type: 'customer', id: null },
      key: { type: status === 'parked' ? 'key_slot' : 'customer', id: null },
    });
  }

  describe('create', () => {
    it('AC1: `included` with a fee or `per_vehicle` without a positive fee → VALIDATION_FAILED', async () => {
      const base = { name_ar: 'حفل', event_date: '2026-10-30' };
      const included = await create({ ...base, pricing_mode: 'included', fee_halalas: 500 });
      expect(included.status).toBe(422);
      expect(included.body.error.code).toBe('VALIDATION_FAILED');
      expect(fields(included)).toEqual(['fee_halalas:must_be_zero_when_included']);

      const noFee = await create({ ...base, pricing_mode: 'per_vehicle' });
      expect(noFee.status).toBe(422);
      expect(fields(noFee)).toEqual(['fee_halalas:positive_required_when_per_vehicle']);
      const zero = await create({ ...base, pricing_mode: 'per_vehicle', fee_halalas: 0 });
      expect(fields(zero)).toEqual(['fee_halalas:positive_required_when_per_vehicle']);
      const negative = await create({ ...base, pricing_mode: 'per_vehicle', fee_halalas: -5 });
      expect(fields(negative)).toEqual(['fee_halalas:too_small']);

      const card = await create({ ...base, pricing_mode: 'included', allowed_payment_methods: ['card'] });
      expect(fields(card)).toEqual(['allowed_payment_methods.0:invalid_value']);
      const empty = await create({ ...base, pricing_mode: 'included', allowed_payment_methods: [] });
      expect(fields(empty)).toEqual(['allowed_payment_methods:too_small']);
      const twice = await create({
        ...base,
        pricing_mode: 'per_vehicle',
        fee_halalas: 1000,
        allowed_payment_methods: ['cash', 'cash'],
      });
      expect(fields(twice)).toEqual(['allowed_payment_methods:duplicate']);
      const times = await create({
        ...base,
        pricing_mode: 'included',
        starts_at: '2026-10-30T20:00:00Z',
        ends_at: '2026-10-30T18:00:00Z',
      });
      expect(fields(times)).toEqual(['ends_at:before_starts_at']);
      const shape = await create({ pricing_mode: 'free', event_date: '30-10-2026', extra: true });
      expect(fields(shape)).toEqual(
        expect.arrayContaining([
          'name_ar:invalid_type',
          'event_date:invalid_format',
          'pricing_mode:invalid_value',
          'extra:unrecognized_key',
        ]),
      );
      const n = await t.db.query(`SELECT count(*)::int AS n FROM events WHERE name_ar = 'حفل'`);
      expect(n.rows[0].n).toBe(0);
    });

    it('creates a `draft` on the venue default pool; fee and methods default to the venue pricing settings', async () => {
      const r = await create({
        name_ar: 'حفل آل سالم',
        host_name: 'آل سالم',
        event_date: '2026-10-31',
        starts_at: '2026-10-31T17:00:00Z',
        pricing_mode: 'included',
      });
      expect(r.status).toBe(201);
      expect(r.body.data).toEqual({
        id: expect.any(String),
        venue_id: RMS,
        dispatch_pool_id: POOL_R,
        name_ar: 'حفل آل سالم',
        host_name: 'آل سالم',
        event_date: '2026-10-31',
        starts_at: '2026-10-31T17:00:00.000Z',
        ends_at: null,
        status: 'draft',
        pricing_mode: 'included',
        fee_halalas: 0,
        allowed_payment_methods: ['cash', 'pos'],
        opened_at: null,
        closing_started_at: null,
        closed_at: null,
        canceled_at: null,
        cancel_reason: null,
        close_summary: null,
        version: 1,
        created_at: t.clock.now().toISOString(),
      });
      const audit = await auditRows(t.db, r.body.data.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'event.manage', entity_type: 'event', venue_id: RMS });
      expect(await outboxTypes(t.db, r.body.data.id)).toEqual([]); // canon §7.1 has no event.created

      const paid = await create({
        name_ar: 'حفل برسوم',
        event_date: '2026-10-31',
        pricing_mode: 'per_vehicle',
        fee_halalas: 2500,
        allowed_payment_methods: ['cash'],
      });
      expect(paid.body.data).toMatchObject({
        pricing_mode: 'per_vehicle',
        fee_halalas: 2500,
        allowed_payment_methods: ['cash'],
      });

      // venue defaults: per_vehicle 1500 by POS only
      const put = await t.command('put', `/v1/venues/${LYL}/settings`, {
        as: 'ADM1',
        body: {
          expected_version: 1,
          settings: {
            pricing: { default_mode: 'per_vehicle', default_fee_halalas: 1500, allowed_methods: ['pos'] },
          },
        },
      });
      expect(put.status).toBe(200);
      const defaulted = await create(
        { name_ar: 'حفل ليلتي', event_date: '2026-11-01', pricing_mode: 'per_vehicle' },
        'SUP-RL',
        LYL,
      );
      expect(defaulted.status).toBe(201);
      expect(defaulted.body.data).toMatchObject({
        venue_id: LYL,
        dispatch_pool_id: SEED_IDS.pools['POOL-L'],
        fee_halalas: 1500,
        allowed_payment_methods: ['pos'],
      });
      const included = await create(
        { name_ar: 'حفل مشمول', event_date: '2026-11-01', pricing_mode: 'included' },
        'SUP-RL',
        LYL,
      );
      expect(included.body.data).toMatchObject({ fee_halalas: 0, allowed_payment_methods: ['pos'] });
    });

    it('a dispatch pool of another venue → RESOURCE_NOT_FOUND; a venue outside the scope → SCOPE_VENUE_DENIED', async () => {
      const foreign = await create({
        name_ar: 'حفل',
        event_date: '2026-10-30',
        pricing_mode: 'included',
        dispatch_pool_id: SEED_IDS.pools['POOL-L'],
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'dispatch_pool' },
      });
      const scope = await create(
        { name_ar: 'حفل', event_date: '2026-10-30', pricing_mode: 'included' },
        'SUP-R',
        LYL,
      );
      expect(scope.status).toBe(403);
      expect(scope.body.error).toMatchObject({ code: 'SCOPE_VENUE_DENIED', details: { venue_id: LYL } });
    });
  });

  describe('open', () => {
    it('AC2: draft → open emits event.opened in the same transaction; opening it again is INVALID_STATE_TRANSITION', async () => {
      const ev = await draft();
      const r = await t.command('post', `/v1/events/${ev.id}/open`, { as: 'SUP-R' });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        id: ev.id,
        status: 'open',
        opened_at: t.clock.now().toISOString(),
        version: 2,
      });
      const outbox = await t.db.query(
        `SELECT type, aggregate_type, aggregate_version, venue_id, ordering_key, payload FROM outbox_events WHERE aggregate_id = $1`,
        [ev.id],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        type: 'event.opened',
        aggregate_type: 'event',
        aggregate_version: 2,
        venue_id: RMS,
        ordering_key: null,
      });
      expect(outbox.rows[0].payload).toMatchObject({
        type: 'event.opened',
        org_id: SEED_IDS.org,
        venue_id: RMS,
        dispatch_pool_id: POOL_R,
        event_id: ev.id,
        aggregate: { type: 'event', id: ev.id, version: 2 },
        actor: { type: 'user', id: SEED_IDS.users['SUP-R'] },
        payload: { event_id: ev.id, status: 'open', by: SEED_IDS.users['SUP-R'] },
      });
      expect(outbox.rows[0].payload.payload.reopened).toBeUndefined();
      const audit = await auditRows(t.db, ev.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'event.manage',
        before: { status: 'draft' },
        after: { status: 'open' },
      });

      const again = await t.command('post', `/v1/events/${ev.id}/open`, { as: 'SUP-R', body: {} });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: {
          entity_type: 'event',
          entity_id: ev.id,
          current_status: 'open',
          current_version: 2,
          command: 'POST /v1/events/{eventId}/open',
          allowed_from: ['draft', 'closing'],
        },
      });
      expect(await outboxTypes(t.db, ev.id)).toEqual(['event.opened']);
    });

    it('closing → open reopens the event (canon §5 note): event.opened with reopened: true', async () => {
      const ev = await draft();
      await t.command('post', `/v1/events/${ev.id}/open`, { as: 'SUP-R' });
      const version = await setStatus(ev.id, 'closing');
      const stale = await t.command('post', `/v1/events/${ev.id}/open`, {
        as: 'SUP-R',
        body: { expected_version: version - 1 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { entity: 'event', id: ev.id, current_version: version },
      });
      const r = await t.command('post', `/v1/events/${ev.id}/open`, {
        as: 'SUP-R',
        body: { expected_version: version },
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: 'open', closing_started_at: null, version: version + 1 });
      const payloads = await t.db.query(
        `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'event.opened' ORDER BY seq`,
        [ev.id],
      );
      expect(payloads.rows.map((x) => x.payload.payload.reopened ?? false)).toEqual([false, true]);
    });

    it('open needs an active dispatch pool (11 §6.4)', async () => {
      const pool = await t.command('post', `/v1/venues/${RMS}/dispatch-pools`, {
        as: 'ADM1',
        body: { name: 'مغلقة' },
      });
      await t.command('patch', `/v1/dispatch-pools/${pool.body.data.id}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      const ev = await draft({ dispatch_pool_id: pool.body.data.id });
      expect(ev.dispatch_pool_id).toBe(pool.body.data.id);
      const r = await t.command('post', `/v1/events/${ev.id}/open`, { as: 'SUP-R' });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { current_status: 'draft', reason: 'dispatch_pool_inactive' },
      });
    });
  });

  describe('PATCH', () => {
    it('expected_version is mandatory and checked; pricing stays editable while open and applies to new tickets only', async () => {
      const ev = SEED_IDS.events['EVT-R2']; // open, per_vehicle 2000
      const ticket = await t.db.query(
        `INSERT INTO tickets (org_id, venue_id, event_id, dispatch_pool_id, display_number, status, created_by,
                              vehicle_holder_type, key_holder_type, fee_halalas, payment_status)
         VALUES ($1, $2, $3, $4, 1, 'parked', $5, 'spot', 'key_slot', 2000, 'due') RETURNING id`,
        [SEED_IDS.org, RMS, ev, POOL_R, SEED_IDS.users.DRV1],
      );
      const noVersion = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { fee_halalas: 3000 },
      });
      expect(noVersion.status).toBe(422);
      expect(fields(noVersion)).toEqual(['expected_version:invalid_type']);
      const stale = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { expected_version: 7, fee_halalas: 3000 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current_version: 1 } });

      const fee = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { expected_version: 1, fee_halalas: 3000, allowed_payment_methods: ['cash'] },
      });
      expect(fee.status).toBe(200);
      expect(fee.body.data).toMatchObject({
        status: 'open',
        pricing_mode: 'per_vehicle',
        fee_halalas: 3000,
        allowed_payment_methods: ['cash'],
        version: 2,
      });
      const snap = await t.db.query(`SELECT fee_halalas, payment_status FROM tickets WHERE id = $1`, [
        ticket.rows[0].id,
      ]);
      expect(snap.rows[0]).toEqual({ fee_halalas: 2000, payment_status: 'due' });
      const audit = await auditRows(t.db, ev);
      expect(audit.at(-1)).toMatchObject({
        action: 'event.manage',
        before: { fee_halalas: 2000, allowed_payment_methods: ['cash', 'pos'] },
        after: { fee_halalas: 3000, allowed_payment_methods: ['cash'] },
      });

      // the merged pricing is validated: `included` alone keeps the fee → rejected; with fee 0 → accepted
      const modeOnly = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { expected_version: 2, pricing_mode: 'included' },
      });
      expect(modeOnly.status).toBe(422);
      expect(fields(modeOnly)).toEqual(['fee_halalas:must_be_zero_when_included']);
      const toIncluded = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { expected_version: 2, pricing_mode: 'included', fee_halalas: 0, name_ar: 'حفل معدل' },
      });
      expect(toIncluded.body.data).toMatchObject({
        pricing_mode: 'included',
        fee_halalas: 0,
        name_ar: 'حفل معدل',
        version: 3,
      });
      const nothing = await t.command('patch', `/v1/events/${ev}`, {
        as: 'SUP-R',
        body: { expected_version: 3 },
      });
      expect(nothing.status).toBe(200);
      expect(nothing.body.data.version).toBe(3);
    });

    it('the dispatch pool can change only while draft (06: fixed after opening)', async () => {
      const second = await t.command('post', `/v1/venues/${RMS}/dispatch-pools`, {
        as: 'ADM1',
        body: { name: 'ثانية' },
      });
      const ev = await draft();
      const moved = await t.command('patch', `/v1/events/${ev.id}`, {
        as: 'SUP-R',
        body: { expected_version: 1, dispatch_pool_id: second.body.data.id },
      });
      expect(moved.status).toBe(200);
      expect(moved.body.data.dispatch_pool_id).toBe(second.body.data.id);
      const foreign = await t.command('patch', `/v1/events/${ev.id}`, {
        as: 'SUP-R',
        body: { expected_version: 2, dispatch_pool_id: SEED_IDS.pools['POOL-L'] },
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.details).toEqual({ resource: 'dispatch_pool' });

      const open = await t.command('patch', `/v1/events/${SEED_IDS.events['EVT-R1']}`, {
        as: 'SUP-R',
        body: { expected_version: 1, dispatch_pool_id: second.body.data.id },
      });
      expect(open.status).toBe(409);
      expect(open.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: {
          current_status: 'open',
          allowed_from: ['draft'],
          reason: 'dispatch_pool_fixed_after_open',
        },
      });
    });

    it('closing → INVALID_STATE_TRANSITION; closed or canceled → EVENT_ALREADY_CLOSED (also for open and cancel)', async () => {
      const closing = await draft();
      const closingVersion = await setStatus(closing.id, 'closing');
      const patchClosing = await t.command('patch', `/v1/events/${closing.id}`, {
        as: 'SUP-R',
        body: { expected_version: closingVersion, name_ar: 'x' },
      });
      expect(patchClosing.status).toBe(409);
      expect(patchClosing.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { current_status: 'closing', allowed_from: ['draft', 'open'] },
      });
      const cancelClosing = await t.command('post', `/v1/events/${closing.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: 'إلغاء خاطئ' },
      });
      expect(cancelClosing.body.error.code).toBe('INVALID_STATE_TRANSITION');

      const closed = await draft();
      const closedVersion = await setStatus(closed.id, 'closed');
      for (const [method, path, body] of [
        ['patch', `/v1/events/${closed.id}`, { expected_version: closedVersion, name_ar: 'x' }],
        ['post', `/v1/events/${closed.id}/open`, {}],
        ['post', `/v1/events/${closed.id}/cancel`, { reason: 'لا يمكن' }],
      ] as const) {
        const r = await t.command(method, path, { as: 'SUP-R', body });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatchObject({
          code: 'EVENT_ALREADY_CLOSED',
          details: { current_status: 'closed' },
        });
      }

      const canceled = await draft();
      await t.command('post', `/v1/events/${canceled.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: 'تأجيل الحفل' },
      });
      const reopen = await t.command('post', `/v1/events/${canceled.id}/open`, { as: 'SUP-R' });
      expect(reopen.status).toBe(409);
      expect(reopen.body.error).toMatchObject({
        code: 'EVENT_ALREADY_CLOSED',
        details: { current_status: 'canceled' },
      });
    });
  });

  describe('cancel', () => {
    it('needs a reason of at least 3 characters (REASON_REQUIRED, before the event is loaded)', async () => {
      const ev = await draft();
      for (const body of [{}, { reason: 'ab' }, { reason: '   ' }, { reason: null }]) {
        const r = await t.command('post', `/v1/events/${ev.id}/cancel`, { as: 'SUP-R', body });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatchObject({
          code: 'REASON_REQUIRED',
          details: { field: 'reason', min_length: 3 },
        });
      }
      const unknown = await t.command('post', `/v1/events/0b9c1a7e-1d2f-4c3b-9a8e-123456789abc/cancel`, {
        as: 'SUP-R',
        body: {},
      });
      expect(unknown.body.error.code).toBe('REASON_REQUIRED');
      const long = await t.command('post', `/v1/events/${ev.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: 'x'.repeat(501) },
      });
      expect(fields(long)).toEqual(['reason:too_big']);
    });

    it('AC3: a draft is canceled with its reason, audit only (no domain event)', async () => {
      const ev = await draft();
      const r = await t.command('post', `/v1/events/${ev.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: ' تأجيل الحفل ', expected_version: 1 },
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        status: 'canceled',
        canceled_at: t.clock.now().toISOString(),
        cancel_reason: 'تأجيل الحفل',
        version: 2,
      });
      expect(await outboxTypes(t.db, ev.id)).toEqual([]);
      const audit = await auditRows(t.db, ev.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'event.manage',
        reason: 'تأجيل الحفل',
        before: { status: 'draft' },
        after: { status: 'canceled' },
      });
    });

    it('AC3: an event with tickets other than `voided` → EVENT_CLOSE_BLOCKED; with only voided tickets it is canceled', async () => {
      const busy = await draft();
      await t.command('post', `/v1/events/${busy.id}/open`, { as: 'SUP-R' });
      const parked = await ticketOf(busy.id, 'parked');
      await ticketOf(busy.id, 'voided');
      const delivered = await ticketOf(busy.id, 'delivered');
      const r = await t.command('post', `/v1/events/${busy.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: 'إلغاء' },
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('EVENT_CLOSE_BLOCKED');
      expect(r.body.error.details).toMatchObject({ reason: 'non_voided_tickets', ticket_count: 2 });
      expect(
        r.body.error.details.blockers.non_voided_tickets.map((x: { id: string }) => x.id).sort(),
      ).toEqual([parked, delivered].sort());
      expect(r.body.error.details.blockers.non_voided_tickets[0]).toEqual({
        id: parked,
        display_number: expect.any(Number),
        status: 'parked',
      });
      const still = await t.db.query(`SELECT status FROM events WHERE id = $1`, [busy.id]);
      expect(still.rows[0].status).toBe('open');

      const quiet = await draft();
      await t.command('post', `/v1/events/${quiet.id}/open`, { as: 'SUP-R' });
      await ticketOf(quiet.id, 'voided');
      const ok = await t.command('post', `/v1/events/${quiet.id}/cancel`, {
        as: 'SUP-R',
        body: { reason: 'لم يحضر أحد' },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('canceled');
    });
  });

  describe('reads', () => {
    it('GET /v1/events/{eventId}: in scope → the event; outside the scope or unknown → 404 RESOURCE_NOT_FOUND', async () => {
      const r = await t.get(`/v1/events/${SEED_IDS.events['EVT-R1']}`, 'SUP-R');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        id: SEED_IDS.events['EVT-R1'],
        venue_id: RMS,
        status: 'open',
        event_date: '2026-10-27',
        pricing_mode: 'included',
      });
      for (const id of [SEED_IDS.events['EVT-L1'], '0b9c1a7e-1d2f-4c3b-9a8e-123456789abc', 'nope']) {
        const nf = await t.get(`/v1/events/${id}`, 'SUP-R');
        expect(nf.status).toBe(404);
        expect(nf.body.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND', details: { resource: 'event' } });
      }
      const lyl = await t.get(`/v1/events/${SEED_IDS.events['EVT-L1']}`, 'SUP-RL');
      expect(lyl.status).toBe(200);
    });

    it('GET /v1/venues/{venueId}/events: scope, status/date filters, newest first with a signed cursor', async () => {
      const denied = await t.get(`/v1/venues/${LYL}/events`, 'SUP-R');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('SCOPE_VENUE_DENIED');
      const driver = await t.get(`/v1/venues/${RMS}/events`, 'DRV1');
      expect(driver.status).toBe(403);
      expect(driver.body.error).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { permission: 'event.manage' },
      });

      const drafts = await t.get(`/v1/venues/${RMS}/events?status=draft`, 'SUP-R');
      expect(drafts.body.data.length).toBeGreaterThan(0);
      expect(drafts.body.data.every((e: { status: string }) => e.status === 'draft')).toBe(true);
      const two = await t.get(`/v1/venues/${RMS}/events?status=open&status=canceled`, 'SUP-R');
      expect(new Set(two.body.data.map((e: { status: string }) => e.status))).toEqual(
        new Set(['open', 'canceled']),
      );
      const dated = await t.get(`/v1/venues/${RMS}/events?from=2026-10-31&to=2026-10-31`, 'SUP-R');
      expect(dated.body.data.map((e: { event_date: string }) => e.event_date)).toEqual(
        dated.body.data.map(() => '2026-10-31'),
      );
      const reversed = await t.get(`/v1/venues/${RMS}/events?from=2026-11-01&to=2026-10-01`, 'SUP-R');
      expect(reversed.status).toBe(422);

      const ids: string[] = [];
      const dates: string[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          body: { data: { id: string; event_date: string }[]; meta: { next_cursor: string | null } };
        } = await t.get(
          `/v1/venues/${RMS}/events?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'SUP-R',
        );
        ids.push(...page.body.data.map((e) => e.id));
        dates.push(...page.body.data.map((e) => e.event_date));
        cursor = page.body.meta.next_cursor;
      } while (cursor);
      const total = await t.db.query(`SELECT count(*)::int AS n FROM events WHERE venue_id = $1`, [RMS]);
      expect(ids).toHaveLength(total.rows[0].n);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...dates]).toEqual([...dates].sort().reverse());

      const bad = await t.get(`/v1/venues/${RMS}/events?cursor=abc.def`, 'SUP-R');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
    });
  });
});
