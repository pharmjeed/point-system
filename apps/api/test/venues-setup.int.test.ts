import { seedKeySlotId, seedSpotId } from '@point/db/seed';
import { VENUE_SETTINGS_DEFAULTS } from '@point/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SEED_IDS, type TestApp } from './harness.js';
import { auditRows, endAssignment, insertTask, insertTicket, parkTicket } from './venues-fixtures.js';

// PNT-018: venues, settings, dispatch pools, parking zones/spots, key boards/slots (canon §9.5).
describe('PNT-018 venues, settings, pools and layout', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const RMS = SEED_IDS.venues.RMS;
  const LYL = SEED_IDS.venues.LYL;
  const fields = (r: { body: { error: { details: { fields: { field: string; issue: string }[] } } } }) =>
    r.body.error.details.fields.map((f) => `${f.field}:${f.issue}`);

  async function newVenue(code: string) {
    const r = await t.command('post', '/v1/venues', { as: 'ADM1', body: { code, name_ar: `قاعة ${code}` } });
    expect(r.status).toBe(201);
    return r.body.data as { id: string; version: number; default_dispatch_pool_id: string };
  }

  describe('venues', () => {
    it('POST /v1/venues creates the venue with exactly one default dispatch pool and the default settings (AC1)', async () => {
      const r = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        body: { code: 'NEW1', name_ar: 'قاعة جديدة', name_en: 'New Hall', city: 'المدينة المنورة' },
      });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        code: 'NEW1',
        name_ar: 'قاعة جديدة',
        name_en: 'New Hall',
        city: 'المدينة المنورة',
        address: null,
        timezone: 'Asia/Riyadh',
        status: 'active',
        version: 1,
      });
      const venueId = r.body.data.id as string;
      const pools = await t.db.query(
        `SELECT id, is_default, status FROM dispatch_pools WHERE venue_id = $1`,
        [venueId],
      );
      expect(pools.rows).toHaveLength(1);
      expect(pools.rows[0]).toMatchObject({ is_default: true, status: 'active' });
      expect(r.body.data.default_dispatch_pool_id).toBe(pools.rows[0].id);

      const s = await t.get(`/v1/venues/${venueId}/settings`, 'ADM1');
      expect(s.status).toBe(200);
      expect(s.body.data).toEqual({ settings: VENUE_SETTINGS_DEFAULTS, version: 1 });

      const audit = await auditRows(t.db, venueId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'venue.manage',
        entity_type: 'venue',
        venue_id: venueId,
        actor_id: SEED_IDS.users.ADM1,
      });
      expect(audit[0]!.metadata).toMatchObject({ command: 'POST /v1/venues' });
    });

    it('a duplicate code is VALIDATION_FAILED on `code` (venues_org_id_code_key); bad input is VALIDATION_FAILED with fields', async () => {
      const dup = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        body: { code: 'RMS', name_ar: 'مكرر' },
      });
      expect(dup.status).toBe(422);
      expect(dup.body.error.code).toBe('VALIDATION_FAILED');
      expect(fields(dup)).toEqual(['code:duplicate']);

      const bad = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        body: { code: 'rm', name_ar: '', timezone: 'Mars/Olympus', extra: 1 },
      });
      expect(bad.status).toBe(422);
      expect(fields(bad)).toEqual(
        expect.arrayContaining([
          'code:invalid_format',
          'name_ar:too_small',
          'timezone:custom',
          'extra:unrecognized_key',
        ]),
      );
      const count = await t.db.query(`SELECT count(*)::int AS n FROM venues WHERE code IN ('rm')`);
      expect(count.rows[0].n).toBe(0);
    });

    it('the same Idempotency-Key replays the creation without a second venue', async () => {
      const key = 'venue-create-replay-1';
      const a = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        key,
        body: { code: 'REP1', name_ar: 'إعادة' },
      });
      const b = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        key,
        body: { code: 'REP1', name_ar: 'إعادة' },
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data).toEqual(a.body.data);
      const n = await t.db.query(`SELECT count(*)::int AS n FROM venues WHERE code = 'REP1'`);
      expect(n.rows[0].n).toBe(1);
      const reused = await t.command('post', '/v1/venues', {
        as: 'ADM1',
        key,
        body: { code: 'REP2', name_ar: 'أخرى' },
      });
      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('GET /v1/venues returns the caller scope only, filters by status and pages with a signed cursor', async () => {
      const sup = await t.get('/v1/venues', 'SUP-R');
      expect(sup.status).toBe(200);
      expect(sup.body.data.map((v: { code: string }) => v.code)).toEqual(['RMS']);
      expect(sup.body.meta.next_cursor).toBeNull();

      const both = await t.get('/v1/venues', 'SUP-RL');
      expect(both.body.data.map((v: { code: string }) => v.code)).toEqual(['LYL', 'RMS']);

      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: { code: string }[]; meta: { next_cursor: string | null } } } =
          await t.get(`/v1/venues?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'ADM1');
        expect(page.body.data.length).toBeLessThanOrEqual(2);
        all.push(...page.body.data.map((v) => v.code));
        cursor = page.body.meta.next_cursor;
      } while (cursor);
      const expected = (await t.db.query(`SELECT code FROM venues ORDER BY code`)).rows.map((r) => r.code);
      expect(all).toEqual(expected);

      const first = await t.get('/v1/venues?limit=1', 'ADM1');
      const tampered = `${first.body.meta.next_cursor}x`;
      const bad = await t.get(`/v1/venues?limit=1&cursor=${encodeURIComponent(tampered)}`, 'ADM1');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
      const otherFilter = await t.get(
        `/v1/venues?status=active&cursor=${encodeURIComponent(first.body.meta.next_cursor)}`,
        'ADM1',
      );
      expect(otherFilter.status).toBe(400);

      const v = await newVenue('OFF1');
      await t.command('patch', `/v1/venues/${v.id}`, {
        as: 'ADM1',
        body: { expected_version: 1, status: 'inactive' },
      });
      const inactive = await t.get('/v1/venues?status=inactive', 'ADM1');
      expect(inactive.body.data.map((x: { code: string }) => x.code)).toEqual(['OFF1']);
    });

    it('GET /v1/venues/{venueId}: out of a supervisor scope → SCOPE_VENUE_DENIED; unknown for an admin → RESOURCE_NOT_FOUND', async () => {
      const ok = await t.get(`/v1/venues/${RMS}`, 'SUP-R');
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        id: RMS,
        code: 'RMS',
        default_dispatch_pool_id: SEED_IDS.pools['POOL-R'],
      });

      const denied = await t.get(`/v1/venues/${LYL}`, 'SUP-R');
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'SCOPE_VENUE_DENIED', details: { venue_id: LYL } });

      const missing = await t.get('/v1/venues/0b9c1a7e-1d2f-4c3b-9a8e-123456789abc', 'ADM1');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'venue' },
      });
      const malformed = await t.get('/v1/venues/not-a-uuid', 'ADM1');
      expect(malformed.status).toBe(404);
    });

    it('PATCH /v1/venues/{venueId}: expected_version is mandatory, a stale one is VERSION_CONFLICT', async () => {
      const v = await newVenue('PAT1');
      const missing = await t.command('patch', `/v1/venues/${v.id}`, { as: 'ADM1', body: { name_ar: 'x' } });
      expect(missing.status).toBe(422);
      expect(fields(missing)).toContain('expected_version:invalid_type');

      const ok = await t.command('patch', `/v1/venues/${v.id}`, {
        as: 'ADM1',
        body: { expected_version: 1, name_ar: 'قاعة معدلة', address: 'طريق الملك', name_en: null },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        name_ar: 'قاعة معدلة',
        address: 'طريق الملك',
        name_en: null,
        version: 2,
      });

      const stale = await t.command('patch', `/v1/venues/${v.id}`, {
        as: 'ADM1',
        body: { expected_version: 1, name_ar: 'مرة أخرى' },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { entity: 'venue', id: v.id, current_version: 2 },
      });
      const audit = await auditRows(t.db, v.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'venue.manage',
        before: { name_ar: 'قاعة PAT1', address: null },
        after: { name_ar: 'قاعة معدلة', address: 'طريق الملك' },
      });
    });
  });

  describe('venue settings (canon §12)', () => {
    it('GET returns every canon §12 key completed with its default and the venue version', async () => {
      const r = await t.get(`/v1/venues/${RMS}/settings`, 'SUP-R');
      expect(r.status).toBe(200);
      expect(r.body.data.settings).toEqual(VENUE_SETTINGS_DEFAULTS);
      expect(r.body.data.version).toBe(1);
      const denied = await t.get(`/v1/venues/${LYL}/settings`, 'SUP-R');
      expect(denied.body.error.code).toBe('SCOPE_VENUE_DENIED');
    });

    it('PUT with invalid settings → VALIDATION_FAILED naming every invalid field (AC2)', async () => {
      const v = await newVenue('SET1');
      const r = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: {
          expected_version: 1,
          settings: {
            dispatch: { single_offer_ttl_s: 5, foo: 1 },
            handover: { max_attempts: 50 },
            parking: { mode: 'valet' },
            pricing: { default_mode: 'included', default_fee_halalas: 1500 },
            unknown_group: {},
          },
        },
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      expect(fields(r)).toEqual(
        expect.arrayContaining([
          'settings.dispatch.single_offer_ttl_s:too_small',
          'settings.dispatch.foo:unrecognized_key',
          'settings.handover.max_attempts:too_big',
          'settings.parking.mode:invalid_value',
          'settings.pricing.default_fee_halalas:custom',
          'settings.unknown_group:unrecognized_key',
        ]),
      );
      const reminder = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: {
          expected_version: 1,
          settings: { dispatch: { single_offer_ttl_s: 20, single_offer_reminder_s: 18 } },
        },
      });
      expect(fields(reminder)).toEqual(['settings.dispatch.single_offer_reminder_s:custom']);
      const stored = await t.db.query(`SELECT version FROM venues WHERE id = $1`, [v.id]);
      expect(stored.rows[0].version).toBe(1);
    });

    it('PUT replaces the settings (missing keys take the default), bumps the version; a stale version → VERSION_CONFLICT', async () => {
      const v = await newVenue('SET2');
      const first = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: {
          expected_version: 1,
          settings: { dispatch: { single_offer_ttl_s: 40 }, keys: { require_slot: false } },
        },
      });
      expect(first.status).toBe(200);
      expect(first.body.data.version).toBe(2);
      expect(first.body.data.settings.dispatch).toEqual({
        ...VENUE_SETTINGS_DEFAULTS.dispatch,
        single_offer_ttl_s: 40,
      });
      expect(first.body.data.settings.keys).toEqual({ require_slot: false });

      // replace, not merge: keys.require_slot returns to its default
      const second = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: {
          expected_version: 2,
          settings: { pricing: { default_mode: 'per_vehicle', default_fee_halalas: 2500 } },
        },
      });
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual({
        settings: {
          ...VENUE_SETTINGS_DEFAULTS,
          pricing: {
            default_mode: 'per_vehicle',
            default_fee_halalas: 2500,
            allowed_methods: ['cash', 'pos'],
          },
        },
        version: 3,
      });
      const got = await t.get(`/v1/venues/${v.id}/settings`, 'ADM1');
      expect(got.body.data).toEqual(second.body.data);

      const stale = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: { expected_version: 2, settings: {} },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current_version: 3 } });
      const noVersion = await t.command('put', `/v1/venues/${v.id}/settings`, {
        as: 'ADM1',
        body: { settings: {} },
      });
      expect(fields(noVersion)).toEqual(['expected_version:invalid_type']);

      const audit = await auditRows(t.db, v.id);
      expect(
        audit.filter((a) => (a.metadata as { change?: string } | null)?.change === 'settings'),
      ).toHaveLength(2);
    });
  });

  describe('dispatch pools', () => {
    it('GET lists the default pool first; POST adds a non-default pool; a duplicate name is VALIDATION_FAILED', async () => {
      const v = await newVenue('POL1');
      const extra = await t.command('post', `/v1/venues/${v.id}/dispatch-pools`, {
        as: 'ADM1',
        body: { name: 'الصالة الثانية' },
      });
      expect(extra.status).toBe(201);
      expect(extra.body.data).toMatchObject({
        venue_id: v.id,
        name: 'الصالة الثانية',
        is_default: false,
        status: 'active',
      });
      const dup = await t.command('post', `/v1/venues/${v.id}/dispatch-pools`, {
        as: 'ADM1',
        body: { name: 'الصالة الثانية' },
      });
      expect(dup.status).toBe(422);
      expect(fields(dup)).toEqual(['name:duplicate']);
      const list = await t.get(`/v1/venues/${v.id}/dispatch-pools`, 'ADM1');
      expect(list.body.data.map((p: { is_default: boolean }) => p.is_default)).toEqual([true, false]);
      const sup = await t.get(`/v1/venues/${RMS}/dispatch-pools`, 'SUP-R');
      expect(sup.body.data).toHaveLength(1);
      expect(sup.body.data[0]).toMatchObject({ id: SEED_IDS.pools['POOL-R'], is_default: true });
    });

    it('PATCH is_default=true moves the default (always exactly one); false on the default pool is refused', async () => {
      const v = await newVenue('POL2');
      const extra = (
        await t.command('post', `/v1/venues/${v.id}/dispatch-pools`, { as: 'ADM1', body: { name: 'B' } })
      ).body.data;
      const keep = await t.command('patch', `/v1/dispatch-pools/${v.default_dispatch_pool_id}`, {
        as: 'ADM1',
        body: { is_default: false },
      });
      expect(keep.status).toBe(422);
      expect(fields(keep)).toEqual(['is_default:default_required']);

      const move = await t.command('patch', `/v1/dispatch-pools/${extra.id}`, {
        as: 'ADM1',
        body: { is_default: true, name: 'الرئيسية' },
      });
      expect(move.status).toBe(200);
      expect(move.body.data).toMatchObject({ id: extra.id, is_default: true, name: 'الرئيسية' });
      const defaults = await t.db.query(`SELECT id FROM dispatch_pools WHERE venue_id = $1 AND is_default`, [
        v.id,
      ]);
      expect(defaults.rows.map((r) => r.id)).toEqual([extra.id]);
      const venue = await t.get(`/v1/venues/${v.id}`, 'ADM1');
      expect(venue.body.data.default_dispatch_pool_id).toBe(extra.id);
    });

    it('PATCH status=inactive is refused with an open shift or open tasks, allowed otherwise', async () => {
      const shift = await t.command('patch', `/v1/dispatch-pools/${SEED_IDS.pools['POOL-R']}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(shift.status).toBe(409);
      expect(shift.body.error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { entity_type: 'dispatch_pool', reason: 'open_shift' },
      });

      const v = await newVenue('POL3');
      const pool = (
        await t.command('post', `/v1/venues/${v.id}/dispatch-pools`, { as: 'ADM1', body: { name: 'مهام' } })
      ).body.data;
      const event = await t.db.query(
        `INSERT INTO events (org_id, venue_id, dispatch_pool_id, name_ar, event_date, status, created_by)
         VALUES ($1, $2, $3, 'حفل', '2026-10-28', 'open', $4) RETURNING id`,
        [SEED_IDS.org, v.id, pool.id, SEED_IDS.users.ADM1],
      );
      const ticketId = await insertTicket(t.db, {
        eventId: event.rows[0].id,
        venueId: v.id,
        poolId: pool.id,
        displayNumber: 1,
        status: 'parking',
        createdBy: SEED_IDS.users.DRV1,
      });
      await insertTask(t.db, {
        ticketId,
        eventId: event.rows[0].id,
        venueId: v.id,
        poolId: pool.id,
        type: 'park',
        status: 'in_progress',
        assigneeId: SEED_IDS.users.DRV1,
      });
      const tasks = await t.command('patch', `/v1/dispatch-pools/${pool.id}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(tasks.status).toBe(409);
      expect(tasks.body.error.details).toMatchObject({ reason: 'open_tasks' });

      const free = (
        await t.command('post', `/v1/venues/${v.id}/dispatch-pools`, { as: 'ADM1', body: { name: 'فارغة' } })
      ).body.data;
      const off = await t.command('patch', `/v1/dispatch-pools/${free.id}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(off.status).toBe(200);
      expect(off.body.data.status).toBe('inactive');
    });
  });

  describe('parking zones and spots', () => {
    it('zones: create, list by sort order, rename; a duplicate name in the venue is rejected (AC3)', async () => {
      const v = await newVenue('ZON1');
      const a = await t.command('post', `/v1/venues/${v.id}/parking-zones`, {
        as: 'ADM1',
        body: { name: 'القبو', sort_order: 2 },
      });
      const b = await t.command('post', `/v1/venues/${v.id}/parking-zones`, {
        as: 'ADM1',
        body: { name: 'الساحة' },
      });
      expect(a.status).toBe(201);
      expect(b.body.data).toMatchObject({ venue_id: v.id, name: 'الساحة', sort_order: 0, status: 'active' });
      const dup = await t.command('post', `/v1/venues/${v.id}/parking-zones`, {
        as: 'ADM1',
        body: { name: 'القبو' },
      });
      expect(dup.status).toBe(422);
      expect(fields(dup)).toEqual(['name:duplicate']);
      const list = await t.get(`/v1/venues/${v.id}/parking-zones`, 'ADM1');
      expect(list.body.data.map((z: { name: string }) => z.name)).toEqual(['الساحة', 'القبو']);
      const rename = await t.command('patch', `/v1/parking-zones/${a.body.data.id}`, {
        as: 'ADM1',
        body: { name: 'الساحة' },
      });
      expect(rename.status).toBe(422);
      expect(fields(rename)).toEqual(['name:duplicate']);
      const ok = await t.command('patch', `/v1/parking-zones/${a.body.data.id}`, {
        as: 'ADM1',
        body: { name: 'القبو B', sort_order: 0, status: 'inactive' },
      });
      expect(ok.body.data).toMatchObject({ name: 'القبو B', sort_order: 0, status: 'inactive' });
    });

    it('bulk creation from labels or a range (zero-padded with a prefix), returned in natural order', async () => {
      const v = await newVenue('SPT1');
      const zone = (
        await t.command('post', `/v1/venues/${v.id}/parking-zones`, { as: 'ADM1', body: { name: 'A' } })
      ).body.data;
      const range = await t.command('post', `/v1/venues/${v.id}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zone.id, range: { prefix: 'A-', from: 1, to: 12 } },
      });
      expect(range.status).toBe(201);
      expect(range.body.data.map((s: { label: string }) => s.label)).toEqual([
        'A-01',
        'A-02',
        'A-03',
        'A-04',
        'A-05',
        'A-06',
        'A-07',
        'A-08',
        'A-09',
        'A-10',
        'A-11',
        'A-12',
      ]);
      expect(range.body.data[0]).toMatchObject({
        venue_id: v.id,
        zone_id: zone.id,
        zone_name: 'A',
        status: 'active',
        occupied: false,
      });
      const labels = await t.command('post', `/v1/venues/${v.id}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zone.id, labels: [' VIP-2 ', 'VIP-10', 'VIP-1'] },
      });
      expect(labels.status).toBe(201);
      expect(labels.body.data.map((s: { label: string }) => s.label)).toEqual(['VIP-1', 'VIP-2', 'VIP-10']);

      const board = (
        await t.command('post', `/v1/venues/${v.id}/key-boards`, { as: 'ADM1', body: { name: 'اللوحة' } })
      ).body.data;
      const slots = await t.command('post', `/v1/key-boards/${board.id}/slots`, {
        as: 'ADM1',
        body: { range: { from: 8, to: 11 } },
      });
      expect(slots.status).toBe(201);
      expect(slots.body.data.map((s: { label: string }) => s.label)).toEqual(['8', '9', '10', '11']);
      expect(slots.body.data[0]).toMatchObject({
        key_board_id: board.id,
        board_name: 'اللوحة',
        occupied: false,
      });
      const audit = await auditRows(t.db, zone.id);
      expect(audit.map((a) => (a.metadata as { bulk?: string }).bulk).filter(Boolean)).toEqual([
        'parking_spots',
        'parking_spots',
      ]);
    });

    it('duplicate labels in the request or in the zone are VALIDATION_FAILED with their indexes (AC3)', async () => {
      const zoneA = SEED_IDS.zones.RMS.A;
      const inRequest = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, labels: ['Z-1', 'Z-2', 'Z-1', 'Z-2'] },
      });
      expect(inRequest.status).toBe(422);
      expect(inRequest.body.error.details.fields).toEqual([
        expect.objectContaining({ field: 'labels.2', issue: 'duplicate', index: 2, label: 'Z-1' }),
        expect.objectContaining({ field: 'labels.3', issue: 'duplicate', index: 3, label: 'Z-2' }),
      ]);
      const existing = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, labels: ['A-31', 'A-07'] },
      });
      expect(existing.status).toBe(422);
      expect(existing.body.error.details.fields).toEqual([
        expect.objectContaining({ field: 'labels.1', issue: 'duplicate', index: 1, label: 'A-07' }),
      ]);
      const fromRange = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, range: { prefix: 'A-', from: 29, to: 31 } },
      });
      expect(fromRange.body.error.details.fields.map((f: { label: string }) => f.label)).toEqual([
        'A-29',
        'A-30',
      ]);
      const n = await t.db.query(`SELECT count(*)::int AS n FROM parking_spots WHERE zone_id = $1`, [zoneA]);
      expect(n.rows[0].n).toBe(30);

      // the same label in another zone of the venue is fine (unique per zone)
      const otherZone = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: SEED_IDS.zones.RMS.B, labels: ['A-07'] },
      });
      expect(otherZone.status).toBe(201);
      const slotDup = await t.command('post', `/v1/key-boards/${SEED_IDS.keyBoards.RMS}/slots`, {
        as: 'ADM1',
        body: { labels: ['61', '12'] },
      });
      expect(slotDup.status).toBe(422);
      expect(slotDup.body.error.details.fields).toEqual([
        expect.objectContaining({ field: 'labels.1', issue: 'duplicate', label: '12' }),
      ]);
    });

    it('labels and range together or neither, a reversed or oversized range, a foreign zone → rejected', async () => {
      const zoneA = SEED_IDS.zones.RMS.A;
      const both = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, labels: ['Q1'], range: { from: 1, to: 2 } },
      });
      expect(fields(both)).toEqual(['range:labels_or_range']);
      const none = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA },
      });
      expect(fields(none)).toEqual(['labels:labels_or_range']);
      const reversed = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, range: { from: 9, to: 2 } },
      });
      expect(fields(reversed)).toEqual(['range.to:before_from']);
      const huge = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, range: { prefix: 'H-', from: 1, to: 501 } },
      });
      expect(fields(huge)).toEqual(['range:too_many']);
      const empty = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zoneA, labels: [] },
      });
      expect(fields(empty)).toEqual(['labels:required']);
      const foreign = await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: SEED_IDS.zones.LYL.P1, labels: ['X-1'] },
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        details: { resource: 'parking_zone' },
      });
    });

    it('GET parking-spots shows occupancy without the occupying ticket, filters active/available and pages', async () => {
      await parkTicket(t.db, {
        displayNumber: 501,
        spotId: seedSpotId('B-05'),
        keySlotId: seedKeySlotId('RMS', 45),
        by: SEED_IDS.users.DRV1,
      });
      const zoneB = SEED_IDS.zones.RMS.B;
      const all = await t.get(`/v1/venues/${RMS}/parking-spots?zone_id=${zoneB}&limit=200`, 'SUP-R');
      expect(all.status).toBe(200);
      const b05 = all.body.data.find((s: { label: string }) => s.label === 'B-05');
      expect(b05).toEqual({
        id: seedSpotId('B-05'),
        venue_id: RMS,
        zone_id: zoneB,
        zone_name: 'B',
        label: 'B-05',
        status: 'active',
        occupied: true,
      });
      expect(all.body.data.filter((s: { occupied: boolean }) => s.occupied)).toHaveLength(1);

      const available = await t.get(
        `/v1/venues/${RMS}/parking-spots?zone_id=${zoneB}&available_only=true&limit=200`,
        'SUP-R',
      );
      expect(available.body.data.map((s: { label: string }) => s.label)).not.toContain('B-05');
      expect(available.body.data.every((s: { occupied: boolean }) => !s.occupied)).toBe(true);

      // pages of 25 over zone A then B (natural order), no duplicates, then the end
      const seen: string[] = [];
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          body: { data: { id: string; label: string }[]; meta: { next_cursor: string | null } };
        } = await t.get(
          `/v1/venues/${RMS}/parking-spots?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'SUP-R',
        );
        expect(page.body.data.length).toBeLessThanOrEqual(25);
        seen.push(...page.body.data.map((s) => s.label));
        ids.push(...page.body.data.map((s) => s.id));
        cursor = page.body.meta.next_cursor;
      } while (cursor);
      expect(new Set(ids).size).toBe(ids.length);
      expect(seen.slice(0, 3)).toEqual(['A-01', 'A-02', 'A-03']);
      expect(seen.indexOf('A-30')).toBeLessThan(seen.indexOf('B-01'));
      const total = await t.db.query(`SELECT count(*)::int AS n FROM parking_spots WHERE venue_id = $1`, [
        RMS,
      ]);
      expect(seen).toHaveLength(total.rows[0].n);

      const first = await t.get(`/v1/venues/${RMS}/parking-spots?limit=5`, 'SUP-R');
      const otherVenueCursor = await t.get(
        `/v1/venues/${RMS}/parking-spots?limit=5&zone_id=${zoneB}&cursor=${encodeURIComponent(first.body.meta.next_cursor)}`,
        'SUP-R',
      );
      expect(otherVenueCursor.status).toBe(400);
      expect(otherVenueCursor.body.error.code).toBe('PAGINATION_CURSOR_INVALID');
    });

    it('PATCH parking-spots: an occupied spot cannot be deactivated (PARKING_SPOT_OCCUPIED); a free one can; labels stay unique', async () => {
      await parkTicket(t.db, {
        displayNumber: 502,
        spotId: seedSpotId('B-06'),
        keySlotId: seedKeySlotId('RMS', 46),
        by: SEED_IDS.users.DRV1,
      });
      const occupied = await t.command('patch', `/v1/parking-spots/${seedSpotId('B-06')}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(occupied.status).toBe(409);
      expect(occupied.body.error).toMatchObject({
        code: 'PARKING_SPOT_OCCUPIED',
        details: { parking_spot_id: seedSpotId('B-06') },
      });
      const free = await t.command('patch', `/v1/parking-spots/${seedSpotId('B-07')}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(free.status).toBe(200);
      expect(free.body.data).toMatchObject({ label: 'B-07', status: 'inactive', occupied: false });
      const dup = await t.command('patch', `/v1/parking-spots/${seedSpotId('B-08')}`, {
        as: 'ADM1',
        body: { label: 'B-09' },
      });
      expect(dup.status).toBe(422);
      expect(fields(dup)).toEqual(['label:duplicate']);
      const renamed = await t.command('patch', `/v1/parking-spots/${seedSpotId('B-06')}`, {
        as: 'ADM1',
        body: { label: 'B-06X' },
      });
      expect(renamed.body.data).toMatchObject({ label: 'B-06X', status: 'active', occupied: true });
    });
  });

  describe('key boards and slots', () => {
    it('GET key-boards returns [{ board, slots }] with occupancy, slots in natural order', async () => {
      await parkTicket(t.db, {
        displayNumber: 503,
        spotId: seedSpotId('A-20'),
        keySlotId: seedKeySlotId('RMS', 9),
        by: SEED_IDS.users.DRV2,
      });
      const r = await t.get(`/v1/venues/${RMS}/key-boards`, 'SUP-R');
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveLength(1);
      const { board, slots } = r.body.data[0];
      expect(board).toEqual({ id: SEED_IDS.keyBoards.RMS, venue_id: RMS, name: 'لوحة 1', status: 'active' });
      expect(slots.slice(0, 11).map((s: { label: string }) => s.label)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
      ]);
      expect(slots.find((s: { label: string }) => s.label === '9')).toEqual({
        id: seedKeySlotId('RMS', 9),
        venue_id: RMS,
        key_board_id: SEED_IDS.keyBoards.RMS,
        board_name: 'لوحة 1',
        label: '9',
        status: 'active',
        occupied: true,
      });
    });

    it('POST key-boards rejects a duplicate board name in the venue (AC3)', async () => {
      const dup = await t.command('post', `/v1/venues/${RMS}/key-boards`, {
        as: 'ADM1',
        body: { name: 'لوحة 1' },
      });
      expect(dup.status).toBe(422);
      expect(fields(dup)).toEqual(['name:duplicate']);
      const other = await t.command('post', `/v1/venues/${RMS}/key-boards`, {
        as: 'ADM1',
        body: { name: 'لوحة 2' },
      });
      expect(other.status).toBe(201);
      expect(other.body.data).toMatchObject({ venue_id: RMS, name: 'لوحة 2', status: 'active' });
    });

    it('PATCH key-slots: a slot holding a key cannot be deactivated (KEY_SLOT_OCCUPIED); a free one can', async () => {
      await parkTicket(t.db, {
        displayNumber: 504,
        spotId: seedSpotId('A-21'),
        keySlotId: seedKeySlotId('RMS', 10),
        by: SEED_IDS.users.DRV2,
      });
      const occupied = await t.command('patch', `/v1/key-slots/${seedKeySlotId('RMS', 10)}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(occupied.status).toBe(409);
      expect(occupied.body.error).toMatchObject({
        code: 'KEY_SLOT_OCCUPIED',
        details: { key_slot_id: seedKeySlotId('RMS', 10) },
      });
      const free = await t.command('patch', `/v1/key-slots/${seedKeySlotId('RMS', 11)}`, {
        as: 'ADM1',
        body: { status: 'inactive' },
      });
      expect(free.status).toBe(200);
      expect(free.body.data).toMatchObject({ label: '11', status: 'inactive', occupied: false });
      const dup = await t.command('patch', `/v1/key-slots/${seedKeySlotId('RMS', 12)}`, {
        as: 'ADM1',
        body: { label: '13' },
      });
      expect(fields(dup)).toEqual(['label:duplicate']);
    });
  });

  describe('driver pick lists (venue.layout_read, DEC-33)', () => {
    it('a driver reads the layout of his assignment venue with occupancy; inactive items never appear (AC4)', async () => {
      // B-07 and RMS slot 11 were deactivated above; deactivate a zone and a board too
      const zone = (
        await t.command('post', `/v1/venues/${RMS}/parking-zones`, { as: 'ADM1', body: { name: 'مؤقت' } })
      ).body.data;
      await t.command('post', `/v1/venues/${RMS}/parking-spots`, {
        as: 'ADM1',
        body: { zone_id: zone.id, labels: ['T-1', 'T-2'] },
      });
      await t.command('patch', `/v1/parking-zones/${zone.id}`, { as: 'ADM1', body: { status: 'inactive' } });
      const board = (
        await t.command('post', `/v1/venues/${RMS}/key-boards`, { as: 'ADM1', body: { name: 'معطلة' } })
      ).body.data;
      await t.command('post', `/v1/key-boards/${board.id}/slots`, { as: 'ADM1', body: { labels: ['K1'] } });
      await t.db.query(`UPDATE key_boards SET status = 'inactive' WHERE id = $1`, [board.id]);

      const zones = await t.get(`/v1/venues/${RMS}/parking-zones`, 'DRV1');
      expect(zones.status).toBe(200);
      expect(zones.body.data.map((z: { name: string }) => z.name)).not.toContain('مؤقت');
      expect(zones.body.data.every((z: { status: string }) => z.status === 'active')).toBe(true);

      const spots = await t.get(`/v1/venues/${RMS}/parking-spots?limit=200`, 'DRV1');
      const labels = spots.body.data.map((s: { label: string }) => s.label);
      expect(labels).not.toContain('B-07');
      expect(labels).not.toContain('T-1');
      expect(spots.body.data.every((s: { status: string }) => s.status === 'active')).toBe(true);
      const occupied = spots.body.data.filter((s: { occupied: boolean }) => s.occupied);
      expect(occupied.length).toBeGreaterThan(0);
      expect(Object.keys(occupied[0]).sort()).toEqual(
        ['id', 'label', 'occupied', 'status', 'venue_id', 'zone_id', 'zone_name'].sort(),
      );

      const boards = await t.get(`/v1/venues/${RMS}/key-boards`, 'DRV1');
      expect(boards.body.data.map((b: { board: { name: string } }) => b.board.name)).not.toContain('معطلة');
      const slotLabels = boards.body.data.flatMap((b: { slots: { label: string }[] }) =>
        b.slots.map((s) => s.label),
      );
      expect(slotLabels).not.toContain('11');
      expect(boards.body.data[0].slots.some((s: { occupied: boolean }) => s.occupied)).toBe(true);

      // staff see everything; active_only gives the same pick list
      const staff = await t.get(`/v1/venues/${RMS}/parking-zones`, 'SUP-R');
      expect(staff.body.data.map((z: { name: string }) => z.name)).toContain('مؤقت');
      const staffPick = await t.get(`/v1/venues/${RMS}/parking-spots?limit=200&active_only=true`, 'SUP-R');
      expect(staffPick.body.data.map((s: { label: string }) => s.label)).toEqual(labels);
    });

    it('a driver is SCOPE_VENUE_DENIED for another venue and ASSIGNMENT_REQUIRED without an active assignment', async () => {
      const other = await t.get(`/v1/venues/${LYL}/parking-spots`, 'DRV1');
      expect(other.status).toBe(403);
      expect(other.body.error).toMatchObject({ code: 'SCOPE_VENUE_DENIED', details: { venue_id: LYL } });
      await endAssignment(t.db, SEED_IDS.users.DRV8);
      for (const path of ['parking-zones', 'parking-spots', 'key-boards']) {
        const r = await t.get(`/v1/venues/${LYL}/${path}`, 'DRV8');
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('ASSIGNMENT_REQUIRED');
      }
      const venues = await t.get('/v1/venues', 'DRV1');
      expect(venues.status).toBe(403);
      expect(venues.body.error).toMatchObject({
        code: 'PERMISSION_DENIED',
        details: { permission: 'venue.read' },
      });
    });
  });
});
