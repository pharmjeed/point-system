/**
 * Auth/me, venues, layout, events, shifts and drivers of the fake backend (07 §2.1, §2.5, §2.6).
 */
import { randomInt } from 'node:crypto';
import { fail, ok, page, uuid, validation } from './http';
import type { FSlot, FSpot, FUser } from './model';
import type { Ctx, FakeServer } from './server';
import {
  assignmentView,
  driverListItem,
  eventView,
  meView,
  openDuty,
  shiftView,
  userView,
  venueView,
} from './views';

type FieldIssue = { field: string; issue: string };

const DEFAULT_SETTINGS = {
  dispatch: {
    single_offer_reminder_s: 15,
    single_offer_ttl_s: 30,
    broadcast_reminder_s: 30,
    unaccepted_escalation_s: 60,
    next_task_wait_alert_s: 300,
    idle_driver_alert: true,
    accept_grace_ms: 1500,
    offline_drivers_last: false,
  },
  intake: { draft_abandoned_alert_min: 10 },
  handover: { code_ttl_min: 30, max_attempts: 5, max_resends: 3 },
  ready: { uncollected_alert_min: 10 },
  inspection: {
    required_photos: ['photo_front', 'photo_rear', 'photo_left', 'photo_right'],
    max_extra_photos: 8,
  },
  link: { qr_ttl_min: 10 },
  parking: { mode: 'mixed' },
  keys: { require_slot: true },
  pricing: { default_mode: 'included', default_fee_halalas: 0, allowed_methods: ['cash', 'pos'] },
};

/** Effective venue settings: stored values over the canon §12 defaults. */
export function effectiveSettings(stored: Record<string, Record<string, unknown>>) {
  const out = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, Record<string, unknown>>;
  for (const [g, values] of Object.entries(stored)) Object.assign((out[g] ??= {}), values);
  return out;
}

/** Saudi mobile in any common form → E.164, else PHONE_INVALID (07 §1.8). */
export function normalizePhone(input: unknown): string {
  const text = String(input ?? '').replace(/[\s-]/g, '');
  const m = /^(?:\+?966|0)?(5\d{8})$/.exec(text);
  if (!m) fail('PHONE_INVALID');
  return `+966${m[1]}`;
}

const reasonOf = (body: any): string => {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) fail('REASON_REQUIRED');
  return reason;
};

