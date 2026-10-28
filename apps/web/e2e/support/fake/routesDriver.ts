/**
 * The driver's field routes of the fake backend (07 §2.1–§2.3): home, duty, device checks, intake, photos
 * (with a fake presigned object storage), parking, a small dispatch engine (oldest request first, single
 * offer to the longest-idle available driver, broadcast when nobody is free, first accept wins, one
 * reserved next task), retrieval steps and handover. Errors are the 07/08 codes with their 08 texts.
 * Test code only — the real rules live in packages/server (S2) and are checked there.
 */
import { randomInt } from 'node:crypto';
import { fail, ok, uuid, validation, type Reply } from './http';
import type { FCycle, FMedia, FOffer, FTask, FTicket, FUser } from './model';
import { effectiveSettings, normalizePhone } from './routesSetup';
import { STORAGE_PREFIX, type Ctx, type FakeServer } from './server';
import { assignmentView, driverState, dutyView, openDuty, userRef } from './views';

/** 07 §1.8: the 17 plate letters on the wire («ه», not the display form «هـ») and their Latin pairs. */
const PLATE_EN: Record<string, string> = {
  ا: 'A',
  ب: 'B',
  ح: 'J',
  د: 'D',
  ر: 'R',
  س: 'S',
  ص: 'X',
  ط: 'T',
  ع: 'E',
  ق: 'G',
  ك: 'K',
  ل: 'L',
  م: 'Z',
  ن: 'N',
  ه: 'H',
  و: 'U',
  ى: 'V',
};
const MEDIA_TYPES = ['image/jpeg', 'image/webp', 'image/heic', 'image/png'];
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const isOpen = (t: FTicket) => t.status !== 'delivered' && t.status !== 'voided';
const byPriority = (a: FTask, b: FTask) => a.priority_at.localeCompare(b.priority_at) || a.seq - b.seq;

