import type { Page, Request, Route } from '@playwright/test';
import { errorMessagesAr } from '../../src/i18n/errors';

/**
 * In-browser API mock for e2e (the backend is not part of these tests). Every /v1 request is answered by
 * a handler keyed "METHOD /path"; unhandled requests fail loudly with 501 so a missing mock is visible.
 * Envelopes follow 07 §1.6; error texts are the 08 texts (what the real server sends as message_ar).
 */
export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: Request) => Reply | 'abort' | Promise<Reply | 'abort'>;

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const meta = () => ({
  request_id: `req_${Math.random().toString(36).slice(2, 10)}`,
  server_time: new Date().toISOString(),
});

export const ok = (data: unknown, status = 200): Reply => ({
  status,
  body: status === 204 ? undefined : { data, meta: meta() },
});

const RETRYABLE = new Set([
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'DEPENDENCY_TIMEOUT',
  'INTERNAL_ERROR',
]);

export function apiError(
  code: keyof typeof errorMessagesAr,
  status: number,
  options: { details?: Record<string, unknown>; message_ar?: string; headers?: Record<string, string> } = {},
): Reply {
  return {
    status,
    headers: options.headers,
    body: {
      error: {
        code,
        message: code,
        message_ar: options.message_ar ?? errorMessagesAr[code],
        request_id: `req_e2e_${code}`,
        retryable: RETRYABLE.has(code),
        details: options.details ?? {},
      },
    },
  };
}

export class MockApi {
  readonly calls: Call[] = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(
    private readonly page: Page,
    public me: Record<string, unknown> | null = null,
  ) {
    this.on('GET', '/v1/me', () => (this.me ? ok(this.me) : apiError('AUTH_UNAUTHENTICATED', 401)));
    // the driver's snapshot (D-03/D-04) follows `me`; flows that need tasks use the stateful fake (./fake)
    this.on('GET', '/v1/me/home', () => {
      if (!this.me) return apiError('AUTH_UNAUTHENTICATED', 401);
      const home = homeFromMe(this.me);
      return home ? ok(home) : apiError('ASSIGNMENT_REQUIRED', 403);
    });
    this.on('POST', '/v1/auth/logout', () => {
      this.me = null;
      return ok(undefined, 204);
    });
    // the HTTP fallback of client.heartbeat while no socket is connected (07 §4.4)
    this.on('POST', '/v1/me/heartbeat', () =>
      ok({ server_time: new Date().toISOString(), connection_state: 'online', sync_required: false }),
    );
  }