export function registerSetupRoutes(s: FakeServer): void {
  const w = () => s.world;

  // ---------------------------------------------------------------- auth & me
  s.on(
    'POST /v1/auth/login',
    (ctx) => {
      const phone = normalizePhoneSoft(ctx.body?.phone);
      const user = w().users.find((u) => u.phone_e164 === phone);
      if (!user || user.secret !== String(ctx.body?.secret ?? '')) fail('AUTH_INVALID_CREDENTIALS');
      if (user.status === 'disabled') fail('AUTH_ACCOUNT_DISABLED');
      ctx.session.userId = user.id;
      return ok({
        mfa_required: false,
        mfa_token: null,
        mfa_setup_required: false,
        must_change_secret: user.must_change_secret,
        me: meView(s, user),
      });
    },
    { public: true },
  );
  s.on('POST /v1/auth/logout', (ctx) => {
    ctx.session.userId = null;
    return ok(undefined, 204);
  });
  s.on('GET /v1/me', (ctx) => ok(meView(s, ctx.user as FUser)));

  // ---------------------------------------------------------------- venues
  s.on('GET /v1/venues', (ctx) => {
    const user = s.need(ctx, 'venue.read');
    const ids = s.venueIdsInScope(user);
    return page(
      w()
        .venues.filter((v) => ids.includes(v.id))
        .map(venueView),
    );
  });
  s.on('POST /v1/venues', (ctx) => {
    s.need(ctx, 'venue.manage');
    const code = String(ctx.body?.code ?? '');
    const name = String(ctx.body?.name_ar ?? '').trim();
    const fields: FieldIssue[] = [];
    if (!/^[A-Z0-9]{2,8}$/.test(code)) fields.push({ field: 'code', issue: 'pattern' });
    if (w().venues.some((v) => v.code === code)) fields.push({ field: 'code', issue: 'duplicate' });
    if (!name) fields.push({ field: 'name_ar', issue: 'required' });
    if (fields.length) validation(fields);
    const id = uuid();
    const poolId = uuid();
    const now = s.now();
    w().venues.push({
      id,
      code,
      name_ar: name,
      name_en: ctx.body?.name_en ?? null,
      address: ctx.body?.address ?? null,
      city: ctx.body?.city ?? null,
      timezone: ctx.body?.timezone ?? 'Asia/Riyadh',
      status: 'active',
      default_dispatch_pool_id: poolId,
      version: 1,
      settings: {},
      settings_version: 1,
      created_at: now,
    });
    w().pools.push({
      id: poolId,
      venue_id: id,
      name: 'الافتراضية',
      is_default: true,
      status: 'active',
      created_at: now,
    });
    return ok(venueView(w().venues.at(-1)!), 201);
  });
  s.on('GET /v1/venues/:venueId', (ctx) => {
    s.need(ctx, 'venue.read');
    return ok(venueView(s.needVenue(ctx, ctx.params.venueId!)));
  });
  s.on('PATCH /v1/venues/:venueId', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    s.checkVersion('venue', v, ctx.body?.expected_version);
    for (const k of ['name_ar', 'name_en', 'address', 'city', 'status'] as const) {
      if (ctx.body && k in ctx.body) (v as unknown as Record<string, unknown>)[k] = ctx.body[k];
    }
    v.version += 1;
    return ok(venueView(v));
  });
  s.on('GET /v1/venues/:venueId/settings', (ctx) => {
    s.need(ctx, 'venue.read');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return ok({ settings: effectiveSettings(v.settings), version: v.settings_version });
  });
  s.on('PUT /v1/venues/:venueId/settings', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    if (ctx.body?.expected_version !== v.settings_version)
      fail('VERSION_CONFLICT', { entity: 'venue_settings', id: v.id, current_version: v.settings_version });
    const next = effectiveSettings(ctx.body?.settings ?? {});
    const d = next.dispatch as Record<string, number>;
    if ((d.single_offer_reminder_s ?? 0) > (d.single_offer_ttl_s ?? 0) - 5)
      validation([{ field: 'dispatch.single_offer_reminder_s', issue: 'max' }]);
    v.settings = next;
    v.settings_version += 1;
    return ok({ settings: next, version: v.settings_version });
  });

  // ---------------------------------------------------------------- dispatch pools
  s.on('GET /v1/venues/:venueId/dispatch-pools', (ctx) => {
    s.need(ctx, 'venue.read');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return ok(w().pools.filter((p) => p.venue_id === v.id));
  });
  s.on('POST /v1/venues/:venueId/dispatch-pools', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    const name = String(ctx.body?.name ?? '').trim();
    if (!name) validation([{ field: 'name', issue: 'required' }]);
    const pool = {
      id: uuid(),
      venue_id: v.id,
      name,
      is_default: false,
      status: 'active' as const,
      created_at: s.now(),
    };
    w().pools.push(pool);
    return ok(pool, 201);
  });
  s.on('PATCH /v1/dispatch-pools/:poolId', (ctx) => {
    s.need(ctx, 'venue.manage');
    const pool = s.needInScope(
      ctx,
      w().pools.find((p) => p.id === ctx.params.poolId),
    );
    if (ctx.body?.status === 'inactive') {
      if (pool.is_default) fail('INVALID_STATE_TRANSITION', { current_status: pool.status });
      if (w().shifts.some((sh) => sh.dispatch_pool_id === pool.id && sh.status === 'open'))
        fail('INVALID_STATE_TRANSITION', { current_status: pool.status });
    }
    if (typeof ctx.body?.name === 'string') pool.name = ctx.body.name;
    if (ctx.body?.status) pool.status = ctx.body.status;
    return ok(pool);
  });

  // ---------------------------------------------------------------- zones and spots
  const spotView = (sp: FSpot) => ({
    id: sp.id,
    venue_id: sp.venue_id,
    zone_id: sp.zone_id,
    zone_name: w().zones.find((z) => z.id === sp.zone_id)?.name,
    label: sp.label,
    status: sp.status,
    occupied: !!sp.ticket_id,
  });
  s.on('GET /v1/venues/:venueId/parking-zones', (ctx) => {
    s.need(ctx, 'venue.layout_read');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return ok(w().zones.filter((z) => z.venue_id === v.id));
  });
  s.on('POST /v1/venues/:venueId/parking-zones', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    const name = String(ctx.body?.name ?? '').trim();
    if (!name) validation([{ field: 'name', issue: 'required' }]);
    const zone = {
      id: uuid(),
      venue_id: v.id,
      name,
      sort_order: Number(ctx.body?.sort_order ?? 0),
      status: 'active' as const,
    };
    w().zones.push(zone);
    return ok(zone, 201);
  });
  s.on('PATCH /v1/parking-zones/:zoneId', (ctx) => {
    s.need(ctx, 'venue.manage');
    const zone = s.needInScope(
      ctx,
      w().zones.find((z) => z.id === ctx.params.zoneId),
    );
    if (typeof ctx.body?.name === 'string') zone.name = ctx.body.name;
    if (ctx.body?.status) zone.status = ctx.body.status;
    return ok(zone);
  });
  s.on('GET /v1/venues/:venueId/parking-spots', (ctx) => {
    s.need(ctx, 'venue.layout_read');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return page(
      w()
        .spots.filter((sp) => sp.venue_id === v.id)
        .map(spotView),
    );
  });
  s.on('POST /v1/venues/:venueId/parking-spots', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    const zone = w().zones.find((z) => z.id === ctx.body?.zone_id && z.venue_id === v.id);
    if (!zone) validation([{ field: 'zone_id', issue: 'unknown' }]);
    const labels = bulkLabels(ctx.body);
    const taken = new Set(
      w()
        .spots.filter((sp) => sp.venue_id === v.id)
        .map((sp) => sp.label),
    );
    if (labels.some((l) => taken.has(l))) validation([{ field: 'labels', issue: 'duplicate' }]);
    const created = labels.map((label) => ({
      id: uuid(),
      venue_id: v.id,
      zone_id: zone.id,
      label,
      status: 'active' as const,
      ticket_id: null,
    }));
    w().spots.push(...created);
    return ok(created.map(spotView), 201);
  });
  s.on('PATCH /v1/parking-spots/:spotId', (ctx) => {
    s.need(ctx, 'venue.manage');
    const spot = s.needInScope(
      ctx,
      w().spots.find((sp) => sp.id === ctx.params.spotId),
    );
    if (ctx.body?.status === 'inactive' && spot.ticket_id)
      fail('PARKING_SPOT_OCCUPIED', { spot_id: spot.id });
    if (typeof ctx.body?.label === 'string') spot.label = ctx.body.label;
    if (ctx.body?.status) spot.status = ctx.body.status;
    return ok(spotView(spot));
  });

  // ---------------------------------------------------------------- key boards and slots
  const slotView = (sl: FSlot) => ({
    id: sl.id,
    venue_id: sl.venue_id,
    key_board_id: sl.key_board_id,
    board_name: w().boards.find((b) => b.id === sl.key_board_id)?.name,
    label: sl.label,
    status: sl.status,
    occupied: !!sl.ticket_id,
  });
  s.on('GET /v1/venues/:venueId/key-boards', (ctx) => {
    s.need(ctx, 'venue.layout_read');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return ok(
      w()
        .boards.filter((b) => b.venue_id === v.id)
        .map((board) => ({
          board,
          slots: w()
            .slots.filter((sl) => sl.key_board_id === board.id)
            .map(slotView),
        })),
    );
  });
  s.on('POST /v1/venues/:venueId/key-boards', (ctx) => {
    s.need(ctx, 'venue.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    const name = String(ctx.body?.name ?? '').trim();
    if (!name) validation([{ field: 'name', issue: 'required' }]);
    const board = { id: uuid(), venue_id: v.id, name, status: 'active' as const };
    w().boards.push(board);
    return ok(board, 201);
  });
  s.on('POST /v1/key-boards/:boardId/slots', (ctx) => {
    s.need(ctx, 'venue.manage');
    const board = s.needInScope(
      ctx,
      w().boards.find((b) => b.id === ctx.params.boardId),
    );
    const labels = bulkLabels(ctx.body);
    const taken = new Set(
      w()
        .slots.filter((sl) => sl.key_board_id === board.id)
        .map((sl) => sl.label),
    );
    if (labels.some((l) => taken.has(l))) validation([{ field: 'labels', issue: 'duplicate' }]);
    const created = labels.map((label) => ({
      id: uuid(),
      venue_id: board.venue_id,
      key_board_id: board.id,
      label,
      status: 'active' as const,
      ticket_id: null,
    }));
    w().slots.push(...created);
    return ok(created.map(slotView), 201);
  });
  s.on('PATCH /v1/key-slots/:slotId', (ctx) => {
    s.need(ctx, 'venue.manage');
    const slot = s.needInScope(
      ctx,
      w().slots.find((sl) => sl.id === ctx.params.slotId),
    );
    if (ctx.body?.status === 'inactive' && slot.ticket_id)
      fail('KEY_SLOT_OCCUPIED', { key_slot_id: slot.id });
    if (typeof ctx.body?.label === 'string') slot.label = ctx.body.label;
    if (ctx.body?.status) slot.status = ctx.body.status;
    return ok(slotView(slot));
  });

  // ---------------------------------------------------------------- events
  const eventIn = (ctx: Ctx) =>
    s.needInScope(
      ctx,
      w().events.find((e) => e.id === ctx.params.eventId),
    );
  const pricingCheck = (mode: unknown, fee: unknown) => {
    if (mode !== 'included' && mode !== 'per_vehicle') validation([{ field: 'pricing_mode', issue: 'enum' }]);
    const n = Number(fee ?? 0);
    if (mode === 'included' && n !== 0) validation([{ field: 'fee_halalas', issue: 'must_be_zero' }]);
    if (mode === 'per_vehicle' && !(n > 0)) validation([{ field: 'fee_halalas', issue: 'must_be_positive' }]);
    return n;
  };
  s.on('GET /v1/venues/:venueId/events', (ctx) => {
    s.need(ctx, 'event.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return page(
      w()
        .events.filter((e) => e.venue_id === v.id)
        .map(eventView),
    );
  });
  s.on('POST /v1/venues/:venueId/events', (ctx) => {
    s.need(ctx, 'event.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    const b = ctx.body ?? {};
    const fields: FieldIssue[] = [];
    if (!String(b.name_ar ?? '').trim()) fields.push({ field: 'name_ar', issue: 'required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date ?? '')))
      fields.push({ field: 'event_date', issue: 'format' });
    if (fields.length) validation(fields);
    const fee = pricingCheck(b.pricing_mode, b.fee_halalas);
    const event = {
      id: uuid(),
      venue_id: v.id,
      dispatch_pool_id: b.dispatch_pool_id ?? v.default_dispatch_pool_id,
      name_ar: String(b.name_ar).trim(),
      host_name: b.host_name ?? null,
      event_date: b.event_date,
      starts_at: b.starts_at ?? null,
      ends_at: b.ends_at ?? null,
      status: 'draft' as const,
      pricing_mode: b.pricing_mode,
      fee_halalas: fee,
      allowed_payment_methods: b.allowed_payment_methods ?? ['cash', 'pos'],
      opened_at: null,
      canceled_at: null,
      cancel_reason: null,
      next_display_number: 1,
      version: 1,
      created_at: s.now(),
    };
    w().events.push(event);
    return ok(eventView(event), 201);
  });
  s.on('GET /v1/events/:eventId', (ctx) => {
    s.need(ctx, 'event.manage');
    return ok(eventView(eventIn(ctx)));
  });
  s.on('PATCH /v1/events/:eventId', (ctx) => {
    s.need(ctx, 'event.manage');
    const e = eventIn(ctx);
    s.checkVersion('event', e, ctx.body?.expected_version);
    if (e.status === 'closed' || e.status === 'canceled') fail('EVENT_ALREADY_CLOSED');
    const b = ctx.body ?? {};
    const hasTickets = w().tickets.some((t) => t.event_id === e.id);
    if (
      hasTickets &&
      (('pricing_mode' in b && b.pricing_mode !== e.pricing_mode) ||
        ('fee_halalas' in b && b.fee_halalas !== e.fee_halalas))
    )
      fail('INVALID_STATE_TRANSITION', { current_status: e.status });
    const mode = b.pricing_mode ?? e.pricing_mode;
    const fee = pricingCheck(
      mode,
      'fee_halalas' in b ? b.fee_halalas : mode === 'included' ? 0 : e.fee_halalas,
    );
    for (const k of [
      'name_ar',
      'host_name',
      'event_date',
      'starts_at',
      'ends_at',
      'dispatch_pool_id',
      'allowed_payment_methods',
    ] as const) {
      if (k in b) (e as unknown as Record<string, unknown>)[k] = b[k];
    }
    e.pricing_mode = mode;
    e.fee_halalas = fee;
    e.version += 1;
    return ok(eventView(e));
  });
  s.on('POST /v1/events/:eventId/open', (ctx) => {
    s.need(ctx, 'event.manage');
    const e = eventIn(ctx);
    s.checkVersion('event', e, ctx.body?.expected_version);
    if (e.status === 'closed' || e.status === 'canceled') fail('EVENT_ALREADY_CLOSED');
    if (e.status !== 'draft')
      fail('INVALID_STATE_TRANSITION', { current_status: e.status, allowed: ['draft'] });
    e.status = 'open';
    e.opened_at = s.now();
    e.version += 1;
    return ok(eventView(e));
  });
  s.on('POST /v1/events/:eventId/cancel', (ctx) => {
    s.need(ctx, 'event.manage');
    const e = eventIn(ctx);
    const reason = reasonOf(ctx.body);
    s.checkVersion('event', e, ctx.body?.expected_version);
    if (e.status === 'closed' || e.status === 'canceled') fail('EVENT_ALREADY_CLOSED');
    if (e.status !== 'draft' && e.status !== 'open')
      fail('INVALID_STATE_TRANSITION', { current_status: e.status });
    const open = w().tickets.filter((t) => t.event_id === e.id && t.status !== 'voided');
    if (open.length) fail('EVENT_CLOSE_BLOCKED', { blockers: { open_tickets: open.map((t) => t.id) } });
    e.status = 'canceled';
    e.canceled_at = s.now();
    e.cancel_reason = reason;
    e.version += 1;
    return ok(eventView(e));
  });

  // ---------------------------------------------------------------- shifts
  const shiftIn = (ctx: Ctx) =>
    s.needInScope(
      ctx,
      w().shifts.find((sh) => sh.id === ctx.params.shiftId),
    );
  s.on('GET /v1/venues/:venueId/shifts', (ctx) => {
    s.need(ctx, 'shift.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    return page(
      w()
        .shifts.filter((sh) => sh.venue_id === v.id)
        .map(shiftView),
    );
  });
  s.on('POST /v1/venues/:venueId/shifts', (ctx) => {
    s.need(ctx, 'shift.manage');
    const v = s.needVenue(ctx, ctx.params.venueId!);
    if (!ctx.body?.starts_at || Number.isNaN(Date.parse(ctx.body.starts_at)))
      validation([{ field: 'starts_at', issue: 'required' }]);
    const shift = {
      id: uuid(),
      venue_id: v.id,
      dispatch_pool_id: ctx.body.dispatch_pool_id ?? v.default_dispatch_pool_id,
      name: ctx.body.name ?? null,
      starts_at: ctx.body.starts_at,
      ends_at: ctx.body.ends_at ?? null,
      status: 'scheduled' as const,
      opened_at: null,
      closed_at: null,
      version: 1,
    };
    w().shifts.push(shift);
    return ok(shiftView(shift), 201);
  });
  s.on('POST /v1/shifts/:shiftId/open', (ctx) => {
    s.need(ctx, 'shift.manage');
    const sh = shiftIn(ctx);
    s.checkVersion('shift', sh, ctx.body?.expected_version);
    if (sh.status !== 'scheduled')
      fail('INVALID_STATE_TRANSITION', { current_status: sh.status, allowed: ['scheduled'] });
    if (w().shifts.some((o) => o.dispatch_pool_id === sh.dispatch_pool_id && o.status === 'open'))
      fail('SHIFT_ALREADY_OPEN');
    sh.status = 'open';
    sh.opened_at = s.now();
    sh.version += 1;
    return ok(shiftView(sh));
  });
  s.on('POST /v1/shifts/:shiftId/close', (ctx) => {
    s.need(ctx, 'shift.manage');
    const sh = shiftIn(ctx);
    s.checkVersion('shift', sh, ctx.body?.expected_version);
    if (sh.status !== 'open')
      fail('INVALID_STATE_TRANSITION', { current_status: sh.status, allowed: ['open'] });
    const duties = w().duties.filter((d) => d.shift_id === sh.id && d.status !== 'ended');
    const blocking = duties
      .map((d) => ({ d, items: s.custodyItems(d.user_id) }))
      .filter((x) => x.items.length > 0);
    if (blocking.length) {
      fail('SHIFT_CLOSE_BLOCKED', {
        blocking_drivers: blocking.map((x) => {
          const u = w().users.find((uu) => uu.id === x.d.user_id);
          return {
            driver: { id: u?.id, full_name: u?.full_name, employee_code: u?.employee_code },
            items: x.items,
          };
        }),
      });
    }
    for (const d of duties) {
      d.status = 'ended';
      d.ended_at = s.now();
      d.end_reason = 'shift_closed';
      d.available_since = null;
      d.version += 1;
    }
    sh.status = 'closed';
    sh.closed_at = s.now();
    sh.version += 1;
    return ok(shiftView(sh));
  });

  // ---------------------------------------------------------------- drivers
  const driverIn = (ctx: Ctx): FUser => {
    const viewer = ctx.user as FUser;
    const d = w().users.find((u) => u.id === ctx.params.driverId && u.role === 'driver');
    if (!d) fail('RESOURCE_NOT_FOUND');
    const a = s.activeAssignment(d.id);
    const visible = viewer.scopes.includes('org') || (a ? s.inScope(viewer, a.venue_id) : false);
    if (!visible) fail('SCOPE_VENUE_DENIED'); // DEC-77
    return d;
  };
  s.on('GET /v1/drivers', (ctx) => {
    const viewer = s.need(ctx, 'driver.read');
    const venueId = ctx.query.get('venue_id');
    if (venueId) s.needVenue(ctx, venueId);
    const list = w()
      .users.filter((u) => u.role === 'driver')
      .filter((u) => {
        const a = s.activeAssignment(u.id);
        if (venueId) return a?.venue_id === venueId;
        return viewer.scopes.includes('org') || (a ? s.inScope(viewer, a.venue_id) : false);
      });
    return page(list.map((u) => driverListItem(s, u, viewer)));
  });
  s.on('POST /v1/drivers', (ctx) => {
    const viewer = s.need(ctx, 'driver.manage');
    const name = String(ctx.body?.full_name ?? '').trim();
    if (!name) validation([{ field: 'full_name', issue: 'required' }]);
    const phone = normalizePhone(ctx.body?.phone);
    if (w().users.some((u) => u.phone_e164 === phone)) validation([{ field: 'phone', issue: 'duplicate' }]);
    const code =
      String(ctx.body?.employee_code ?? '').trim() ||
      `D-${String(w().users.filter((u) => u.role === 'driver').length + 1).padStart(4, '0')}`;
    if (w().users.some((u) => u.employee_code === code))
      validation([{ field: 'employee_code', issue: 'duplicate' }]);
    const secret = String(randomInt(100000, 999999));
    const user: FUser = {
      id: uuid(),
      role: 'driver',
      employee_code: code,
      full_name: name,
      phone_e164: phone,
      secret,
      can_drive: false,
      status: 'active',
      must_change_secret: true,
      disabled_reason: null,
      disabled_at: null,
      scopes: [],
      version: 1,
      created_at: s.now(),
    };
    w().users.push(user);
    let assignment = null;
    if (ctx.body?.initial_venue_id) {
      s.needVenue(ctx, ctx.body.initial_venue_id);
      const a = {
        id: uuid(),
        driver_id: user.id,
        venue_id: ctx.body.initial_venue_id,
        status: 'active' as const,
        starts_at: s.now(),
        ends_at: null,
        reason: null,
      };
      w().assignments.push(a);
      assignment = assignmentView(s, a);
    }
    return ok({ driver: userView(user, viewer), temporary_secret: secret, assignment }, 201);
  });
  s.on('GET /v1/drivers/:driverId', (ctx) => {
    const viewer = s.need(ctx, 'driver.read');
    return ok(driverListItem(s, driverIn(ctx), viewer));
  });
  s.on('PATCH /v1/drivers/:driverId', (ctx) => {
    const viewer = s.need(ctx, 'driver.manage');
    const d = driverIn(ctx);
    s.checkVersion('user', d, ctx.body?.expected_version);
    if (typeof ctx.body?.full_name === 'string') d.full_name = ctx.body.full_name;
    if (ctx.body?.phone !== undefined) d.phone_e164 = normalizePhone(ctx.body.phone);
    if (typeof ctx.body?.employee_code === 'string') d.employee_code = ctx.body.employee_code;
    d.version += 1;
    return ok(userView(d, viewer));
  });
  s.on('POST /v1/drivers/:driverId/disable', (ctx) => {
    const viewer = s.need(ctx, 'driver.manage');
    const d = driverIn(ctx);
    const reason = reasonOf(ctx.body);
    if (d.status === 'disabled') fail('INVALID_STATE_TRANSITION', { current_status: 'disabled' });
    const items = s.custodyItems(d.id).filter((i) => i.type !== 'next_task');
    if (items.length) fail('CUSTODY_OPEN', { items });
    d.status = 'disabled';
    d.disabled_reason = reason;
    d.disabled_at = s.now();
    d.version += 1;
    const duty = openDuty(s, d.id);
    if (duty) {
      duty.status = 'ended';
      duty.end_reason = 'disabled';
      duty.ended_at = s.now();
    }
    return ok(userView(d, viewer));
  });
  s.on('POST /v1/drivers/:driverId/enable', (ctx) => {
    const viewer = s.need(ctx, 'driver.manage');
    const d = driverIn(ctx);
    if (d.status === 'active') fail('INVALID_STATE_TRANSITION', { current_status: 'active' });
    d.status = 'active';
    d.disabled_reason = null;
    d.disabled_at = null;
    d.version += 1;
    return ok(userView(d, viewer));
  });
  s.on('POST /v1/drivers/:driverId/reset-secret', (ctx) => {
    s.need(ctx, 'driver.manage');
    const d = driverIn(ctx);
    if (d.status === 'disabled') fail('DRIVER_DISABLED');
    d.secret = String(randomInt(100000, 999999));
    d.must_change_secret = true;
    d.version += 1;
    return ok({ temporary_secret: d.secret });
  });
  s.on('GET /v1/drivers/:driverId/assignments', (ctx) => {
    s.need(ctx, 'driver.read');
    const d = driverIn(ctx);
    return ok({
      assignments: w()
        .assignments.filter((a) => a.driver_id === d.id)
        .map((a) => assignmentView(s, a)),
      transfers: [],
    });
  });
  s.on('POST /v1/drivers/:driverId/assignments', (ctx) => {
    s.need(ctx, 'driver.assign');
    const d = w().users.find((u) => u.id === ctx.params.driverId && u.role === 'driver');
    if (!d) fail('RESOURCE_NOT_FOUND');
    const venueId = String(ctx.body?.venue_id ?? '');
    s.needVenue(ctx, venueId);
    if (d.status === 'disabled') fail('DRIVER_DISABLED');
    const current = s.activeAssignment(d.id);
    if (current)
      fail('ASSIGNMENT_CONFLICT', { active_assignment_id: current.id, venue_id: current.venue_id });
    const a = {
      id: uuid(),
      driver_id: d.id,
      venue_id: venueId,
      status: 'active' as const,
      starts_at: s.now(),
      ends_at: null,
      reason: ctx.body?.reason ?? null,
    };
    w().assignments.push(a);
    return ok(assignmentView(s, a), 201);
  });
}

/** Login accepts any Saudi form; an invalid phone simply matches no account. */
function normalizePhoneSoft(input: unknown): string | null {
  const m = /^(?:\+?966|0)?(5\d{8})$/.exec(String(input ?? '').replace(/[\s-]/g, ''));
  return m ? `+966${m[1]}` : null;
}

/** `labels` or `range` (07: one of them; at most 500 labels). Spots are zero-padded like «A-01». */
function bulkLabels(body: any): string[] {
  if (Array.isArray(body?.labels)) return body.labels.map(String);
  const r = body?.range;
  if (!r || !Number.isInteger(r.from) || !Number.isInteger(r.to) || r.to < r.from || r.to - r.from + 1 > 500)
    validation([{ field: 'range', issue: 'invalid' }]);
  const prefix = typeof r.prefix === 'string' ? r.prefix : '';
  const width = prefix ? Math.max(2, String(r.to).length) : 0;
  const out: string[] = [];
  for (let n = r.from; n <= r.to; n += 1) out.push(`${prefix}${width ? String(n).padStart(width, '0') : n}`);
  return out;
}