export function registerDriverRoutes(s: FakeServer): void {
  const w = () => s.world;
  const now = () => s.now();
  const user = (id: string | null | undefined) => w().users.find((u) => u.id === id);
  const venueOf = (id: string) => w().venues.find((v) => v.id === id);
  const settingsOf = (venueId: string) => effectiveSettings(venueOf(venueId)?.settings ?? {});
  const eventOf = (id: string) => w().events.find((e) => e.id === id);
  const openCycle = (t: FTicket) => w().cycles.find((c) => c.ticket_id === t.id && !c.closed_at) ?? null;
  const openTask = (t: FTicket) =>
    w().tasks.find((k) => k.ticket_id === t.id && !['completed', 'canceled'].includes(k.status)) ?? null;
  const custody = (
    t: FTicket,
    subject: 'vehicle' | 'key',
    to: { type: string; id: string | null },
    reason: string,
    actor: FUser,
    task: FTask | null,
  ) => {
    const holder = subject === 'vehicle' ? 'vehicle_holder' : 'key_holder';
    w().custody.push({
      ticket_id: t.id,
      subject,
      from: { ...t[holder] },
      to,
      reason,
      actor_id: actor.id,
      task_id: task?.id ?? null,
      occurred_at: now(),
    });
    t[holder] = { ...to };
  };

  // ---------------------------------------------------------------- views (07_openapi.yaml)

  const holderView = (h: { type: string; id: string | null }) => ({
    type: h.type,
    id: h.id,
    label:
      h.type === 'driver'
        ? (user(h.id)?.full_name ?? null)
        : h.type === 'spot'
          ? (w().spots.find((x) => x.id === h.id)?.label ?? null)
          : h.type === 'key_slot'
            ? (w().slots.find((x) => x.id === h.id)?.label ?? null)
            : null,
  });
  const plateView = (t: FTicket) => ({
    country: t.plate_country,
    digits: t.plate_digits,
    letters_ar: t.plate_letters_ar,
    letters_en: t.plate_letters_en,
    raw: t.plate_raw,
    display: t.plate_raw ?? [t.plate_digits, t.plate_letters_ar].filter(Boolean).join(' '),
  });
  const taskView = (k: FTask) => ({
    id: k.id,
    ticket_id: k.ticket_id,
    cycle_id: k.cycle_id,
    event_id: k.event_id,
    venue_id: k.venue_id,
    dispatch_pool_id: k.dispatch_pool_id,
    type: k.type,
    status: k.status,
    priority_at: k.priority_at,
    seq: k.seq,
    assignee: userRef(user(k.assignee_id)),
    claimed_at: k.claimed_at,
    accepted_at: k.accepted_at,
    key_picked_up_at: k.key_picked_up_at,
    started_at: k.started_at,
    completed_at: k.completed_at,
    canceled_at: k.canceled_at,
    cancel_reason: k.cancel_reason,
    version: k.version,
  });
  const cycleView = (c: FCycle | null) =>
    c
      ? {
          id: c.id,
          ticket_id: c.ticket_id,
          cycle_no: c.cycle_no,
          requested_at: c.requested_at,
          request_source: c.request_source,
          requested_early: false,
          accepted_by: c.accepted_by,
          started_at: c.started_at,
          ready_at: c.ready_at,
          delivered_at: c.delivered_at,
          retrieved_by: c.retrieved_by,
          delivered_by: c.delivered_by,
          outcome: c.outcome,
          closed_at: c.closed_at,
        }
      : null;
  const claimView = (t: FTicket) =>
    t.claim
      ? {
          issued_at: t.claim.issued_at,
          expires_at: t.claim.expires_at,
          attempts: t.claim.attempts,
          max_attempts: t.claim.max_attempts,
          attempts_left: Math.max(0, t.claim.max_attempts - t.claim.attempts),
          locked_at: t.claim.locked_at,
          consumed_at: t.claim.consumed_at,
          revoked_at: null,
          resend_no: t.claim.resend_no,
          resends_left: Math.max(0, t.claim.max_resends - t.claim.resend_no),
          sent_status: 'sent',
        }
      : null;
  const mediaView = (m: FMedia) => ({
    id: m.id,
    ticket_id: m.ticket_id,
    kind: m.kind,
    content_type: m.content_type,
    byte_size: m.byte_size,
    upload_status: m.upload_status,
    captured_at: m.captured_at,
    uploaded_at: m.uploaded_at,
    uploaded_by: m.uploaded_by,
  });
  const paymentView = (t: FTicket) => {
    const p = w().payments.find((x) => x.ticket_id === t.id);
    return p
      ? {
          id: p.id,
          ticket_id: p.ticket_id,
          method: p.method,
          amount_halalas: p.amount_halalas,
          currency: 'SAR',
          pos_reference: p.pos_reference,
          collected_by: userRef(user(p.collected_by)),
          collected_at: p.collected_at,
          status: 'recorded',
        }
      : null;
  };
  const ticketSummary = (t: FTicket) => ({
    id: t.id,
    display_number: t.display_number,
    event_id: t.event_id,
    event_name_ar: eventOf(t.event_id)?.name_ar,
    venue_id: t.venue_id,
    venue_name_ar: venueOf(t.venue_id)?.name_ar,
    status: t.status,
    channel: t.channel,
    plate: plateView(t),
    vehicle: { make: t.vehicle_make, color: t.vehicle_color },
    wa_link_status: t.wa_link_status,
    payment_status: t.payment_status,
    requested_at: openCycle(t)?.requested_at ?? null,
    created_at: t.created_at,
    version: t.version,
  });
  /** 07 §1.10: full for the creator during intake, the assignee of an open task, and staff. */
  const fullFor = (t: FTicket, viewer: FUser | null) => {
    if (!viewer) return false;
    if (viewer.role !== 'driver') return true;
    if (t.created_by === viewer.id && (t.status === 'received' || t.status === 'parking')) return true;
    return w().tasks.some(
      (k) =>
        k.ticket_id === t.id && k.assignee_id === viewer.id && !['completed', 'canceled'].includes(k.status),
    );
  };
  const ticketDetail = (t: FTicket, viewer: FUser | null) => {
    const base = ticketSummary(t);
    if (!fullFor(t, viewer)) return { ...base, projection: 'minimal' };
    const spot = w().spots.find((x) => x.id === t.spot_id);
    const slot = w().slots.find((x) => x.id === t.key_slot_id);
    const task = openTask(t);
    return {
      ...base,
      projection: 'full',
      vehicle_detail: { make: t.vehicle_make, model: t.vehicle_model, color: t.vehicle_color, type: null },
      customer: t.customer_phone
        ? { phone_masked: `05•••••${t.customer_phone.slice(-3)}`, consent: null, opted_out: false }
        : null,
      wa_link_pending: null,
      paper_serial: t.paper_serial,
      key_tag: t.key_tag,
      inspection_status: t.inspection_status,
      damage_marks: [],
      notes: t.notes,
      current_spot: spot
        ? {
            id: spot.id,
            label: spot.label,
            zone_name: w().zones.find((z) => z.id === spot.zone_id)?.name ?? '',
          }
        : null,
      current_spot_note: t.spot_note,
      current_key_slot: slot
        ? {
            id: slot.id,
            label: slot.label,
            board_name: w().boards.find((b) => b.id === slot.key_board_id)?.name ?? '',
          }
        : null,
      vehicle_holder: holderView(t.vehicle_holder),
      key_holder: holderView(t.key_holder),
      pending_retrieval_at: t.pending_retrieval_at,
      active_cycle: cycleView(openCycle(t)),
      open_task: task ? taskView(task) : null,
      fee_halalas: t.fee_halalas,
      payment: paymentView(t),
      payment_waiver_reason: null,
      claim_code: claimView(t),
      media: w()
        .media.filter((m) => m.ticket_id === t.id && m.upload_status !== 'deleted')
        .map(mediaView),
      created_by: userRef(user(t.created_by)),
      parked_by: userRef(user(t.parked_by)),
      retrieved_by: userRef(user(t.retrieved_by)),
      delivered_by: userRef(user(t.delivered_by)),
      submitted_at: t.submitted_at,
      parked_at: t.parked_at,
      delivered_at: t.delivered_at,
      voided_at: t.voided_at,
      void_reason: t.void_reason,
    };
  };
  const taskCard = (k: FTask, viewer: FUser) => {
    const t = w().tickets.find((x) => x.id === k.ticket_id) as FTicket;
    const mine = k.assignee_id === viewer.id;
    const spot = w().spots.find((x) => x.id === t.spot_id);
    const slot = w().slots.find((x) => x.id === t.key_slot_id);
    const cycle = openCycle(t);
    const event = eventOf(t.event_id);
    return {
      task: taskView(k),
      ticket: {
        id: t.id,
        display_number: t.display_number,
        event_name_ar: event?.name_ar,
        plate: plateView(t),
        vehicle: { make: t.vehicle_make, model: t.vehicle_model, color: t.vehicle_color, type: null },
        status: t.status,
        version: t.version,
      },
      parking: mine
        ? {
            spot_label: spot?.label ?? null,
            zone_name: spot ? (w().zones.find((z) => z.id === spot.zone_id)?.name ?? null) : null,
            spot_note: t.spot_note,
          }
        : null,
      key_slot:
        mine && slot
          ? {
              id: slot.id,
              label: slot.label,
              board_name: w().boards.find((b) => b.id === slot.key_board_id)?.name ?? '',
            }
          : null,
      requested_at: cycle?.requested_at ?? null,
      waiting_seconds: cycle ? Math.round((Date.now() - Date.parse(cycle.requested_at)) / 1000) : null,
      payment_due:
        t.payment_status === 'due'
          ? {
              amount_halalas: t.fee_halalas,
              allowed_methods: event?.allowed_payment_methods ?? ['cash', 'pos'],
            }
          : null,
      claim_code: claimView(t),
    };
  };

  // ---------------------------------------------------------------- dispatch (10, simplified)

  const dutyPool = (userId: string) => openDuty(s, userId)?.dispatch_pool_id ?? null;
  type Eligibility = 'accept' | 'reserve_next' | 'view_only' | null;
  const eligibility = (userId: string): Eligibility => {
    const state = driverState(s, userId);
    if (state === 'available') return 'accept';
    if (state === 'intake_parking' || state === 'retrieving') return 'reserve_next';
    if (state === 'busy_with_next') return 'view_only';
    return null;
  };
  const liveSingleOffer = (userId: string) =>
    w().offers.find((o) => o.status === 'active' && o.mode === 'single' && o.recipients.includes(userId));
  const offerTo = (task: FTask, mode: 'single' | 'broadcast', recipients: string[]) => {
    const ttl = Number(settingsOf(task.venue_id).dispatch?.single_offer_ttl_s ?? 30);
    const offer: FOffer = {
      id: uuid(),
      task_id: task.id,
      mode,
      status: 'active',
      recipients,
      created_at: now(),
      expires_at: mode === 'single' ? new Date(Date.now() + ttl * 1000).toISOString() : null,
      accepted_by: null,
      close_reason: null,
      version: 1,
    };
    w().offers.push(offer);
    task.status = mode === 'single' ? 'offered' : 'broadcast';
    if (mode === 'single') task.offered_to.push(...recipients);
    task.version += 1;
  };
  /** Offers expire lazily (no timers in the fake): past `expires_at` + grace the task re-enters the pass. */
  const expireOffers = () => {
    for (const o of w().offers) {
      if (o.status !== 'active' || o.mode !== 'single' || !o.expires_at) continue;
      const task = w().tasks.find((k) => k.id === o.task_id) as FTask;
      const grace = Number(settingsOf(task.venue_id).dispatch?.accept_grace_ms ?? 1500);
      if (Date.now() <= Date.parse(o.expires_at) + grace) continue;
      o.status = 'expired';
      o.close_reason = 'expired';
      if (task.status === 'offered') {
        task.status = 'queued';
        task.version += 1;
      }
    }
  };
  const pass = (poolId: string) => {
    expireOffers();
    const queued = w()
      .tasks.filter((k) => k.dispatch_pool_id === poolId && k.type === 'retrieve' && k.status === 'queued')
      .sort(byPriority);
    for (const task of queued) {
      // longest-idle available driver first (canon §2 rule 6); one live single offer per driver
      const free = w()
        .duties.filter((d) => d.status === 'on_duty' && d.dispatch_pool_id === poolId)
        .filter((d) => driverState(s, d.user_id) === 'available' && !liveSingleOffer(d.user_id))
        .filter((d) => !task.offered_to.includes(d.user_id))
        .sort((a, b) => (a.available_since ?? '').localeCompare(b.available_since ?? ''));
      const first = free[0];
      if (first) offerTo(task, 'single', [first.user_id]);
      else offerTo(task, 'broadcast', []);
    }
  };
  const tick = () => {
    expireOffers();
    for (const poolId of new Set(
      w()
        .tasks.filter((k) => k.status === 'queued')
        .map((k) => k.dispatch_pool_id),
    ))
      pass(poolId);
  };
  /** Live offers this driver may act on, oldest request first (02 D-04 shows the first one only). */
  const visibleOffers = (viewer: FUser) => {
    const pool = dutyPool(viewer.id);
    if (!pool || !eligibility(viewer.id)) return [];
    return w()
      .offers.filter((o) => o.status === 'active')
      .filter((o) => (o.mode === 'single' ? o.recipients.includes(viewer.id) : true))
      .map((o) => ({ o, task: w().tasks.find((k) => k.id === o.task_id) as FTask }))
      .filter(
        ({ task }) =>
          task.dispatch_pool_id === pool && (task.status === 'offered' || task.status === 'broadcast'),
      )
      .sort((a, b) => byPriority(a.task, b.task));
  };
  const offerFor = (viewer: FUser) => {
    const hit = visibleOffers(viewer)[0];
    const eligible = eligibility(viewer.id);
    if (!hit || !eligible) return null;
    const t = w().tickets.find((x) => x.id === hit.task.ticket_id) as FTicket;
    const cycle = openCycle(t);
    return {
      offer_id: hit.o.id,
      task_id: hit.task.id,
      mode: hit.o.mode,
      eligible_as: eligible,
      expires_at: hit.o.expires_at,
      reminder_at: null,
      server_time: now(),
      ticket: {
        display_number: t.display_number,
        event_name_ar: eventOf(t.event_id)?.name_ar,
        plate: plateView(t),
        vehicle: { make: t.vehicle_make, color: t.vehicle_color },
      },
      requested_at: cycle?.requested_at ?? hit.task.priority_at,
      waiting_seconds: cycle ? Math.round((Date.now() - Date.parse(cycle.requested_at)) / 1000) : 0,
      can_accept: eligible === 'accept',
      can_reserve_next: eligible === 'reserve_next',
      safety_note_ar: null,
    };
  };
  /** After a movement ends: promote the reserved next task, or the driver is available again. */
  const settleDriver = (driver: FUser) => {
    const next = w().tasks.find((k) => k.assignee_id === driver.id && k.status === 'assigned_waiting');
    const duty = openDuty(s, driver.id);
    if (next) {
      next.status = 'accepted';
      next.accepted_at = now();
      next.version += 1;
      const t = w().tickets.find((x) => x.id === next.ticket_id) as FTicket;
      t.status = 'assigned';
      t.version += 1;
      return { driver_state: driverState(s, driver.id), promoted_next_task: taskCard(next, driver) };
    }
    if (duty) duty.available_since = now();
    if (duty) pass(duty.dispatch_pool_id);
    return { driver_state: driverState(s, driver.id), promoted_next_task: null };
  };

  // ---------------------------------------------------------------- guards

  const onDuty = (u: FUser) => {
    const duty = openDuty(s, u.id);
    if (!duty) fail('DUTY_REQUIRED');
    return duty;
  };
  const ticketIn = (ctx: Ctx): FTicket =>
    s.needInScope(
      ctx,
      w().tickets.find((t) => t.id === ctx.params.ticketId),
      'TICKET_NOT_FOUND',
    );
  const taskIn = (ctx: Ctx): FTask =>
    s.needInScope(
      ctx,
      w().tasks.find((k) => k.id === ctx.params.taskId),
    );
  const assignee = (task: FTask, u: FUser) => {
    if (task.assignee_id !== u.id) fail('NOT_TASK_ASSIGNEE');
  };
  const state = (current: string, allowed: string[]) => {
    if (!allowed.includes(current)) fail('INVALID_STATE_TRANSITION', { current_status: current, allowed });
  };

  // ---------------------------------------------------------------- home & duty (07 §2.1)

  s.on('GET /v1/me/home', (ctx) => {
    const u = s.need(ctx, 'duty.self');
    tick();
    const a = s.activeAssignment(u.id);
    const duty = openDuty(s, u.id);
    const venueId =
      a?.venue_id ?? duty?.venue_id ?? (u.role !== 'driver' ? s.venueIdsInScope(u)[0] : undefined);
    if (!venueId) fail('ASSIGNMENT_REQUIRED');
    const venue = venueOf(venueId);
    if (!venue) fail('ASSIGNMENT_REQUIRED');
    const shift = w().shifts.find(
      (sh) => sh.dispatch_pool_id === venue.default_dispatch_pool_id && sh.status === 'open',
    );
    const mine = w().tasks.filter((k) => k.assignee_id === u.id);
    const current = mine.find((k) => k.status === 'accepted' || k.status === 'in_progress');
    const next = mine.find((k) => k.status === 'assigned_waiting');
    const draft = w().tickets.find((t) => t.created_by === u.id && t.status === 'received');
    const openEvents = w().events.filter((e) => e.venue_id === venue.id && e.status === 'open');
    const cash = w()
      .payments.filter((p) => p.collected_by === u.id && p.method === 'cash')
      .reduce((sum, p) => sum + p.amount_halalas, 0);
    const settings = settingsOf(venue.id);
    const device = ctx.session.deviceId ? s.devices.get(ctx.session.deviceId) : undefined;
    return ok({
      server_time: now(),
      user: userRef(u),
      venue: { id: venue.id, code: venue.code, name_ar: venue.name_ar },
      open_events: openEvents.map((e) => ({ id: e.id, name_ar: e.name_ar, status: e.status })),
      active_assignment: a ? assignmentView(s, a) : null,
      shift_open: !!shift,
      shift: shift ? { id: shift.id, status: shift.status, opened_at: shift.opened_at } : null,
      settings: {
        inspection: settings.inspection,
        parking: settings.parking,
        keys: settings.keys,
        dispatch: { single_offer_ttl_s: settings.dispatch?.single_offer_ttl_s },
      },
      duty_session: duty ? dutyView(duty) : null,
      driver_state: driverState(s, u.id),
      connection_state: duty ? 'online' : null,
      current_task: current ? taskCard(current, u) : null,
      next_task: next ? taskCard(next, u) : null,
      offer: duty?.status === 'on_duty' ? offerFor(u) : null,
      draft_ticket_id: draft?.id ?? null,
      cash_outstanding_halalas: cash,
      checks: {
        audio_tested: device?.audio_test_result === 'heard',
        push_enabled: false,
        pwa_installed: false,
      },
      channel_health: 'healthy',
    });
  });

  s.on('POST /v1/me/duty/start', (ctx) => {
    const u = s.need(ctx, 'duty.self');
    if (u.status === 'disabled') fail('DRIVER_DISABLED');
    const a = s.activeAssignment(u.id);
    if (!a) fail('ASSIGNMENT_REQUIRED');
    if (openDuty(s, u.id)) fail('DUTY_ALREADY_STARTED');
    const venue = venueOf(a.venue_id);
    const shift = w().shifts.find(
      (sh) => sh.dispatch_pool_id === venue?.default_dispatch_pool_id && sh.status === 'open',
    );
    if (!venue || !shift) fail('SHIFT_NOT_OPEN');
    const duty = {
      id: uuid(),
      user_id: u.id,
      shift_id: shift.id,
      venue_id: venue.id,
      dispatch_pool_id: shift.dispatch_pool_id,
      status: 'on_duty' as const,
      started_at: now(),
      ended_at: null,
      end_reason: null,
      available_since: now(),
      version: 1,
    };
    w().duties.push(duty);
    pass(duty.dispatch_pool_id);
    const device = ctx.session.deviceId ? s.devices.get(ctx.session.deviceId) : undefined;
    return ok(
      {
        duty_session: dutyView(duty),
        driver_state: driverState(s, u.id),
        checks: { audio_tested: device?.audio_test_result === 'heard', push_enabled: false },
      },
      201,
    );
  });

  s.on('POST /v1/me/duty/break', (ctx) => {
    const u = s.need(ctx, 'duty.self');
    const duty = onDuty(u);
    if (typeof ctx.body?.active !== 'boolean') validation([{ field: 'active', issue: 'required' }]);
    if (ctx.body.active) {
      if (duty.status === 'on_break') fail('INVALID_STATE_TRANSITION', { current_status: 'on_break' });
      if (driverState(s, u.id) !== 'available') fail('DRIVER_NOT_AVAILABLE');
      if (s.custodyItems(u.id).length) fail('CUSTODY_OPEN', { items: s.custodyItems(u.id) });
      duty.status = 'on_break';
      duty.available_since = null;
      const offer = liveSingleOffer(u.id);
      if (offer) {
        offer.status = 'revoked';
        offer.close_reason = 'recipient_unavailable';
        const task = w().tasks.find((k) => k.id === offer.task_id) as FTask;
        task.status = 'queued';
        pass(duty.dispatch_pool_id);
      }
    } else {
      if (duty.status !== 'on_break') fail('INVALID_STATE_TRANSITION', { current_status: duty.status });
      duty.status = 'on_duty';
      duty.available_since = now();
      pass(duty.dispatch_pool_id);
    }
    duty.version += 1;
    return ok(dutyView(duty));
  });

  s.on('POST /v1/me/duty/end', (ctx) => {
    const u = s.need(ctx, 'duty.self');
    const duty = onDuty(u);
    const items = s.custodyItems(u.id);
    if (items.length) fail('DUTY_END_BLOCKED_CUSTODY', { items });
    duty.status = 'ended';
    duty.ended_at = now();
    duty.end_reason = 'self';
    duty.available_since = null;
    duty.version += 1;
    return ok(dutyView(duty));
  });

  // ---------------------------------------------------------------- device checks (D-03)

  const deviceView = (id: string) => {
    const d = s.devices.get(id);
    if (!d) return null;
    return {
      id: d.id,
      label: null,
      platform: d.platform,
      display_mode: d.display_mode,
      notification_permission: d.notification_permission,
      push_subscribed: false,
      audio_tested_at: d.audio_tested_at,
      audio_test_result: d.audio_test_result,
      last_seen_at: now(),
      created_at: d.created_at,
    };
  };
  const ownDevice = (ctx: Ctx, id: unknown) => {
    const d = typeof id === 'string' ? s.devices.get(id) : undefined;
    if (!d || d.user_id !== ctx.user?.id) fail('RESOURCE_NOT_FOUND');
    return d;
  };
  s.on('POST /v1/me/audio-test', (ctx) => {
    s.need(ctx, 'auth.self');
    const d = ownDevice(ctx, ctx.body?.device_id);
    if (!['heard', 'not_heard', 'blocked'].includes(ctx.body?.result))
      validation([{ field: 'result', issue: 'enum' }]);
    d.audio_test_result = ctx.body.result;
    d.audio_tested_at = now();
    return ok(deviceView(d.id));
  });
  s.on('PUT /v1/me/devices/:deviceId', (ctx) => {
    s.need(ctx, 'auth.self');
    const d = ownDevice(ctx, ctx.params.deviceId);
    if (ctx.body?.notification_permission) d.notification_permission = ctx.body.notification_permission;
    if (ctx.body?.display_mode) d.display_mode = ctx.body.display_mode;
    return ok(deviceView(d.id));
  });

  // ---------------------------------------------------------------- intake (07 §2.2)

  s.on('POST /v1/tickets', (ctx) => {
    const u = s.need(ctx, 'ticket.intake');
    const duty = onDuty(u);
    if (duty.status === 'on_break') fail('DRIVER_ON_BREAK');
    if (
      w().tasks.some((k) => k.assignee_id === u.id && (k.status === 'accepted' || k.status === 'in_progress'))
    )
      fail('MOVEMENT_IN_PROGRESS');
    const open = w().events.filter((e) => e.venue_id === duty.venue_id && e.status === 'open');
    const eventId = ctx.body?.event_id ?? null;
    if (!open.length) fail('EVENT_NOT_OPEN');
    if (!eventId && open.length > 1)
      validation([{ field: 'event_id', issue: 'required_multiple_open_events' }]);
    const event = eventId ? open.find((e) => e.id === eventId) : open[0];
    if (!event) fail('EVENT_NOT_OPEN');
    const t: FTicket = {
      id: uuid(),
      display_number: event.next_display_number++,
      event_id: event.id,
      venue_id: duty.venue_id,
      status: 'received',
      channel: ctx.body?.channel === 'paper' ? 'paper' : 'whatsapp',
      plate_country: 'SA',
      plate_digits: null,
      plate_letters_ar: null,
      plate_letters_en: null,
      plate_raw: null,
      vehicle_make: null,
      vehicle_model: null,
      vehicle_color: null,
      customer_phone: null,
      consent: false,
      wa_link_status: 'none',
      paper_serial: null,
      key_tag: null,
      notes: null,
      inspection_status: 'pending',
      payment_status: event.pricing_mode === 'per_vehicle' ? 'due' : 'not_required',
      fee_halalas: event.pricing_mode === 'per_vehicle' ? event.fee_halalas : 0,
      spot_id: null,
      spot_note: null,
      key_slot_id: null,
      vehicle_holder: { type: 'customer', id: null },
      key_holder: { type: 'customer', id: null },
      created_by: u.id,
      parked_by: null,
      retrieved_by: null,
      delivered_by: null,
      submitted_at: null,
      parked_at: null,
      delivered_at: null,
      voided_at: null,
      void_reason: null,
      pending_retrieval_at: null,
      claim: null,
      version: 1,
      created_at: now(),
    };
    w().tickets.push(t);
    const task: FTask = {
      id: uuid(),
      ticket_id: t.id,
      cycle_id: null,
      event_id: event.id,
      venue_id: t.venue_id,
      dispatch_pool_id: event.dispatch_pool_id,
      type: 'park',
      status: 'in_progress',
      priority_at: now(),
      seq: w().tasks.length + 1,
      assignee_id: u.id,
      claimed_at: now(),
      accepted_at: now(),
      key_picked_up_at: null,
      started_at: now(),
      completed_at: null,
      canceled_at: null,
      cancel_reason: null,
      offered_to: [],
      version: 1,
    };
    w().tasks.push(task);
    custody(t, 'vehicle', { type: 'driver', id: u.id }, 'intake', u, task);
    custody(t, 'key', { type: 'driver', id: u.id }, 'intake', u, task);
    // the intake competes with offers under the pool lock: a live single offer to this driver goes back
    const live = liveSingleOffer(u.id);
    if (live) {
      live.status = 'revoked';
      live.close_reason = 'recipient_unavailable';
      const back = w().tasks.find((k) => k.id === live.task_id) as FTask;
      back.status = 'queued';
      pass(back.dispatch_pool_id);
    }
    return ok({ ticket: ticketDetail(t, u), task: taskView(task), driver_state: driverState(s, u.id) }, 201);
  });

  s.on('GET /v1/tickets/:ticketId', (ctx) => {
    const u = s.need(ctx, 'ticket.read_minimal');
    return ok(ticketDetail(ticketIn(ctx), u));
  });

  const creatorDraft = (ctx: Ctx, u: FUser, statuses: string[]) => {
    const t = ticketIn(ctx);
    if (t.created_by !== u.id) fail('NOT_TASK_ASSIGNEE');
    state(t.status, statuses);
    return t;
  };
  const applyPlate = (t: FTicket, plate: any) => {
    const country = String(plate?.country ?? 'SA');
    if (country === 'SA') {
      const digits = String(plate?.digits ?? '');
      const letters = String(plate?.letters_ar ?? '')
        .split(/\s+/)
        .filter(Boolean);
      if (!/^[0-9]{1,4}$/.test(digits) || letters.length !== 3 || letters.some((l) => !(l in PLATE_EN)))
        fail('PLATE_INVALID');
      t.plate_country = 'SA';
      t.plate_digits = digits;
      t.plate_letters_ar = letters.join(' ');
      t.plate_letters_en = letters.map((l) => PLATE_EN[l]).join(' ');
      t.plate_raw = null;
    } else {
      const raw = String(plate?.raw ?? '').trim();
      if (!raw || raw.length > 12) fail('PLATE_INVALID');
      t.plate_country = country;
      t.plate_raw = raw;
      t.plate_digits = null;
      t.plate_letters_ar = null;
      t.plate_letters_en = null;
    }
  };

  s.on('PATCH /v1/tickets/:ticketId/intake', (ctx) => {
    const u = s.need(ctx, 'ticket.intake');
    onDuty(u);
    const b = ctx.body ?? {};
    if (!Number.isInteger(b.expected_version)) validation([{ field: 'expected_version', issue: 'required' }]);
    const t = creatorDraft(ctx, u, ['received', 'parking']);
    s.checkVersion('ticket', t, b.expected_version);
    if (t.status === 'parking') {
      // DEC-40: during parking only {channel: paper, paper_serial} for an unlinked WhatsApp ticket
      const keys = Object.keys(b).filter((k) => k !== 'expected_version');
      if (
        b.channel !== 'paper' ||
        keys.some((k) => k !== 'channel' && k !== 'paper_serial') ||
        t.wa_link_status === 'linked'
      )
        fail('INVALID_STATE_TRANSITION', { current_status: t.status });
    }
    // applied to a copy first: a refused command changes nothing (one transaction on the server)
    const next: FTicket = { ...t };
    if ('plate' in b) applyPlate(next, b.plate);
    if (b.vehicle) {
      if ('make' in b.vehicle) next.vehicle_make = b.vehicle.make ?? null;
      if ('model' in b.vehicle) next.vehicle_model = b.vehicle.model ?? null;
      if ('color' in b.vehicle) next.vehicle_color = b.vehicle.color ?? null;
    }
    if (b.channel === 'paper' || b.channel === 'whatsapp') next.channel = b.channel;
    if ('customer_phone' in b)
      next.customer_phone = b.customer_phone ? normalizePhone(b.customer_phone) : null;
    if ('consent' in b) next.consent = !!b.consent?.confirmed;
    if ('paper_serial' in b) {
      const serial = b.paper_serial ? String(b.paper_serial).trim() : null;
      if (
        serial &&
        w().tickets.some(
          (x) =>
            x.id !== t.id && x.event_id === t.event_id && x.status !== 'voided' && x.paper_serial === serial,
        )
      )
        fail('PAPER_SERIAL_IN_USE', { field: 'paper_serial' });
      next.paper_serial = serial;
    }
    if ('key_tag' in b) {
      const tag = b.key_tag ? String(b.key_tag).trim() : null;
      const other = tag
        ? w().tickets.find(
            (x) => x.id !== t.id && x.venue_id === t.venue_id && isOpen(x) && x.key_tag === tag,
          )
        : undefined;
      if (other)
        fail('KEY_TAG_IN_USE', { field: 'key_tag', conflicting_display_number: other.display_number });
      next.key_tag = tag;
    }
    if ('notes' in b) next.notes = b.notes ?? null;
    if (next.status === 'parking' && b.channel === 'paper') next.wa_link_status = 'none';
    next.version += 1;
    Object.assign(t, next);
    return ok(ticketDetail(t, u));
  });

  s.on('POST /v1/tickets/:ticketId/media', (ctx) => {
    const u = s.need(ctx, 'ticket.intake');
    const t = creatorDraft(ctx, u, ['received', 'parking']);
    const b = ctx.body ?? {};
    if (!MEDIA_TYPES.includes(b.content_type)) fail('MEDIA_TYPE_UNSUPPORTED');
    if (!Number.isInteger(b.byte_size) || b.byte_size < 1) validation([{ field: 'byte_size', issue: 'min' }]);
    if (b.byte_size > MEDIA_MAX_BYTES) fail('MEDIA_TOO_LARGE', { max_bytes: MEDIA_MAX_BYTES });
    const extras = ['photo_extra', 'photo_damage'];
    if (extras.includes(b.kind)) {
      const max = Number(settingsOf(t.venue_id).inspection?.max_extra_photos ?? 8);
      const count = w().media.filter(
        (m) => m.ticket_id === t.id && extras.includes(m.kind) && m.upload_status !== 'deleted',
      ).length;
      if (count >= max) validation([{ field: 'kind', issue: 'max_extra_photos' }]);
    }
    const media: FMedia = {
      id: uuid(),
      ticket_id: t.id,
      kind: String(b.kind),
      content_type: b.content_type,
      byte_size: b.byte_size,
      sha256: b.sha256 ?? null,
      upload_status: 'pending',
      received_bytes: null,
      captured_at: b.captured_at ?? null,
      uploaded_at: null,
      uploaded_by: u.id,
    };
    w().media.push(media);
    return ok(
      {
        media: mediaView(media),
        upload: {
          method: 'PUT',
          url: `${ctx.origin}${STORAGE_PREFIX}${media.id}`,
          headers: { 'Content-Type': media.content_type },
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
      },
      201,
    );
  });

  // the presigned PUT / GET of the private bucket (no session, no CSRF, no Idempotency-Key)
  s.on(
    `PUT ${STORAGE_PREFIX}:mediaId`,
    (ctx): Reply => {
      const m = w().media.find((x) => x.id === ctx.params.mediaId);
      if (!m) return { status: 403, body: { error: 'AccessDenied' } };
      if ((ctx.headers['content-type'] ?? '') !== m.content_type)
        return { status: 403, body: { error: 'SignatureDoesNotMatch' } };
      const bytes = ctx.rawBody ?? Buffer.alloc(0);
      s.storage.set(m.id, { bytes, contentType: m.content_type });
      m.received_bytes = bytes.length;
      return { status: 200, body: undefined, headers: { ETag: `"${m.id}"` } };
    },
    { public: true, idem: 'none' },
  );
  s.on(
    `GET ${STORAGE_PREFIX}:mediaId`,
    (ctx): Reply => {
      const object = s.storage.get(ctx.params.mediaId ?? '');
      if (!object) return { status: 404, body: { error: 'NoSuchKey' } };
      return { status: 200, raw: object.bytes, contentType: object.contentType };
    },
    { public: true, idem: 'none' },
  );

  s.on('POST /v1/media/:mediaId/complete', (ctx) => {
    const u = s.need(ctx, 'ticket.intake');
    const m = w().media.find((x) => x.id === ctx.params.mediaId);
    const t = m ? w().tickets.find((x) => x.id === m.ticket_id) : undefined;
    if (!m || !t || !s.inScope(u, t.venue_id) || m.uploaded_by !== u.id) fail('RESOURCE_NOT_FOUND');
    if (m.received_bytes === null || m.received_bytes !== m.byte_size) fail('MEDIA_UPLOAD_INCOMPLETE');
    if (ctx.body?.sha256 && m.sha256 && ctx.body.sha256 !== m.sha256) fail('MEDIA_UPLOAD_INCOMPLETE');
    if (m.upload_status !== 'uploaded') {
      // a retake replaces the previous photo of a required angle (02 D-06)
      if (!['photo_extra', 'photo_damage'].includes(m.kind))
        for (const old of w().media)
          if (
            old.ticket_id === t.id &&
            old.kind === m.kind &&
            old.id !== m.id &&
            old.upload_status === 'uploaded'
          )
            old.upload_status = 'deleted';
      m.upload_status = 'uploaded';
      m.uploaded_at = now();
    }
    // photos taken during intake that finish later complete the inspection (02 D-06)
    if (t.inspection_status === 'incomplete' && missingPhotos(t).length === 0)
      t.inspection_status = 'complete';
    return ok(mediaView(m));
  });

  s.on('GET /v1/media/:mediaId/url', (ctx) => {
    const u = s.need(ctx, 'ticket.read_photos');
    const m = w().media.find((x) => x.id === ctx.params.mediaId && x.upload_status === 'uploaded');
    const t = m ? w().tickets.find((x) => x.id === m.ticket_id) : undefined;
    if (!m || !t || !s.inScope(u, t.venue_id) || !fullFor(t, u)) fail('RESOURCE_NOT_FOUND');
    return ok({
      url: `${ctx.origin}${STORAGE_PREFIX}${m.id}`,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
  });

  const missingPhotos = (t: FTicket): string[] => {
    const required = (settingsOf(t.venue_id).inspection?.required_photos as string[] | undefined) ?? [];
    return required.filter(
      (kind) =>
        !w().media.some((m) => m.ticket_id === t.id && m.kind === kind && m.upload_status === 'uploaded'),
    );
  };

  s.on('POST /v1/tickets/:ticketId/submit-intake', (ctx) => {
    const u = s.need(ctx, 'ticket.intake');
    onDuty(u);
    const t = creatorDraft(ctx, u, ['received']);
    s.checkVersion('ticket', t, ctx.body?.expected_version);
    const missing: string[] = [];
    if (!(t.plate_raw || (t.plate_digits && t.plate_letters_ar))) missing.push('plate');
    if (!t.vehicle_make) missing.push('vehicle.make');
    if (!t.vehicle_color) missing.push('vehicle.color');
    if (!t.key_tag) missing.push('key_tag');
    if (t.channel === 'paper' && !t.paper_serial) missing.push('paper_serial');
    if (t.channel === 'whatsapp' && t.customer_phone && !t.consent) fail('CONSENT_REQUIRED');
    if (t.channel === 'whatsapp' && !t.customer_phone) missing.push('customer_phone');
    if (missing.length) fail('INTAKE_INCOMPLETE', { missing });
    const photos = missingPhotos(t);
    if (photos.length && ctx.body?.acknowledge_incomplete_inspection !== true)
      fail('INSPECTION_INCOMPLETE', { missing: photos });
    t.inspection_status = photos.length ? 'incomplete' : 'complete';
    t.status = 'parking';
    t.submitted_at = now();
    if (t.channel === 'whatsapp') t.wa_link_status = 'pending_send';
    t.version += 1;
    return ok(ticketDetail(t, u));
  });

  s.on('POST /v1/tickets/:ticketId/discard-draft', (ctx) => {
    const u = s.need(ctx, 'ticket.discard_empty_draft');
    const t = creatorDraft(ctx, u, ['received']);
    s.checkVersion('ticket', t, ctx.body?.expected_version);
    const hasData =
      !!(
        t.plate_digits ||
        t.plate_raw ||
        t.plate_letters_ar ||
        t.vehicle_make ||
        t.vehicle_color ||
        t.customer_phone ||
        t.key_tag ||
        t.paper_serial
      ) || w().media.some((m) => m.ticket_id === t.id && m.upload_status !== 'deleted');
    if (hasData) fail('DRAFT_HAS_DATA');
    const task = openTask(t);
    if (task) {
      task.status = 'canceled';
      task.canceled_at = now();
      task.cancel_reason = 'empty_draft';
      task.version += 1;
    }
    custody(t, 'vehicle', { type: 'customer', id: null }, 'correction', u, task);
    custody(t, 'key', { type: 'customer', id: null }, 'correction', u, task);
    t.status = 'voided';
    t.voided_at = now();
    t.void_reason = 'empty_draft';
    t.version += 1;
    return ok(settleDriver(u));
  });

  // ---------------------------------------------------------------- parking (07 §2.3)

  s.on('POST /v1/tasks/:taskId/complete-parking', (ctx) => {
    const u = s.need(ctx, 'task.execute');
    onDuty(u);
    const task = taskIn(ctx);
    assignee(task, u);
    if (task.type !== 'park' && task.type !== 'repark')
      fail('INVALID_STATE_TRANSITION', { current_status: task.type });
    state(task.status, ['in_progress']);
    s.checkVersion('task', task, ctx.body?.expected_version);
    const t = w().tickets.find((x) => x.id === task.ticket_id) as FTicket;
    state(t.status, ['parking', 'reparking']);
    const b = ctx.body ?? {};
    const settings = settingsOf(t.venue_id);
    const mode = String(settings.parking?.mode ?? 'mixed');
    const spot = b.parking_spot_id
      ? w().spots.find((x) => x.id === b.parking_spot_id && x.venue_id === t.venue_id)
      : undefined;
    const note = typeof b.spot_note === 'string' ? b.spot_note.trim() : '';
    if (b.parking_spot_id && (!spot || spot.status !== 'active'))
      validation([{ field: 'parking_spot_id', issue: 'unknown' }]);
    if (mode === 'assigned_spots' && !spot) validation([{ field: 'parking_spot_id', issue: 'required' }]);
    if (!spot && !note) validation([{ field: 'parking_spot_id', issue: 'required' }]);
    if (spot?.ticket_id && spot.ticket_id !== t.id) fail('PARKING_SPOT_OCCUPIED', { spot_id: spot.id });
    const slot = b.key_slot_id
      ? w().slots.find((x) => x.id === b.key_slot_id && x.venue_id === t.venue_id)
      : undefined;
    if (b.key_slot_id && (!slot || slot.status !== 'active'))
      validation([{ field: 'key_slot_id', issue: 'unknown' }]);
    if (settings.keys?.require_slot && !slot) validation([{ field: 'key_slot_id', issue: 'required' }]);
    if (slot?.ticket_id && slot.ticket_id !== t.id) fail('KEY_SLOT_OCCUPIED', { key_slot_id: slot.id });
    if (t.vehicle_holder.type !== 'driver' || t.vehicle_holder.id !== u.id) fail('CUSTODY_HOLDER_MISMATCH');
    if (spot) {
      spot.ticket_id = t.id;
      t.spot_id = spot.id;
      t.spot_note = null;
    } else {
      t.spot_id = null;
      t.spot_note = note;
    }
    custody(
      t,
      'vehicle',
      spot ? { type: 'spot', id: spot.id } : { type: 'unknown', id: null },
      task.type === 'repark' ? 'repark' : 'parked',
      u,
      task,
    );
    if (slot) {
      slot.ticket_id = t.id;
      t.key_slot_id = slot.id;
      custody(t, 'key', { type: 'key_slot', id: slot.id }, 'key_deposited', u, task);
    }
    task.status = 'completed';
    task.completed_at = now();
    task.version += 1;
    t.status = 'parked';
    t.parked_at = now();
    if (task.type === 'park') t.parked_by = u.id;
    t.version += 1;
    // DEC-13: an early request becomes a cycle with its original time
    if (t.pending_retrieval_at) {
      requestCycle(t, t.pending_retrieval_at, 'whatsapp');
      t.pending_retrieval_at = null;
    }
    const driver = settleDriver(u);
    return ok({ ticket: ticketDetail(t, u), task: taskView(task), driver });
  });

  const requestCycle = (t: FTicket, requestedAt: string, source: 'whatsapp' | 'staff') => {
    const cycle: FCycle = {
      id: uuid(),
      ticket_id: t.id,
      cycle_no: w().cycles.filter((c) => c.ticket_id === t.id).length + 1,
      requested_at: requestedAt,
      request_source: source,
      request_reason: null,
      accepted_by: null,
      retrieved_by: null,
      delivered_by: null,
      started_at: null,
      ready_at: null,
      delivered_at: null,
      outcome: null,
      closed_at: null,
    };
    w().cycles.push(cycle);
    const event = eventOf(t.event_id);
    const task: FTask = {
      id: uuid(),
      ticket_id: t.id,
      cycle_id: cycle.id,
      event_id: t.event_id,
      venue_id: t.venue_id,
      dispatch_pool_id: event?.dispatch_pool_id ?? '',
      type: 'retrieve',
      status: 'queued',
      priority_at: requestedAt,
      seq: w().tasks.length + 1,
      assignee_id: null,
      claimed_at: null,
      accepted_at: null,
      key_picked_up_at: null,
      started_at: null,
      completed_at: null,
      canceled_at: null,
      cancel_reason: null,
      offered_to: [],
      version: 1,
    };
    w().tasks.push(task);
    t.status = 'requested';
    t.version += 1;
    pass(task.dispatch_pool_id);
    return { cycle, task };
  };

  // ---------------------------------------------------------------- retrieval (07 §2.3)

  s.on('POST /v1/tickets/:ticketId/retrievals', (ctx) => {
    s.need(ctx, 'retrieval.request_on_behalf');
    const t = ticketIn(ctx);
    const reason = typeof ctx.body?.reason === 'string' ? ctx.body.reason.trim() : '';
    if (reason.length < 3) fail('REASON_REQUIRED');
    if (!isOpen(t)) fail('TICKET_CLOSED');
    if (openCycle(t)) fail('RETRIEVAL_ALREADY_ACTIVE', { cycle_id: openCycle(t)?.id });
    if (t.status !== 'parked') fail('TICKET_NOT_PARKED');
    const { cycle, task } = requestCycle(t, now(), 'staff');
    cycle.request_reason = reason;
    return ok({ ticket: ticketSummary(t), cycle: cycleView(cycle), task: taskView(task) }, 201);
  });

  s.on('POST /v1/task-offers/:offerId/accept', (ctx) => {
    const u = s.need(ctx, 'offer.accept');
    const offer = w().offers.find((o) => o.id === ctx.params.offerId);
    const task = offer ? w().tasks.find((k) => k.id === offer.task_id) : undefined;
    if (!offer || !task || !s.inScope(u, task.venue_id)) fail('OFFER_NOT_FOUND');
    const duty = onDuty(u);
    if (duty.status === 'on_break') fail('DRIVER_ON_BREAK');
    expireOffers();
    if (offer.status === 'expired') fail('OFFER_EXPIRED');
    if (offer.status === 'revoked') fail('OFFER_REVOKED');
    if (offer.status === 'accepted' || !['offered', 'broadcast'].includes(task.status))
      fail('TASK_ALREADY_CLAIMED', { task_id: task.id });
    if (
      offer.mode === 'single'
        ? !offer.recipients.includes(u.id)
        : duty.dispatch_pool_id !== task.dispatch_pool_id
    )
      fail('NOT_OFFER_RECIPIENT');
    // 10 §5.2: no newer request while an older one is open to this driver in the same pool
    const oldest = visibleOffers(u)[0];
    if (oldest && oldest.task.id !== task.id && byPriority(oldest.task, task) < 0)
      fail('OLDER_REQUEST_PENDING', { older_task_id: oldest.task.id, older_offer_id: oldest.o.id });
    const as = eligibility(u.id);
    if (as === 'view_only') fail('NEXT_TASK_ALREADY_RESERVED');
    if (!as) fail('DRIVER_NOT_AVAILABLE');
    const t = w().tickets.find((x) => x.id === task.ticket_id) as FTicket;
    const cycle = openCycle(t);
    task.assignee_id = u.id;
    task.claimed_at = now();
    task.status = as === 'accept' ? 'accepted' : 'assigned_waiting';
    if (as === 'accept') task.accepted_at = now();
    task.version += 1;
    offer.status = 'accepted';
    offer.accepted_by = u.id;
    for (const other of w().offers)
      if (other.task_id === task.id && other.id !== offer.id && other.status === 'active') {
        other.status = 'revoked';
        other.close_reason = 'claimed';
      }
    // a live single offer of another task to this driver goes back to the queue (10 §5.2)
    const mineElsewhere = liveSingleOffer(u.id);
    if (mineElsewhere && mineElsewhere.task_id !== task.id) {
      mineElsewhere.status = 'revoked';
      mineElsewhere.close_reason = 'recipient_unavailable';
      const back = w().tasks.find((k) => k.id === mineElsewhere.task_id) as FTask;
      back.status = 'queued';
    }
    t.status = as === 'accept' ? 'assigned' : 'assigned_waiting';
    t.version += 1;
    if (cycle) cycle.accepted_by = u.id;
    pass(task.dispatch_pool_id);
    return ok({
      result: task.status,
      task: taskView(task),
      ticket: ticketSummary(t),
      driver_state: driverState(s, u.id),
    });
  });

  const retrieveTask = (ctx: Ctx, u: FUser) => {
    onDuty(u);
    const task = taskIn(ctx);
    assignee(task, u);
    if (task.type !== 'retrieve') fail('INVALID_STATE_TRANSITION', { current_status: task.type });
    return { task, t: w().tickets.find((x) => x.id === task.ticket_id) as FTicket };
  };

  s.on('POST /v1/tasks/:taskId/key-pickup', (ctx) => {
    const u = s.need(ctx, 'task.execute');
    const { task, t } = retrieveTask(ctx, u);
    if (task.status === 'assigned_waiting') fail('TASK_NOT_STARTABLE');
    state(task.status, ['accepted']);
    s.checkVersion('task', task, ctx.body?.expected_version);
    if (task.key_picked_up_at) fail('INVALID_STATE_TRANSITION', { current_status: 'key_picked_up' });
    if (!ctx.body?.key_slot_id || ctx.body.key_slot_id !== t.key_slot_id) fail('CUSTODY_HOLDER_MISMATCH');
    const slot = w().slots.find((x) => x.id === t.key_slot_id);
    custody(t, 'key', { type: 'driver', id: u.id }, 'key_pickup', u, task);
    if (slot) slot.ticket_id = null;
    t.key_slot_id = null;
    task.key_picked_up_at = now();
    task.version += 1;
    return ok(taskCard(task, u));
  });

  s.on('POST /v1/tasks/:taskId/start-retrieval', (ctx) => {
    const u = s.need(ctx, 'task.execute');
    const { task, t } = retrieveTask(ctx, u);
    if (task.status === 'assigned_waiting') fail('TASK_NOT_STARTABLE');
    state(task.status, ['accepted']);
    s.checkVersion('task', task, ctx.body?.expected_version);
    if (!task.key_picked_up_at) fail('KEY_NOT_PICKED_UP');
    const spot = w().spots.find((x) => x.id === t.spot_id);
    custody(t, 'vehicle', { type: 'driver', id: u.id }, 'retrieval_start', u, task);
    if (spot) spot.ticket_id = null;
    t.spot_id = null;
    task.status = 'in_progress';
    task.started_at = now();
    task.version += 1;
    t.status = 'retrieving';
    t.retrieved_by = u.id;
    t.version += 1;
    const cycle = openCycle(t);
    if (cycle) {
      cycle.started_at = now();
      cycle.retrieved_by = u.id;
    }
    return ok(taskCard(task, u));
  });

  s.on('POST /v1/tasks/:taskId/ready', (ctx) => {
    const u = s.need(ctx, 'task.execute');
    const { task, t } = retrieveTask(ctx, u);
    state(task.status, ['in_progress']);
    state(t.status, ['retrieving']);
    s.checkVersion('task', task, ctx.body?.expected_version);
    t.status = 'ready';
    t.version += 1;
    const cycle = openCycle(t);
    if (cycle) cycle.ready_at = now();
    if (t.channel === 'whatsapp') issueCode(t);
    task.version += 1;
    return ok(taskCard(task, u));
  });

  const issueCode = (t: FTicket) => {
    const h = settingsOf(t.venue_id).handover ?? {};
    t.claim = {
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      attempts: 0,
      max_attempts: Number(h.max_attempts ?? 5),
      issued_at: now(),
      expires_at: new Date(Date.now() + Number(h.code_ttl_min ?? 30) * 60_000).toISOString(),
      locked_at: null,
      consumed_at: null,
      resend_no: (t.claim?.resend_no ?? -1) + 1,
      max_resends: Number(h.max_resends ?? 3),
    };
  };

  s.on('POST /v1/tickets/:ticketId/handover', (ctx) => {
    const u = s.need(ctx, 'handover.verify');
    onDuty(u);
    const t = ticketIn(ctx);
    if (!isOpen(t)) fail('TICKET_CLOSED');
    if (t.status !== 'ready') fail('HANDOVER_NOT_READY');
    const task = w().tasks.find(
      (k) => k.ticket_id === t.id && k.type === 'retrieve' && k.status === 'in_progress',
    );
    if (!task || task.assignee_id !== u.id) fail('NOT_TASK_ASSIGNEE');
    s.checkVersion('ticket', t, ctx.body?.expected_version);
    const v = ctx.body?.verification ?? {};
    if (v.method === 'paper_stub') {
      if (t.channel !== 'paper' || String(v.paper_serial ?? '').trim() !== t.paper_serial)
        fail('PAPER_STUB_MISMATCH');
    } else if (v.method === 'code') {
      const c = t.claim;
      if (!c) fail('HANDOVER_CODE_EXPIRED');
      if (c.consumed_at) fail('HANDOVER_CODE_CONSUMED');
      if (c.locked_at) fail('HANDOVER_CODE_LOCKED', { locked_at: c.locked_at });
      if (Date.now() > Date.parse(c.expires_at)) fail('HANDOVER_CODE_EXPIRED');
      if (v.code !== c.code) {
        // the wrong attempt is kept even though the reply is an error (07 §1.4)
        c.attempts += 1;
        if (c.attempts >= c.max_attempts) {
          c.locked_at = now();
          fail('HANDOVER_CODE_LOCKED', { locked_at: c.locked_at });
        }
        fail('HANDOVER_CODE_INVALID', { attempts_left: c.max_attempts - c.attempts });
      }
    } else validation([{ field: 'verification', issue: 'required' }]);
    const event = eventOf(t.event_id);
    const pay = ctx.body?.payment;
    if (t.payment_status === 'due') {
      if (!pay)
        fail('PAYMENT_PENDING', {
          amount_halalas: t.fee_halalas,
          allowed_methods: event?.allowed_payment_methods,
        });
      if (pay.amount_halalas !== t.fee_halalas)
        fail('PAYMENT_AMOUNT_MISMATCH', { amount_halalas: t.fee_halalas });
      if (!(event?.allowed_payment_methods ?? []).includes(pay.method)) fail('PAYMENT_METHOD_NOT_ALLOWED');
    } else if (pay) fail('PAYMENT_ALREADY_RECORDED');
    let payment = null;
    if (pay) {
      const p = {
        id: uuid(),
        ticket_id: t.id,
        method: pay.method,
        amount_halalas: pay.amount_halalas,
        pos_reference: pay.pos_reference ?? null,
        collected_by: u.id,
        collected_at: now(),
      };
      w().payments.push(p);
      t.payment_status = 'collected';
      payment = paymentView(t);
    }
    if (t.claim) t.claim.consumed_at = now();
    custody(t, 'vehicle', { type: 'customer', id: null }, 'handover', u, task);
    custody(t, 'key', { type: 'customer', id: null }, 'handover', u, task);
    t.status = 'delivered';
    t.delivered_by = u.id;
    t.delivered_at = now();
    t.version += 1;
    task.status = 'completed';
    task.completed_at = now();
    task.version += 1;
    const cycle = openCycle(t);
    if (cycle) {
      cycle.delivered_at = now();
      cycle.delivered_by = u.id;
      cycle.outcome = 'delivered';
      cycle.closed_at = now();
    }
    const driver = settleDriver(u);
    return ok({ ticket: ticketDetail(t, u), cycle: cycleView(cycle), payment, driver });
  });

  s.on('POST /v1/tickets/:ticketId/handover-code/resend', (ctx) => {
    s.need(ctx, 'handover.resend_code');
    const t = ticketIn(ctx);
    if (t.status !== 'ready') fail('HANDOVER_NOT_READY');
    if (t.channel !== 'whatsapp') fail('WA_NOT_LINKED');
    if (t.claim?.locked_at) fail('HANDOVER_CODE_LOCKED', { locked_at: t.claim.locked_at });
    if (t.claim && t.claim.resend_no >= t.claim.max_resends) fail('RESEND_LIMIT_REACHED');
    issueCode(t);
    return ok(claimView(t));
  });
}