  on(method: string, path: string, handler: Handler | Reply): this {
    this.handlers.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  /** Replies in order (a function runs when its turn comes, e.g. to change `me`); the last one repeats. */
  sequence(method: string, path: string, replies: Array<Reply | 'abort' | (() => Reply | 'abort')>): this {
    let i = 0;
    return this.on(method, path, () => {
      const reply = replies[Math.min(i++, replies.length - 1)] as Reply | 'abort' | (() => Reply | 'abort');
      return typeof reply === 'function' ? reply() : reply;
    });
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async install(): Promise<this> {
    // no realtime server in the static mock: `/ws` is refused at once (the screens poll; PNT-065)
    await this.page.routeWebSocket(
      (url) => url.pathname.startsWith('/ws'),
      (ws) => void ws.close({ code: 1011, reason: 'unavailable' }),
    );
    await this.page.route(
      (url) => url.pathname.startsWith('/ws'),
      (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":0}' }),
    );
    await this.page.route(
      (url) => url.pathname.startsWith('/v1/'),
      async (route: Route) => {
        const req = route.request();
        const url = new URL(req.url());
        const raw = req.postData();
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        this.calls.push({ method: req.method(), path: url.pathname, headers: await req.allHeaders(), body });
        const handler = this.handlers.get(`${req.method()} ${url.pathname}`);
        const reply = handler
          ? await handler(req)
          : { status: 501, body: { error: { code: 'NOT_MOCKED', message: url.pathname } } };
        if (reply === 'abort') return route.abort('internetdisconnected');
        await route.fulfill({
          status: reply.status,
          contentType: 'application/json',
          headers: reply.headers,
          body: reply.body === undefined ? '' : JSON.stringify(reply.body),
        });
      },
    );
    return this;
  }
}

// ---------------------------------------------------------------- fixtures (07_openapi.yaml `Me`)

const NOW = () => new Date().toISOString();

/** A `DriverHome` consistent with a `Me` fixture: one open event, an open shift, no tasks or offers. */
export function homeFromMe(me: Record<string, any>): Record<string, unknown> | null {
  const assignment = me.active_assignment;
  if (!assignment) return null;
  return {
    server_time: NOW(),
    user: { id: me.user.id, full_name: me.user.full_name, employee_code: me.user.employee_code },
    venue: { id: assignment.venue_id, code: 'RMS', name_ar: assignment.venue_name_ar },
    open_events: [{ id: 'evt-1', name_ar: 'حفل آل فلان', status: 'open' }],
    active_assignment: assignment,
    shift_open: true,
    duty_session: me.duty_session ?? null,
    driver_state: me.driver_state ?? 'off_duty',
    connection_state: me.duty_session ? 'online' : null,
    current_task: null,
    next_task: null,
    offer: null,
    draft_ticket_id: null,
    cash_outstanding_halalas: 0,
    checks: { audio_tested: false, push_enabled: false, pwa_installed: false },
    channel_health: 'healthy',
  };
}

export function driverMe(
  opts: { mustChange?: boolean; onDuty?: boolean; state?: string; venue?: string | null } = {},
) {
  const venue = opts.venue === undefined ? 'قاعة ريماس' : opts.venue;
  return {
    user: {
      id: '0193b6f2-0000-7000-8000-00000000d001',
      employee_code: 'D-0042',
      full_name: 'سعد الحربي',
      phone_masked: '05•••••567',
      role: 'driver',
      can_drive: false,
      status: 'active',
      mfa_enabled: false,
      must_change_secret: !!opts.mustChange,
      version: 3,
    },
    permissions: ['auth.self', 'duty.self', 'ticket.read_minimal'],
    scopes: [],
    active_assignment: venue
      ? {
          id: 'a1',
          driver_id: '0193b6f2-0000-7000-8000-00000000d001',
          venue_id: 'v-rms',
          venue_name_ar: venue,
          status: 'active',
          starts_at: NOW(),
        }
      : null,
    duty_session: opts.onDuty
      ? {
          id: 'ds1',
          user_id: '0193b6f2-0000-7000-8000-00000000d001',
          shift_id: 'sh1',
          venue_id: 'v-rms',
          dispatch_pool_id: 'p1',
          status: 'on_duty',
          started_at: NOW(),
          connection_state: 'online',
          version: 1,
        }
      : null,
    driver_state: opts.state ?? (opts.onDuty ? 'available' : 'off_duty'),
    session: { restricted: !!opts.mustChange, mfa_verified: false, expires_at: NOW() },
    brand: {},
  };
}

export function staffMe(
  opts: {
    role?: 'supervisor' | 'admin' | 'owner';
    mustChange?: boolean;
    restricted?: boolean;
    canDrive?: boolean;
  } = {},
) {
  const role = opts.role ?? 'admin';
  return {
    user: {
      id: '0193b6f2-0000-7000-8000-00000000a001',
      employee_code: 'A-0001',
      full_name: 'نورة القحطاني',
      role,
      can_drive: !!opts.canDrive,
      status: 'active',
      mfa_enabled: !opts.restricted,
      must_change_secret: !!opts.mustChange,
      version: 1,
    },
    permissions:
      role === 'supervisor' ? ['auth.self', 'ticket.read_full'] : ['auth.self', 'staff.manage', 'audit.read'],
    scopes: [
      {
        id: 's1',
        scope_type: role === 'supervisor' ? 'venue' : 'org',
        venue_id: role === 'supervisor' ? 'v-rms' : null,
      },
    ],
    active_assignment: null,
    duty_session: null,
    driver_state: null,
    session: {
      restricted: !!(opts.restricted || opts.mustChange),
      mfa_verified: !opts.restricted,
      // as the server sends it (DEC-82)
      pending: [...(opts.mustChange ? ['secret_change'] : []), ...(opts.restricted ? ['mfa_setup'] : [])],
    },
    brand: {},
  };
}

export const loginResult = (
  me: unknown,
  flags: Partial<{
    mfa_required: boolean;
    mfa_token: string;
    mfa_setup_required: boolean;
    must_change_secret: boolean;
  }> = {},
) => ok({ mfa_required: false, mfa_setup_required: false, must_change_secret: false, me, ...flags });

// ================================================================== staff screens (S-02…S-13)
// Appended for the supervisor/admin/owner screens (PNT-074…PNT-092): role fixtures with the canon §10
// permissions, one venue with an open event and its operations board, a ticket and its timeline, alerts,
// incidents, close/settlement data and the admin settings, and `mockStaffApi()` answering every read those
// screens make (each test overrides what it needs with `api.on`). Shapes follow 07_openapi.yaml.

type Json = Record<string, unknown>;

/** Canon §10 base grants (packages/shared ROLE_PERMISSIONS), as `/v1/me.permissions` sends them. */
export const ROLE_PERMISSIONS: Record<'owner' | 'admin' | 'supervisor', string[]> = {
  owner: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'event.manage',
    'shift.manage',
    'venue.read',
    'venue.manage',
    'venue.layout_read',
    'driver.read',
    'driver.manage',
    'driver.assign',
    'driver.transfer',
    'staff.manage',
    'alert.read',
    'alert.manage',
    'incident.read',
    'report.read',
    'export.create',
    'audit.read',
    'wa.channel_read',
    'wa.channel_manage',
    'wa.templates_manage',
    'outbox.manage',
    'retention.manage',
    'org.settings_manage',
    'telemetry.write',
  ],
  admin: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'ticket.change_phone',
    'ticket.void',
    'ticket.manual_reconcile',
    'payment.reverse',
    'cash.handover_confirm',
    'event.manage',
    'shift.manage',
    'venue.read',
    'venue.manage',
    'venue.layout_read',
    'driver.read',
    'driver.manage',
    'driver.assign',
    'driver.transfer',
    'staff.manage',
    'alert.read',
    'alert.manage',
    'incident.read',
    'incident.create',
    'incident.manage',
    'report.read',
    'export.create',
    'audit.read',
    'wa.channel_read',
    'wa.templates_manage',
    'outbox.manage',
    'telemetry.write',
  ],
  supervisor: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'ticket.change_phone',
    'ticket.void',
    'ticket.inspection_exception',
    'ticket.repark',
    'ticket.custody_transfer',
    'ticket.manual_reconcile',
    'wa.link',
    'retrieval.request_on_behalf',
    'retrieval.cancel',
    'task.release_custody',
    'task.reassign',
    'handover.resend_code',
    'handover.exception',
    'payment.reverse',
    'payment.waive',
    'cash.handover_confirm',
    'event.manage',
    'shift.manage',
    'duty.force_end',
    'venue.read',
    'venue.layout_read',
    'driver.read',
    'driver.assign',
    'driver.transfer',
    'alert.read',
    'alert.manage',
    'incident.read',
    'incident.create',
    'incident.manage',
    'report.read',
    'export.create',
    'telemetry.write',
  ],
};

