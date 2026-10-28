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
