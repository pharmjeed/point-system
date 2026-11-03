/**
 * The driver's field routes of the fake backend (07 §2.1–§2.3): home, duty, device checks, intake, photos
 * (with a fake presigned object storage), parking, a small dispatch engine (oldest request first, single
 * offer to the longest-idle available driver, broadcast when nobody is free, first accept wins, one
 * reserved next task), retrieval steps and handover. Errors are the 07/08 codes with their 08 texts.
 * Test code only — the real rules live in packages/server (S2) and are checked there.
 */
import { randomInt } from 'node:crypto';
import { fail, fakeNowMs, ok, page, uuid, validation, type Reply } from './http';
import type { FCycle, FLinkCode, FMedia, FOffer, FTask, FTicket, FUser } from './model';
import { effectiveSettings, normalizePhone } from './routesSetup';
import { STORAGE_PREFIX, type Ctx, type FakeServer } from './server';
import { assignmentView, driverState, dutyView, mask, openDuty, userRef } from './views';

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
const TICKET_STATUSES: readonly string[] = [
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'delivered',
  'reparking',
  'voided',
];
/** Paper serials and key tags as the API stores them: trimmed, Latin digits, upper case, spaces collapsed. */
const normalizeTag = (s: string) =>
  s
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, ' ')
    .toUpperCase();
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
          sent_status: s.whatsapp.codeStatus.get(t.id) ?? 'sent',
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
    const task = openTask(t);
    // as the API's loadTicketDetail: the minimal projection adds the vehicle, the parking time, an early
    // request and the open task (its assignee for staff and the assignee only) — 09 §5.1
    const base = {
      ...ticketSummary(t),
      vehicle_detail: { make: t.vehicle_make, model: t.vehicle_model, color: t.vehicle_color, type: null },
      parked_at: t.parked_at,
      pending_retrieval_at: t.pending_retrieval_at,
      open_task: task
        ? {
            ...taskView(task),
            assignee:
              viewer && (viewer.role !== 'driver' || task.assignee_id === viewer.id)
                ? userRef(user(task.assignee_id))
                : null,
          }
        : null,
    };
    if (!fullFor(t, viewer)) return { ...base, projection: 'minimal' };
    const spot = w().spots.find((x) => x.id === t.spot_id);
    const slot = w().slots.find((x) => x.id === t.key_slot_id);
    // the 09 §5.1 allow-list of the S2 views: the retrieval assignee never sees the stub number (the server
    // matches it at handover); the fee is for staff and the retrieval assignee only
    const staff = viewer?.role !== 'driver';
    const creatorIntake = t.created_by === viewer?.id && (t.status === 'received' || t.status === 'parking');
    const retrieveAssignee = task?.type === 'retrieve' && task.assignee_id === viewer?.id;
    return {
      ...base,
      projection: 'full',
      vehicle_detail: { make: t.vehicle_make, model: t.vehicle_model, color: t.vehicle_color, type: null },
      customer: t.customer_phone
        ? {
            phone_masked: mask(t.customer_phone),
            consent: null,
            opted_out: s.whatsapp.optedOut.has(t.customer_phone),
          }
        : null,
      wa_link_pending: pendingView(t),
      ...(staff || creatorIntake ? { paper_serial: t.paper_serial } : {}),
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
      ...(staff || retrieveAssignee ? { fee_halalas: t.fee_halalas } : {}),
      payment: paymentView(t),
      payment_waiver_reason: null,
      claim_code: claimView(t),
      media: w()
        .media.filter((m) => m.ticket_id === t.id && m.upload_status !== 'deleted')
        .map(mediaView),
      // the people of the ticket: staff only (as the API, 09 §5.1)
      ...(staff
        ? {
            created_by: userRef(user(t.created_by)),
            parked_by: userRef(user(t.parked_by)),
            retrieved_by: userRef(user(t.retrieved_by)),
            delivered_by: userRef(user(t.delivered_by)),
          }
        : {}),
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
      waiting_seconds: cycle ? Math.round((fakeNowMs() - Date.parse(cycle.requested_at)) / 1000) : null,
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

  // ---------------------------------------------------------------- WhatsApp (12 §7, simplified)

  const codesOf = (t: FTicket) => s.whatsapp.linkCodes.filter((l) => l.ticket_id === t.id);
  /** The live code waiting for «هل هو جوال العميل الذي أمامك؟» (masked number only, 09 §5.1). */
  function pendingView(t: FTicket) {
    const l = codesOf(t).find((x) => x.status === 'pending_confirmation');
    return l
      ? {
          link_code_id: l.id,
          inbound_phone_masked: l.inbound_phone ? mask(l.inbound_phone) : '',
          received_at: l.received_at ?? l.created_at,
        }
      : null;
  }
  const revokeCodes = (t: FTicket, reason: string, statuses: FLinkCode['status'][] = ['active']) => {
    for (const l of codesOf(t))
      if (statuses.includes(l.status)) {
        l.status = 'revoked';
        l.revoke_reason = reason;
      }
  };
  const CODE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';
  const newCode = () =>
    Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join('');
  const qrView = (l: FLinkCode) => {
    const url = `https://wa.me/966500000000?text=${encodeURIComponent(l.code)}`;
    return {
      link_code_id: l.id,
      code: l.code,
      status: l.status,
      expires_at: l.expires_at,
      wa_me_url: url,
      prefilled_text: l.code,
      qr_text: url,
    };
  };
  /** Ticket events whose creator hears about them in any ticket status (realtime-rules CREATOR_EVENTS). */
  const CREATOR_EVENTS = new Set([
    'ticket.created',
    'ticket.intake_submitted',
    'ticket.wa_link_changed',
    'ticket.customer_phone_changed',
    'ticket.inspection_completed',
    'ticket.voided',
  ]);
  /**
   * `ticket.updated` as the API's coalescer sends it (07 §4.3, notifications ticket-updates.ts): to the
   * privileged drivers — the creator for a creator event, a W-01 state or while the ticket is in intake, and
   * the open task's assignee — with `wa_link_pending` while a message waits (left out otherwise) and the W-01
   * / W-05 `message` state.
   */
  const publishTicket = (t: FTicket, cause: string, extra: Record<string, unknown> = {}) => {
    const message = extra.message as { purpose?: string } | undefined;
    const creator =
      CREATOR_EVENTS.has(cause) ||
      (cause === 'wa.message_status_changed' && message?.purpose === 'W-01') ||
      t.status === 'received' ||
      t.status === 'parking';
    const targets = new Set(
      [creator ? t.created_by : null, openTask(t)?.assignee_id].filter((x): x is string => !!x),
    );
    const pending = pendingView(t);
    for (const userId of targets)
      s.realtime.sendTo(
        userId,
        s.realtime.envelope(
          'ticket.updated',
          { cause, ...ticketSummary(t), ...(pending ? { wa_link_pending: pending } : {}), ...extra },
          { aggregate: { type: 'ticket', id: t.id, version: t.version }, venueId: t.venue_id },
        ),
      );
  };
  s.whatsapp = {
    health: 'healthy',
    templateApproved: true,
    qrTtlMs: null,
    optedOut: new Set<string>(),
    linkCodes: [],
    codeStatus: new Map(),
    customerSends(ticketId, phoneE164) {
      const t = w().tickets.find((x) => x.id === ticketId) as FTicket;
      const l = codesOf(t).find((x) => x.status === 'active');
      if (!l) throw new Error('fake whatsapp: no active link code');
      l.status = 'pending_confirmation';
      l.inbound_phone = phoneE164;
      l.received_at = now();
      t.wa_link_status = 'pending_confirmation';
      t.version += 1;
      publishTicket(t, 'ticket.wa_link_changed');
    },
    expireCode(ticketId) {
      const t = w().tickets.find((x) => x.id === ticketId) as FTicket;
      const l = codesOf(t).find((x) => x.status === 'active' || x.status === 'pending_confirmation');
      if (!l) throw new Error('fake whatsapp: no live link code');
      const waited = l.status === 'pending_confirmation';
      l.status = 'expired';
      l.expires_at = now();
      if (waited && t.wa_link_status === 'pending_confirmation') {
        t.wa_link_status = 'none';
        t.version += 1;
        publishTicket(t, 'ticket.wa_link_changed');
      }
    },
    w01(ticketId, result) {
      const t = w().tickets.find((x) => x.id === ticketId) as FTicket;
      t.wa_link_status = result;
      t.version += 1;
      publishTicket(t, 'ticket.wa_link_changed');
    },
    w05(ticketId, status) {
      const t = w().tickets.find((x) => x.id === ticketId) as FTicket;
      s.whatsapp.codeStatus.set(ticketId, status);
      // a message state does not move the ticket's version (07 §4.3 `message`)
      if (status !== 'skipped')
        publishTicket(t, 'wa.message_status_changed', {
          message: { id: uuid(), purpose: 'W-05', status, status_rank: status === 'failed' ? 9 : 2 },
        });
    },
    optOut(phoneE164) {
      s.whatsapp.optedOut.add(phoneE164);
      for (const t of w().tickets)
        if (t.customer_phone === phoneE164 && isOpen(t)) {
          t.wa_link_status = 'opted_out';
          t.version += 1;
          publishTicket(t, 'ticket.wa_link_changed');
        }
    },
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
      expires_at: mode === 'single' ? new Date(fakeNowMs() + ttl * 1000).toISOString() : null,
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
      if (fakeNowMs() <= Date.parse(o.expires_at) + grace) continue;
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
      waiting_seconds: cycle ? Math.round((fakeNowMs() - Date.parse(cycle.requested_at)) / 1000) : 0,
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

  // ---------------------------------------------------------------- live views (the realtime hub)

  s.liveView = (userId: string) => {
    const u = user(userId);
    const duty = openDuty(s, userId);
    const mine = w().tasks.filter((k) => k.assignee_id === userId);
    const live = mine.filter((k) => ['accepted', 'in_progress', 'assigned_waiting'].includes(k.status));
    return {
      offer: u && duty?.status === 'on_duty' ? (offerFor(u) as never) : null,
      tasks: u ? (live.map((k) => taskCard(k, u)) as never[]) : [],
      driverState: driverState(s, userId),
      poolId: duty?.dispatch_pool_id ?? null,
      venueId: duty?.venue_id ?? null,
    };
  };
  s.taskCardOf = (taskId: string, viewerId: string) => {
    const k = w().tasks.find((x) => x.id === taskId);
    const u = user(viewerId);
    return k && u ? (taskCard(k, u) as never) : null;
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
    // as the API: open and closing events (retrievals go on while an event closes; intakes need `open`)
    const openEvents = w().events.filter(
      (e) => e.venue_id === venue.id && (e.status === 'open' || e.status === 'closing'),
    );
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
        push_enabled: !!device?.push_subscription,
        pwa_installed: device?.display_mode === 'standalone',
      },
      channel_health: s.whatsapp.health,
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
      push_subscribed: !!d.push_subscription,
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
    if (ctx.body?.push_subscription === null) d.push_subscription = null;
    else if (ctx.body?.push_subscription) {
      const sub = ctx.body.push_subscription;
      // 07: the three fields together (ck_devices_push_triplet)
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth)
        validation([{ field: 'push_subscription', issue: 'invalid' }]);
      d.push_subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      };
    }
    return ok(deviceView(d.id));
  });

  // `POST /v1/me/heartbeat`: the HTTP fallback of client.heartbeat (07 §4.4), not a command with a key
  s.on('POST /v1/me/heartbeat', (ctx) => {
    s.need(ctx, 'auth.self');
    if (typeof ctx.body?.visible !== 'boolean') validation([{ field: 'visible', issue: 'required' }]);
    return ok({ server_time: now(), connection_state: 'online', sync_required: false });
  });

  // `POST /v1/telemetry` (15 §9): batches of client measurements, 202 without a body; not a command (DEC-149)
  s.on('POST /v1/telemetry', (ctx) => {
    const u = s.need(ctx, 'auth.self');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.events) || !body.events.length || body.events.length > 50)
      validation([{ field: 'events', issue: 'invalid' }]);
    if (typeof body.app_version !== 'string') validation([{ field: 'app_version', issue: 'required' }]);
    s.telemetry.push({ userId: u.id, body });
    return { status: 202, body: undefined };
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
      // details as the API's normalizePlate (08: field + reason)
      if (!/^[0-9]{1,4}$/.test(digits)) fail('PLATE_INVALID', { field: 'plate.digits', reason: 'digits' });
      if (letters.length !== 3 || letters.some((l) => !(l in PLATE_EN)))
        fail('PLATE_INVALID', { field: 'plate.letters_ar', reason: 'letters' });
      const derived = letters.map((l) => PLATE_EN[l]).join('');
      if (plate?.letters_en != null && String(plate.letters_en).replace(/\s+/g, '').toUpperCase() !== derived)
        fail('PLATE_INVALID', { field: 'plate.letters_en', reason: 'mapping' });
      t.plate_country = 'SA';
      t.plate_digits = digits;
      t.plate_letters_ar = letters.join(' ');
      t.plate_letters_en = letters.map((l) => PLATE_EN[l]).join(' ');
      t.plate_raw = null;
    } else {
      const raw = String(plate?.raw ?? '').trim();
      if (!raw || raw.length > 20) fail('PLATE_INVALID', { field: 'plate.raw', reason: 'raw' });
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
      const serial = b.paper_serial ? normalizeTag(String(b.paper_serial)) : null;
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
      const tag = b.key_tag ? normalizeTag(String(b.key_tag)) : null;
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
    if ('consent' in b && b.consent && !next.customer_phone)
      validation([{ field: 'consent', issue: 'customer_phone_required' }]);
    if (b.channel === 'paper' && t.channel !== 'paper') {
      // the live codes go (`channel_paper`); a linked customer keeps WhatsApp (11 §2.6, DEC-40)
      if (t.wa_link_status === 'linked')
        fail('INVALID_STATE_TRANSITION', { current_status: t.status, reason: 'ticket_linked' });
      revokeCodes(t, 'channel_paper', ['active', 'pending_confirmation']);
      next.wa_link_status = 'none';
    }
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
          expires_at: new Date(fakeNowMs() + 300_000).toISOString(),
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
      expires_at: new Date(fakeNowMs() + 300_000).toISOString(),
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
    // as the API: a WhatsApp draft without a number needs a live or confirmed QR code (07 submit-intake)
    const qr = codesOf(t).some((l) => ['active', 'pending_confirmation', 'consumed'].includes(l.status));
    if (t.channel === 'paper' && !t.paper_serial) missing.push('paper_serial');
    if (t.channel === 'whatsapp' && !t.customer_phone && !qr && t.wa_link_status !== 'linked')
      missing.push('customer_phone');
    if (missing.length) fail('INTAKE_INCOMPLETE', { missing });
    const direct = t.channel === 'whatsapp' && !!t.customer_phone && t.wa_link_status !== 'linked' && !qr;
    if (direct) {
      if (!t.consent) fail('CONSENT_REQUIRED', { field: 'consent' });
      if (s.whatsapp.optedOut.has(t.customer_phone as string)) fail('WA_CUSTOMER_OPTED_OUT');
    }
    const photos = missingPhotos(t);
    if (photos.length && ctx.body?.acknowledge_incomplete_inspection !== true)
      fail('INSPECTION_INCOMPLETE', { missing: photos });
    if (direct && !s.whatsapp.templateApproved)
      fail('WA_TEMPLATE_NOT_APPROVED', { template_name: 'w01', template_status: 'pending' });
    t.inspection_status = photos.length ? 'incomplete' : 'complete';
    t.status = 'parking';
    t.submitted_at = now();
    if (direct) t.wa_link_status = 'pending_send'; // W-01 planned (the provider answers later: whatsapp.w01)
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

  // ---------------------------------------------------------------- WhatsApp link (07 §2.2, 12 §7.1–§7.2)

  const QR_STATUSES = ['received', 'parking', 'parked'];
  const QR_FROM = ['none', 'failed', 'opted_out', 'pending_send'];
  s.on('POST /v1/tickets/:ticketId/whatsapp-link', (ctx) => {
    const u = s.need(ctx, 'wa.link');
    const t = ticketIn(ctx);
    if (u.role === 'driver' && onDuty(u).venue_id !== t.venue_id) fail('DUTY_REQUIRED');
    if (!isOpen(t)) fail('TICKET_CLOSED', { ticket_status: t.status });
    const method = ctx.body?.method;
    if (method !== 'direct' && method !== 'qr')
      validation([{ field: 'method', issue: 'invalid_enum_value' }]);
    if (t.channel !== 'whatsapp')
      fail('INVALID_STATE_TRANSITION', { current_status: t.status, reason: 'paper_channel' });
    if (s.whatsapp.health === 'down') fail('WA_CHANNEL_UNAVAILABLE', { health_status: 'down', since: null });
    if (method === 'direct') {
      const reason =
        t.status === 'received'
          ? 'submit_intake_links_directly'
          : t.wa_link_status === 'linked'
            ? 'already_linked'
            : t.wa_link_status === 'pending_confirmation'
              ? 'qr_pending_confirmation'
              : null;
      if (reason) fail('INVALID_STATE_TRANSITION', { current_status: t.status, reason });
      if (!t.customer_phone) fail('PHONE_INVALID', { field: 'customer_phone', issue: 'missing' });
      if (s.whatsapp.optedOut.has(t.customer_phone) || t.wa_link_status === 'opted_out')
        fail('WA_CUSTOMER_OPTED_OUT');
      if (!t.consent) fail('WA_CONSENT_MISSING');
      if (!s.whatsapp.templateApproved)
        fail('WA_TEMPLATE_NOT_APPROVED', { template_name: 'w01', template_status: 'pending' });
      revokeCodes(t, 'linked_direct');
      t.wa_link_status = 'pending_send';
      t.version += 1;
      return ok({ method, wa_link_status: t.wa_link_status, channel_health: s.whatsapp.health, qr: null });
    }
    if (!QR_STATUSES.includes(t.status))
      fail('INVALID_STATE_TRANSITION', { current_status: t.status, allowed: QR_STATUSES });
    if (!QR_FROM.includes(t.wa_link_status))
      fail('INVALID_STATE_TRANSITION', {
        current_status: t.status,
        reason: t.wa_link_status === 'linked' ? 'already_linked' : 'qr_pending_confirmation',
      });
    revokeCodes(t, 'regenerated');
    const ttl = Number(settingsOf(t.venue_id).link?.qr_ttl_min ?? 10);
    const code: FLinkCode = {
      id: uuid(),
      ticket_id: t.id,
      code: newCode(),
      status: 'active',
      created_by: u.id,
      created_at: now(),
      expires_at: new Date(fakeNowMs() + (s.whatsapp.qrTtlMs ?? ttl * 60_000)).toISOString(),
      inbound_phone: null,
      received_at: null,
      revoke_reason: null,
    };
    s.whatsapp.linkCodes.push(code);
    // the link status and the ticket's version do not change until the customer's message arrives
    return ok({
      method,
      wa_link_status: t.wa_link_status,
      channel_health: s.whatsapp.health,
      qr: qrView(code),
    });
  });

  s.on('POST /v1/tickets/:ticketId/whatsapp-link/confirm', (ctx) => {
    const u = s.need(ctx, 'wa.link');
    const t = ticketIn(ctx);
    const b = ctx.body ?? {};
    if (typeof b.link_code_id !== 'string' || typeof b.matches !== 'boolean')
      validation([{ field: 'matches', issue: 'required' }]);
    const l = codesOf(t).find((x) => x.id === b.link_code_id);
    if (!l) return fail('RESOURCE_NOT_FOUND', { resource: 'link_code' });
    if (u.role === 'driver' && l.created_by !== u.id)
      fail('PERMISSION_DENIED', { permission: 'wa.link', reason: 'not_link_code_creator' });
    if (!isOpen(t)) fail('INVALID_STATE_TRANSITION', { current_status: t.status, reason: 'ticket_closed' });
    const expired =
      l.status === 'expired' ||
      (['active', 'pending_confirmation'].includes(l.status) && fakeNowMs() >= Date.parse(l.expires_at));
    if (expired) fail('WA_LINK_CODE_EXPIRED', { expired_at: l.expires_at });
    if (l.status !== 'pending_confirmation')
      fail('INVALID_STATE_TRANSITION', { current_status: l.status, allowed: ['pending_confirmation'] });
    if (b.matches) {
      // the sender becomes the ticket's customer with the consent of his own message and the ticket is
      // linked; W-01 is planned (12 §7.2 steps 5–6, link-service confirmQrLink)
      l.status = 'consumed';
      t.customer_phone = l.inbound_phone;
      t.consent = true;
      t.wa_link_status = 'linked';
    } else {
      l.status = 'revoked';
      l.revoke_reason = 'driver_rejected_match';
      t.wa_link_status = 'none';
    }
    t.version += 1;
    return ok(ticketDetail(t, u));
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

  /**
   * 07 `POST /v1/retrieval-cycles/{cycleId}/cancel` before any movement: the driver only while the request is
   * not assigned (`requested`; afterwards INVALID_STATE_TRANSITION `driver_cancel_after_assignment`), the
   * supervisor up to `assigned_waiting` (the after-movement repark of DEC-30 is the API's, not modelled here).
   */
  s.on('POST /v1/retrieval-cycles/:cycleId/cancel', (ctx) => {
    const u = s.need(ctx, 'retrieval.cancel');
    const cycle = w().cycles.find((c) => c.id === ctx.params.cycleId);
    const t = cycle ? w().tickets.find((x) => x.id === cycle.ticket_id) : undefined;
    if (!cycle || !t || !s.inScope(u, t.venue_id)) return fail('RESOURCE_NOT_FOUND');
    const reason = typeof ctx.body?.reason === 'string' ? ctx.body.reason.trim() : '';
    if (reason.length < 3) fail('REASON_REQUIRED');
    if (u.role === 'driver') onDuty(u);
    if (cycle.closed_at || !isOpen(t)) fail('INVALID_STATE_TRANSITION', { current_status: t.status });
    if (u.role === 'driver' && t.status !== 'requested')
      fail('INVALID_STATE_TRANSITION', {
        current_status: t.status,
        reason: 'driver_cancel_after_assignment',
      });
    state(t.status, ['requested', 'assigned', 'assigned_waiting']);
    const task = w().tasks.find(
      (k) =>
        k.cycle_id === cycle.id && k.type === 'retrieve' && !['completed', 'canceled'].includes(k.status),
    );
    if (task) {
      task.status = 'canceled';
      task.canceled_at = now();
      task.cancel_reason = u.role === 'driver' ? 'customer_field_cancel' : 'supervisor_cancel';
      task.version += 1;
      for (const o of w().offers)
        if (o.task_id === task.id && o.status === 'active') {
          o.status = 'revoked';
          o.close_reason = 'task_canceled';
          o.version += 1;
        }
    }
    cycle.outcome = 'canceled';
    cycle.closed_at = now();
    t.status = 'parked';
    t.version += 1;
    return ok({ ticket: ticketSummary(t), cycle: cycleView(cycle) });
  });

  /**
   * 07 `GET /v1/tickets` (D-12): a driver gets the open tickets of his venue only, minimal projection, newest
   * first; `q` = digits matched against the plate digits or the ticket number; `status` = comma list; cursor
   * pages (opaque offsets here).
   */
  s.on('GET /v1/tickets', (ctx) => {
    const u = s.need(ctx, 'ticket.read_minimal');
    const driver = u.role === 'driver';
    if (driver && !s.activeAssignment(u.id)) fail('ASSIGNMENT_REQUIRED');
    const venueId = ctx.query.get('venue_id');
    if (venueId && !s.inScope(u, venueId)) fail('SCOPE_VENUE_DENIED', { venue_id: venueId });
    const statusParam = ctx.query.get('status');
    const statuses = statusParam
      ? statusParam
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : null;
    if (statuses?.some((x) => !TICKET_STATUSES.includes(x)))
      validation([{ field: 'status', issue: 'invalid_enum_value' }]);
    const openOnly = driver || ctx.query.get('open_only') !== 'false';
    const eventId = ctx.query.get('event_id');
    const q = ctx.query.get('q');
    const digits = q ? normalizeTag(q).replace(/\D/g, '') : '';
    if (q && !digits) return page([]);
    const limit = Math.min(200, Math.max(1, Number(ctx.query.get('limit') ?? 50) || 50));
    const scope = venueId ? [venueId] : s.venueIdsInScope(u);
    // ties on created_at (same millisecond) go to the later insert: the server's UUIDv7 ids sort by time, the fake's
    // random ids do not
    const inserted = new Map(w().tickets.map((t, i) => [t.id, i]));
    const rows = w()
      .tickets.filter((t) => scope.includes(t.venue_id))
      .filter((t) => !eventId || t.event_id === eventId)
      .filter((t) => !statuses || statuses.includes(t.status))
      .filter((t) => !openOnly || isOpen(t))
      .filter(
        (t) => !digits || (t.plate_digits ?? '').includes(digits) || String(t.display_number) === digits,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || inserted.get(b.id)! - inserted.get(a.id)!);
    const cursor = ctx.query.get('cursor');
    let start = 0;
    if (cursor) {
      const m = /^tickets:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!m) return fail('PAGINATION_CURSOR_INVALID');
      start = Number(m[1]);
    }
    const next =
      start + limit < rows.length ? Buffer.from(`tickets:${start + limit}`).toString('base64url') : null;
    return page(rows.slice(start, start + limit).map(ticketSummary), next);
  });

  /**
   * 07 `PATCH /v1/tickets/{ticketId}/customer-phone` (PNT-049): the creator or the assignee of an open task,
   * on duty; a WhatsApp ticket after the intake; a new verbal consent and a reason; `link_version + 1` →
   * `pending_send` (W-01 to the new number).
   */
  s.on('PATCH /v1/tickets/:ticketId/customer-phone', (ctx) => {
    const u = s.need(ctx, 'ticket.change_phone');
    const t = ticketIn(ctx);
    if (u.role === 'driver') {
      onDuty(u);
      if (
        t.created_by !== u.id &&
        !w().tasks.some(
          (k) =>
            k.ticket_id === t.id && k.assignee_id === u.id && !['completed', 'canceled'].includes(k.status),
        )
      )
        fail('PERMISSION_DENIED', { permission: 'ticket.change_phone', reason: 'not_creator_or_assignee' });
    }
    if (!isOpen(t)) fail('TICKET_CLOSED', { ticket_status: t.status });
    const b = ctx.body ?? {};
    s.checkVersion('ticket', t, b.expected_version);
    if (t.status === 'received' || t.channel !== 'whatsapp')
      fail('INVALID_STATE_TRANSITION', { current_status: t.status });
    const phone = normalizePhone(String(b.customer_phone ?? ''));
    if (!phone) fail('PHONE_INVALID', { field: 'customer_phone' });
    if (b.consent?.confirmed !== true) fail('CONSENT_REQUIRED');
    if (typeof b.reason !== 'string' || b.reason.trim().length < 3) fail('REASON_REQUIRED');
    t.customer_phone = phone;
    t.consent = true;
    t.wa_link_status = 'pending_send';
    t.version += 1;
    return ok(ticketDetail(t, u));
  });

  /** 07 `POST /v1/incidents` (the driver's D-10 / D-13 report): stored for the specs to read. */
  s.on('POST /v1/incidents', (ctx) => {
    const u = s.need(ctx, 'incident.create');
    const b = ctx.body ?? {};
    s.needVenue(ctx, String(b.venue_id ?? ''));
    // DEC-237: a driver reports on an open ticket of his venue
    if (u.role === 'driver' && !b.ticket_id)
      validation([{ field: 'ticket_id', issue: 'required_for_driver' }]);
    const ticket = b.ticket_id
      ? w().tickets.find((t) => t.id === b.ticket_id && s.inScope(u, t.venue_id))
      : undefined;
    if (b.ticket_id && (!ticket || (u.role === 'driver' && !isOpen(ticket)))) fail('TICKET_NOT_FOUND');
    if (typeof b.description !== 'string' || b.description.trim().length < 3)
      validation([{ field: 'description', issue: 'too_short' }]);
    const incident = {
      id: uuid(),
      venue_id: b.venue_id,
      event_id: b.event_id ?? null,
      ticket_id: b.ticket_id ?? null,
      type: b.type,
      severity: b.severity ?? 'medium',
      status: 'open',
      description: b.description.trim(),
      reported_by: userRef(u),
      created_at: now(),
      version: 1,
    };
    s.incidents.push(incident);
    return ok(incident, 201);
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
    // the server's strict body: key_slot_id is a uuid (a "" or a missing id is VALIDATION_FAILED, not custody)
    const slotId: unknown = ctx.body?.key_slot_id;
    if (typeof slotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(slotId))
      validation([{ field: 'key_slot_id', issue: slotId === undefined ? 'required' : 'invalid_format' }]);
    if (slotId !== t.key_slot_id) fail('CUSTODY_HOLDER_MISMATCH');
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
    // as the API (use-cases/movement.ts markReady): a code for a linked WhatsApp ticket only; any other
    // WhatsApp ticket is verified by the supervisor (`supervisor_exception`)
    if (t.channel === 'whatsapp' && t.wa_link_status === 'linked') issueCode(t);
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
      expires_at: new Date(fakeNowMs() + Number(h.code_ttl_min ?? 30) * 60_000).toISOString(),
      locked_at: null,
      consumed_at: null,
      resend_no: (t.claim?.resend_no ?? -1) + 1,
      max_resends: Number(h.max_resends ?? 3),
    };
  };

  /** Wrong paper stubs per retrieval cycle (the API counts them from `ticket_events`, DEC-PROPOSED-8). */
  const stubTries = new Map<string, { n: number; locked_at: string | null }>();

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
    // the API's order (s2-backend notes, DEC-PROPOSED-9): the payment gate before the verification, so a kept
    // wrong attempt never coexists with a payment effect. The fake takes the inline collection of PNT-080.
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
    } else if (pay) {
      if (t.payment_status === 'not_required') validation([{ field: 'payment', issue: 'not_applicable' }]);
      fail('PAYMENT_ALREADY_RECORDED');
    }
    const v = ctx.body?.verification ?? {};
    if (v.method === 'paper_stub') {
      if (t.channel !== 'paper') validation([{ field: 'verification.method', issue: 'not_applicable' }]);
      // stub attempts count against handover.max_attempts per cycle, kept although the reply is an error
      const cycleId = openCycle(t)?.id ?? t.id;
      const tries = stubTries.get(cycleId) ?? { n: 0, locked_at: null as string | null };
      stubTries.set(cycleId, tries);
      if (tries.locked_at) fail('HANDOVER_CODE_LOCKED', { locked_at: tries.locked_at });
      if (normalizeTag(String(v.paper_serial ?? '')) !== t.paper_serial) {
        tries.n += 1;
        const max = Number(settingsOf(t.venue_id).handover?.max_attempts ?? 5);
        if (tries.n >= max) {
          tries.locked_at = now();
          fail('HANDOVER_CODE_LOCKED', { locked_at: tries.locked_at });
        }
        fail('PAPER_STUB_MISMATCH', { attempts_left: max - tries.n });
      }
    } else if (v.method === 'code') {
      const c = t.claim;
      // no code for the cycle (not linked at `ready`): the code method does not apply (claim-codes verify)
      if (!c) validation([{ field: 'verification.method', issue: 'not_applicable' }]);
      if (c.consumed_at) fail('HANDOVER_CODE_CONSUMED');
      if (c.locked_at) fail('HANDOVER_CODE_LOCKED', { locked_at: c.locked_at });
      if (fakeNowMs() > Date.parse(c.expires_at)) fail('HANDOVER_CODE_EXPIRED');
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
    const u = s.need(ctx, 'handover.resend_code');
    const t = ticketIn(ctx);
    if (t.status !== 'ready') fail('HANDOVER_NOT_READY');
    const task = w().tasks.find(
      (k) => k.ticket_id === t.id && k.type === 'retrieve' && k.status === 'in_progress',
    );
    if (u.role === 'driver' && task?.assignee_id !== u.id) fail('NOT_TASK_ASSIGNEE');
    // as the API: the opt-out before the link, the channel, the lock (a supervisor reissues a locked code,
    // DEC-207), the limit (08 §4.12–§4.13); a cycle without a code gets its first one
    if (
      t.channel === 'whatsapp' &&
      (t.wa_link_status === 'opted_out' || (t.customer_phone && s.whatsapp.optedOut.has(t.customer_phone)))
    )
      fail('WA_CUSTOMER_OPTED_OUT');
    if (t.channel !== 'whatsapp' || t.wa_link_status !== 'linked' || !t.customer_phone)
      fail('WA_NOT_LINKED', { wa_link_status: t.wa_link_status });
    if (s.whatsapp.health === 'down') fail('WA_CHANNEL_UNAVAILABLE', { health_status: 'down', since: null });
    if (t.claim?.locked_at && !t.claim.consumed_at && u.role === 'driver')
      fail('HANDOVER_CODE_LOCKED', { locked_at: t.claim.locked_at });
    if (t.claim && t.claim.resend_no >= t.claim.max_resends) fail('RESEND_LIMIT_REACHED');
    issueCode(t);
    s.whatsapp.codeStatus.delete(t.id); // a new W-05 on its way
    // 14 §3.4 handover.code_issued: the code's state changed, the ticket's version did not
    publishTicket(t, 'handover.code_issued');
    return ok(claimView(t));
  });
}