export const VENUE_ID = 'v-rms';
export const OTHER_VENUE_ID = 'v-lyl';
export const EVENT_ID = 'e-rms-1';
export const STAFF_USER_ID = '0193b6f2-0000-7000-8000-00000000a001';

/** A staff `Me` with the full permission list of its role (canon §10); `remove`/`add` adjust it. */
export function roleMe(
  role: 'supervisor' | 'admin' | 'owner',
  opts: { add?: string[]; remove?: string[] } = {},
) {
  const me = staffMe({ role });
  const permissions = [...ROLE_PERMISSIONS[role], ...(opts.add ?? [])].filter(
    (p) => !(opts.remove ?? []).includes(p),
  );
  return {
    ...me,
    permissions,
    scopes:
      role === 'supervisor'
        ? [{ id: 's1', scope_type: 'venue', venue_id: VENUE_ID }]
        : [{ id: 's1', scope_type: 'org', venue_id: null }],
  };
}

/** An instant `seconds` before now (fixtures are built when the test runs, so waiting times are real). */
export const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

export const KHALID = { id: 'd-khalid', full_name: 'خالد العتيبي', employee_code: 'D-0011' };
export const SAAD = { id: 'd-saad', full_name: 'سعد الحربي', employee_code: 'D-0042' };
export const FAHAD = { id: 'd-fahad', full_name: 'فهد الدوسري', employee_code: 'D-0007' };

const PLATES: Record<number, [string, string, string]> = {
  39: ['7720', 'ح ط ى', 'H T Y'],
  44: ['3150', 'د ر س', 'D R S'],
  45: ['9081', 'ع ق ل', 'E G L'],
  47: ['4821', 'ر س ط', 'R S T'],
  50: ['1266', 'ب ن و', 'B N W'],
  51: ['5530', 'م ك ه', 'Z K X'],
  52: ['8804', 'ص د ع', 'S D E'],
  53: ['6402', 'ل ب ر', 'L B R'],
};

export function ticketFixture(n: number, over: Json = {}) {
  const [digits, ar, en] = PLATES[n] ?? ['1000', 'أ ب ج', 'A B J'];
  return {
    id: `t-${n}`,
    display_number: n,
    event_id: EVENT_ID,
    event_name_ar: 'حفل آل سعيد',
    venue_id: VENUE_ID,
    venue_name_ar: 'قاعة ريماس',
    status: 'parked',
    channel: 'whatsapp',
    plate: { country: 'SA', digits, letters_ar: ar, letters_en: en, display: `${ar} ${digits}` },
    vehicle: { make: 'toyota', color: 'white' },
    wa_link_status: 'linked',
    payment_status: 'not_required',
    version: 3,
    ...over,
  };
}

export function venueFixture(id = VENUE_ID) {
  return {
    id,
    code: id === VENUE_ID ? 'RMS' : 'LYL',
    name_ar: id === VENUE_ID ? 'قاعة ريماس' : 'قاعة ليالي',
    timezone: 'Asia/Riyadh',
    status: 'active',
    default_dispatch_pool_id: `p-${id}`,
    version: 1,
  };
}

export function eventFixture(over: Json = {}) {
  return {
    id: EVENT_ID,
    venue_id: VENUE_ID,
    dispatch_pool_id: `p-${VENUE_ID}`,
    name_ar: 'حفل آل سعيد',
    host_name: 'آل سعيد',
    event_date: new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10),
    status: 'open',
    pricing_mode: 'per_vehicle',
    fee_halalas: 2500,
    allowed_payment_methods: ['cash', 'pos'],
    opened_at: secondsAgo(4 * 3600),
    version: 3,
    ...over,
  };
}

export function alertFixture(over: Json = {}) {
  return {
    id: 'al-47',
    venue_id: VENUE_ID,
    event_id: EVENT_ID,
    ticket_id: 't-47',
    task_id: 'k-47',
    type: 'request_unaccepted',
    severity: 'critical',
    status: 'open',
    details: { display_number: 47 },
    raised_at: secondsAgo(250),
    ...over,
  };
}

export const warningAlertFixture = (over: Json = {}) =>
  alertFixture({
    id: 'al-45',
    ticket_id: 't-45',
    task_id: 'k-45',
    type: 'next_task_waiting_long',
    severity: 'warning',
    details: { display_number: 45 },
    raised_at: secondsAgo(60),
    ...over,
  });

function retrieveTask(n: number, over: Json = {}) {
  return {
    id: `k-${n}`,
    ticket_id: `t-${n}`,
    event_id: EVENT_ID,
    venue_id: VENUE_ID,
    type: 'retrieve',
    status: 'queued',
    priority_at: secondsAgo(300),
    seq: n,
    version: 1,
    ...over,
  };
}

/** `OperationsBoard` of the open event: the queue is sent unsorted on purpose (the UI sorts it). */
export function boardFixture(over: Json = {}) {
  return {
    event: eventFixture(),
    kpis: {
      open_requests: 3,
      oldest_wait_seconds: 310,
      avg_accept_seconds_30m: 42,
      drivers_available: 1,
      drivers_busy: 1,
      drivers_on_break: 1,
      drivers_on_duty: 3,
      vehicles_parked: 18,
      ready_waiting: 0,
    },
    queue: [
      {
        task_id: 'k-52',
        ticket: ticketFixture(52, { status: 'requested', requested_at: secondsAgo(40) }),
        status: 'offered',
        requested_at: secondsAgo(40),
        waiting_seconds: 40,
        offer: {
          offer_id: 'o-52',
          mode: 'single',
          round_no: 1,
          expires_at: new Date(Date.now() + 20_000).toISOString(),
        },
        assignee: KHALID,
      },
      {
        task_id: 'k-47',
        ticket: ticketFixture(47, { status: 'requested', requested_at: secondsAgo(310) }),
        status: 'queued',
        requested_at: secondsAgo(310),
        waiting_seconds: 310,
        escalated_at: secondsAgo(250),
      },
      {
        task_id: 'k-50',
        ticket: ticketFixture(50, { status: 'requested', requested_at: secondsAgo(130) }),
        status: 'broadcast',
        requested_at: secondsAgo(130),
        waiting_seconds: 130,
        offer: { offer_id: 'o-50', mode: 'broadcast', round_no: 2, recipients: 2 },
      },
    ],
    active_tasks: [
      {
        task: retrieveTask(44, {
          status: 'in_progress',
          assignee: SAAD,
          accepted_at: secondsAgo(200),
          key_picked_up_at: secondsAgo(150),
          started_at: secondsAgo(120),
        }),
        ticket: { id: 't-44', display_number: 44, status: 'retrieving', plate: ticketFixture(44).plate },
        requested_at: secondsAgo(260),
      },
    ],
    next_tasks: [
      {
        task: retrieveTask(45, {
          status: 'assigned_waiting',
          assignee: SAAD,
          assigned_waiting_at: secondsAgo(360),
        }),
        ticket: {
          id: 't-45',
          display_number: 45,
          status: 'assigned_waiting',
          plate: ticketFixture(45).plate,
        },
        requested_at: secondsAgo(400),
      },
    ],
    drivers: [
      {
        driver: KHALID,
        driver_state: 'available',
        connection_state: 'online',
        last_heartbeat_at: secondsAgo(5),
        available_since: secondsAgo(400),
      },
      {
        driver: SAAD,
        driver_state: 'busy_with_next',
        connection_state: 'online',
        last_heartbeat_at: secondsAgo(3),
        active_task_id: 'k-44',
        next_task_id: 'k-45',
      },
      {
        driver: FAHAD,
        driver_state: 'on_break',
        connection_state: 'uncertain',
        last_heartbeat_at: secondsAgo(70),
      },
    ],
    alerts: [alertFixture(), warningAlertFixture()],
    failed_messages: [
      {
        id: 'wm-41',
        direction: 'outbound',
        kind: 'template',
        purpose: 'W-05',
        status: 'failed',
        status_rank: 9,
        error_code: '131026',
        error_title: 'Message undeliverable',
        ticket_id: 't-41',
        failed_at: secondsAgo(300),
      },
    ],
    custody_issues: [
      {
        ticket: ticketFixture(39),
        subject: 'key',
        holder: { type: 'driver', id: SAAD.id, label: SAAD.full_name },
        since: secondsAgo(720),
      },
    ],
    channel_health: 'healthy',
    ...over,
  };
}

/** `TicketDetail` (full projection) of #47: requested, waiting in the queue, fee due at handover. */
export function ticketDetailFixture(over: Json = {}) {
  return {
    ...ticketFixture(47, { status: 'requested', payment_status: 'due', requested_at: secondsAgo(310) }),
    projection: 'full',
    vehicle_detail: { make: 'toyota', model: 'كامري', color: 'white', type: 'sedan' },
    customer: {
      phone_masked: '05•••••123',
      consent: { method: 'verbal_staff_confirmed', captured_at: secondsAgo(3600) },
      opted_out: false,
    },
    inspection_status: 'complete',
    damage_marks: [],
    current_spot: { id: 'sp-a03', label: 'A-03', zone_name: 'المنطقة A' },
    current_key_slot: { id: 'ks-12', label: '12', board_name: 'اللوحة 1' },
    vehicle_holder: { type: 'spot', id: 'sp-a03', label: 'A-03' },
    key_holder: { type: 'key_slot', id: 'ks-12', label: '12' },
    active_cycle: {
      id: 'cy-47',
      ticket_id: 't-47',
      cycle_no: 1,
      requested_at: secondsAgo(310),
      request_source: 'whatsapp',
      requested_early: false,
    },
    open_task: retrieveTask(47, { queued_at: secondsAgo(310), priority_at: secondsAgo(310) }),
    fee_halalas: 2500,
    payment: null,
    claim_code: null,
    media: [
      {
        id: 'md-1',
        ticket_id: 't-47',
        kind: 'photo_front',
        content_type: 'image/jpeg',
        upload_status: 'uploaded',
        captured_at: secondsAgo(3500),
      },
    ],
    created_by: KHALID,
    parked_by: KHALID,
    created_at: secondsAgo(3600),
    submitted_at: secondsAgo(3590),
    parked_at: secondsAgo(3400),
    ...over,
  };
}

/** A handover code as the server would never send it: the UI must mask it anyway (DEC-38). */
export const LEAKED_CODE = '482913';

export function timelineFixture() {
  const actor = { id: KHALID.id, full_name: KHALID.full_name };
  return {
    ticket: ticketFixture(47, { status: 'requested', payment_status: 'due' }),
    events: [
      {
        id: 1,
        type: 'ticket.created',
        actor_type: 'user',
        actor_id: KHALID.id,
        ticket_version: 1,
        occurred_at: secondsAgo(3600),
      },
      {
        id: 2,
        type: 'ticket.intake_submitted',
        actor_type: 'user',
        actor_id: KHALID.id,
        ticket_version: 2,
        occurred_at: secondsAgo(3590),
      },
      {
        id: 3,
        type: 'ticket.parked',
        actor_type: 'user',
        actor_id: KHALID.id,
        ticket_version: 3,
        data: { parking_spot_id: 'sp-a03', key_slot_id: 'ks-12' },
        occurred_at: secondsAgo(3400),
      },
      {
        id: 4,
        type: 'ticket.retrieval_requested',
        actor_type: 'customer',
        ticket_version: 4,
        occurred_at: secondsAgo(310),
      },
    ],
    custody: [
      {
        id: 'cu-1',
        ticket_id: 't-47',
        subject: 'vehicle',
        from_holder_type: 'customer',
        to_holder_type: 'driver',
        to_holder_id: KHALID.id,
        reason: 'intake',
        actor,
        occurred_at: secondsAgo(3600),
      },
      {
        id: 'cu-2',
        ticket_id: 't-47',
        subject: 'vehicle',
        from_holder_type: 'driver',
        from_holder_id: KHALID.id,
        to_holder_type: 'spot',
        to_holder_id: 'sp-a03',
        reason: 'parked',
        actor,
        occurred_at: secondsAgo(3400),
      },
      {
        id: 'cu-3',
        ticket_id: 't-47',
        subject: 'key',
        from_holder_type: 'driver',
        from_holder_id: KHALID.id,
        to_holder_type: 'key_slot',
        to_holder_id: 'ks-12',
        reason: 'key_deposited',
        actor,
        occurred_at: secondsAgo(3399),
      },
    ],
    cycles: [],
    tasks: [retrieveTask(47)],
    messages: [
      {
        id: 'wm-1',
        direction: 'outbound',
        kind: 'template',
        purpose: 'W-01',
        status: 'read',
        status_rank: 4,
        body_redacted: 'تم استلام سيارتك. رقم التذكرة 47.',
        ticket_id: 't-47',
        sent_at: secondsAgo(3580),
        read_at: secondsAgo(3500),
      },
      {
        id: 'wm-2',
        direction: 'outbound',
        kind: 'template',
        purpose: 'W-04',
        status: 'delivered',
        status_rank: 3,
        body_redacted: `رمز التسليم: ${LEAKED_CODE}`,
        ticket_id: 't-47',
        delivered_at: secondsAgo(300),
      },
    ],
    payments: [],
    incidents: [],
  };
}

export function incidentFixture(over: Json = {}) {
  return {
    id: 'in-1',
    venue_id: VENUE_ID,
    event_id: EVENT_ID,
    ticket_id: 't-47',
    type: 'vehicle_damage',
    status: 'open',
    severity: 'medium',
    description: 'خدش في الباب الخلفي الأيمن',
    opened_by: KHALID,
    owner: null,
    resolution: null,
    version: 2,
    created_at: secondsAgo(1800),
    updated_at: secondsAgo(1800),
    ...over,
  };
}

const NO_BLOCKERS = {
  open_tickets: [],
  keys_not_in_slots: [],
  open_requests: [],
  open_tasks: [],
  unsettled_payments: [],
  cash_outstanding: [],
  payment_integrity: [],
};

/** Reconciliation of the closing event, with (default) or without blockers. */
export function reconciliationFixture(blocked = true) {
  return {
    event_id: EVENT_ID,
    can_close: !blocked,
    blockers: blocked
      ? {
          ...NO_BLOCKERS,
          open_tickets: [ticketFixture(51)],
          keys_not_in_slots: [ticketFixture(39)],
          unsettled_payments: [ticketFixture(53, { status: 'delivered', payment_status: 'due' })],
          cash_outstanding: [{ driver: SAAD, amount_halalas: 7500 }],
        }
      : NO_BLOCKERS,
    warnings: { open_incidents: [incidentFixture()], failed_messages: [], cash_discrepancies: [] },
  };
}

export const closeBlockersFixture = () => reconciliationFixture(true).blockers;

export function settlementFixture() {
  return {
    event: {
      id: EVENT_ID,
      name_ar: 'حفل آل سعيد',
      status: 'closing',
      pricing_mode: 'per_vehicle',
      fee_halalas: 2500,
      allowed_payment_methods: ['cash', 'pos'],
    },
    currency: 'SAR',
    tickets: {
      total: 40,
      delivered: 37,
      open: 2,
      voided: 1,
      by_payment_status: { not_required: 0, due: 1, collected: 36, waived: 1 },
    },
    amounts: {
      billable_halalas: 97500,
      collected_halalas: 90000,
      waived_halalas: 2500,
      due_halalas: 2500,
      by_method: { cash: { count: 20, halalas: 50000 }, pos: { count: 16, halalas: 40000 } },
      reversed: { count: 0, halalas: 0 },
    },
    drivers: [
      {
        driver: SAAD,
        cash: {
          count: 12,
          collected_halalas: 30000,
          handed_over_halalas: 22500,
          outstanding_halalas: 7500,
          difference_adjusted_halalas: 0,
        },
        pos: { count: 8, halalas: 20000 },
      },
      {
        driver: KHALID,
        cash: {
          count: 8,
          collected_halalas: 20000,
          handed_over_halalas: 20000,
          outstanding_halalas: 0,
          difference_adjusted_halalas: 0,
        },
        pos: { count: 8, halalas: 20000 },
      },
    ],
    cash_handovers: [],
    discrepancies: [],
    close_blockers: { unsettled_payments: [], cash_outstanding: [], payment_integrity: [] },
    integrity: { ok: true, violations: [] },
  };
}

/** `DriverListItem` of سعد at قاعة ريماس (busy with a retrieval and a reserved next task). */
export function driverItemFixture(over: Json = {}) {
  return {
    user: {
      id: SAAD.id,
      employee_code: SAAD.employee_code,
      full_name: SAAD.full_name,
      phone_masked: '05•••••567',
      role: 'driver',
      status: 'active',
      version: 3,
    },
    active_assignment: {
      id: 'as-1',
      driver_id: SAAD.id,
      venue_id: VENUE_ID,
      venue_name_ar: 'قاعة ريماس',
      status: 'active',
      starts_at: secondsAgo(86400),
    },
    live: {
      driver: SAAD,
      driver_state: 'busy_with_next',
      connection_state: 'online',
      active_task_id: 'k-44',
      next_task_id: 'k-45',
    },
    ...over,
  };
}

export function orgSettingsFixture() {
  return {
    security: {
      supervisor_mfa_required: true,
      driver_session_hours: 14,
      staff_session_hours: 12,
      max_login_attempts: 5,
      admin_idle_minutes: 30,
      reveal_phone_per_hour: 20,
    },
    heartbeat: { interval_s: 15, uncertain_after_s: 45, offline_after_s: 120 },
    updated_at: secondsAgo(86400),
  };
}

export function retentionFixture() {
  return {
    photos_days: 90,
    wa_messages_days: 180,
    tickets_months: 24,
    audit_months: 36,
    wa_raw_days: 30,
    analytics_months: 24,
    approved_by_owner: false,
    updated_at: secondsAgo(86400 * 3),
  };
}

export function waChannelFixture() {
  return {
    id: 'ch-1',
    display_name: 'channel display name',
    business_account_id: '102030405060708',
    phone_number_id: '908070605040302',
    phone_display: '+966 11 000 0000',
    api_version: 'v26.0',
    mode: 'simulator',
    is_active: true,
    health_status: 'healthy',
    health_changed_at: secondsAgo(7200),
    quality_rating: 'GREEN',
    secrets_configured: { access_token: true, app_secret: true, verify_token: true },
  };
}

export function waTemplatesFixture() {
  return [
    {
      id: 'tp-1',
      name: 'ticket_issued',
      language: 'ar',
      category: 'UTILITY',
      status: 'approved',
      components: [{ type: 'BODY', text: 'تم استلام سيارتك. رقم التذكرة {{1}}.' }],
      last_synced_at: secondsAgo(3600),
    },
    {
      id: 'tp-2',
      name: 'vehicle_ready',
      language: 'ar',
      category: 'UTILITY',
      status: 'pending',
      components: [{ type: 'BODY', text: 'سيارتك جاهزة عند البوابة.' }],
      last_synced_at: secondsAgo(3600),
    },
  ];
}

export function outboxFixture() {
  return [
    {
      id: 'ob-1',
      type: 'job.whatsapp.send',
      aggregate_type: 'ticket',
      aggregate_id: 't-41',
      status: 'failed',
      attempts: 3,
      max_attempts: 8,
      available_at: secondsAgo(60),
      last_error: 'DEPENDENCY_TIMEOUT',
      created_at: secondsAgo(900),
    },
    {
      id: 'ob-2',
      type: 'job.push.send',
      status: 'dead',
      attempts: 8,
      max_attempts: 8,
      available_at: secondsAgo(600),
      last_error: '410 Gone',
      created_at: secondsAgo(4000),
    },
  ];
}

export function auditFixture() {
  return [
    {
      id: 9001,
      occurred_at: secondsAgo(120),
      actor_type: 'user',
      actor_id: STAFF_USER_ID,
      action: 'ticket.reveal_phone',
      entity_type: 'ticket',
      entity_id: 't-47',
      venue_id: VENUE_ID,
      request_id: 'req_audit_1',
      reason: 'التواصل مع العميل لعدم الحضور',
      before: null,
      after: { revealed: true },
    },
  ];
}

export interface StaffMockState {
  alerts: Json[];
  board: Json;
  ticket: Json;
  timeline: Json;
  incidents: Json[];
  event: Json;
}

/**
 * Registers the reads of the staff screens with the fixtures above (`state` can be changed by a test;
 * the handlers read it on every request). Alerts are filtered by `status` like the server, and
 * acknowledge/resolve change their status.
 */
export function mockStaffApi(api: MockApi, init: Partial<StaffMockState> = {}): StaffMockState {
  const state: StaffMockState = {
    alerts: init.alerts ?? [alertFixture(), warningAlertFixture()],
    board: init.board ?? boardFixture(),
    ticket: init.ticket ?? ticketDetailFixture(),
    timeline: init.timeline ?? timelineFixture(),
    incidents: init.incidents ?? [incidentFixture()],
    event: init.event ?? eventFixture(),
  };
  const statusFilter = (req: Request) => new URL(req.url()).searchParams.getAll('status');
  api
    .on('GET', '/v1/venues', () => ok([venueFixture(), venueFixture(OTHER_VENUE_ID)]))
    .on('GET', `/v1/venues/${VENUE_ID}/events`, () => ok([state.event]))
    .on('GET', `/v1/venues/${OTHER_VENUE_ID}/events`, () => ok([]))
    .on('GET', `/v1/venues/${VENUE_ID}/settings`, () =>
      ok({
        settings: {
          dispatch: { unaccepted_escalation_s: 60, next_task_wait_alert_s: 300 },
          ready: { uncollected_alert_min: 10 },
        },
        version: 1,
      }),
    )
    .on('GET', `/v1/events/${EVENT_ID}/operations`, () => ok(state.board))
    .on('GET', '/v1/alerts', (req) => {
      const statuses = statusFilter(req);
      return ok(state.alerts.filter((a) => !statuses.length || statuses.includes(String(a.status))));
    })
    .on('GET', `/v1/tickets/${String(state.ticket.id)}`, () => ok(state.ticket))
    .on('GET', `/v1/tickets/${String(state.ticket.id)}/timeline`, () => ok(state.timeline))
    .on('GET', '/v1/media/md-1/url', () =>
      ok({ url: '/icons/icon-192.png', expires_at: new Date(Date.now() + 300_000).toISOString() }),
    )
    .on('GET', '/v1/incidents', (req) => {
      const statuses = statusFilter(req);
      return ok(state.incidents.filter((i) => !statuses.length || statuses.includes(String(i.status))));
    })
    .on('GET', `/v1/events/${EVENT_ID}`, () => ok(state.event))
    .on('GET', `/v1/events/${EVENT_ID}/reconciliation`, () => ok(reconciliationFixture(true)))
    .on('GET', `/v1/events/${EVENT_ID}/settlement`, () => ok(settlementFixture()))
    .on('GET', `/v1/drivers/${SAAD.id}`, () => ok(driverItemFixture()))
    .on('GET', `/v1/drivers/${SAAD.id}/assignments`, () =>
      ok({ assignments: [driverItemFixture().active_assignment], transfers: [] }),
    )
    .on('GET', '/v1/drivers', () =>
      ok([
        {
          user: { ...KHALID, role: 'driver', status: 'active', version: 1 },
          live: { driver: KHALID, driver_state: 'available', connection_state: 'online' },
        },
      ]),
    )
    .on('GET', `/v1/venues/${VENUE_ID}/key-boards`, () =>
      ok([
        {
          board: { id: 'kb-1', venue_id: VENUE_ID, name: 'اللوحة 1', status: 'active' },
          slots: [
            { id: 'ks-12', key_board_id: 'kb-1', label: '12', status: 'active', occupied: true },
            { id: 'ks-13', key_board_id: 'kb-1', label: '13', status: 'active', occupied: false },
          ],
        },
      ]),
    )
    .on('GET', '/v1/admin/org-settings', () => ok(orgSettingsFixture()))
    .on('GET', '/v1/admin/retention-policy', () => ok(retentionFixture()))
    .on('GET', '/v1/admin/whatsapp/channel', () => ok(waChannelFixture()))
    .on('GET', '/v1/admin/whatsapp/templates', () => ok(waTemplatesFixture()))
    .on('GET', '/v1/admin/outbox', (req) => {
      const statuses = statusFilter(req);
      return ok(outboxFixture().filter((o) => !statuses.length || statuses.includes(o.status)));
    })
    .on('GET', '/v1/admin/audit-log', () => ok(auditFixture()));
  for (const id of ['al-47', 'al-45']) {
    const update = (status: string, note: unknown) => {
      const alert = state.alerts.find((a) => a.id === id);
      if (!alert) return apiError('RESOURCE_NOT_FOUND', 404);
      Object.assign(alert, {
        status,
        ...(status === 'acknowledged'
          ? { acknowledged_at: new Date().toISOString(), acknowledged_by: STAFF_USER_ID }
          : { resolved_at: new Date().toISOString(), resolved_by: STAFF_USER_ID, resolution_note: note }),
      });
      return ok({ ...alert });
    };
    api.on('POST', `/v1/alerts/${id}/acknowledge`, () => update('acknowledged', null));
    api.on('POST', `/v1/alerts/${id}/resolve`, (req) =>
      update('resolved', (req.postDataJSON() as Json).note),
    );
  }
  return state;
}
