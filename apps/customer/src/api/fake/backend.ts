/**
 * In-memory fake of the customer API (V2-011, DEC-482) — the `/v1/customer/*` routes of `CUSTOMER_ROUTES` with the
 * server's rules, so the app's flows run before V2-010 exists: WhatsApp-only codes with a 60 s resend wait, 5
 * attempts then a 15-minute lock, rotating refresh tokens (reuse revokes the session), versioned consents,
 * Saudi plate normalisation, the 5-vehicle limit, `Idempotency-Key` replay, and the 08 error envelope.
 *
 * The WhatsApp message is not sent anywhere: it lands in `inbox` (the role of tools/wa-simulator), and the app
 * shows the code on C-03 in development only. Never used by a release build unless explicitly configured
 * (src/config.ts). Every answer is checked against the shared contract before it is returned.
 */
import {
  CUSTOMER_ACCESS_TTL_S,
  CUSTOMER_HOME_NEARBY_MAX,
  CUSTOMER_OTP_LENGTH,
  CUSTOMER_OTP_LOCK_MINUTES,
  CUSTOMER_OTP_MAX_ATTEMPTS,
  CUSTOMER_OTP_RESEND_AFTER_S,
  CUSTOMER_OTP_TTL_S,
  CUSTOMER_REFRESH_TTL_DAYS,
  CUSTOMER_ROUTES,
  CUSTOMER_VEHICLES_MAX,
  CustomerHomeQuerySchema,
  CustomerLocationListQuerySchema,
  customerErrorDef,
  maskPhone,
  normalizeSaudiMobile,
  normalizeSaudiPlate,
  saudiPlateDisplay,
  type CustomerApiErrorCode,
  type CustomerConsentKind,
  type CustomerConsentState,
  type CustomerHome,
  type CustomerHomeVisit,
  type CustomerLocale,
  type CustomerLocationDetail,
  type CustomerLocationSummary,
  type CustomerMe,
  type CustomerRouteKey,
  type CustomerTokens,
  type CustomerVehicle,
} from '@point/shared/customer';
import type { z } from 'zod';
import type { HttpRequest, HttpResponse, Transport } from '../transport';
import { distanceMetres, isOpenAt } from './hours';
import { FAKE_CONSENT_VERSIONS, FAKE_LOCATIONS } from './seed';

export interface FakeBackendOptions {
  now?: () => number;
  /** Uniform random in [0, 1); inject a seeded one for deterministic tests. */
  random?: () => number;
  /** Simulated network latency (the app uses ~300 ms so loading states are visible). */
  latencyMs?: number;
  /** Phones whose account gets a sample visit in progress on C-06 (to see the card without the server). */
  demoVisitPhones?: readonly string[];
}

interface Challenge {
  code: string;
  expiresAt: number;
  resendAt: number;
  attemptsLeft: number;
}

interface ConsentRow {
  kind: CustomerConsentKind;
  version: string;
  granted: boolean;
  at: number;
}

interface Account {
  id: string;
  phone: string;
  displayName: string | null;
  locale: CustomerLocale;
  createdAt: number;
  consents: ConsentRow[];
  vehicles: CustomerVehicle[];
}

interface Session {
  id: string;
  accountId: string;
  deviceId: string;
  refreshToken: string;
  refreshExpiresAt: number;
  /** Refresh tokens already rotated away: presenting one again revokes the session. */
  retired: Set<string>;
  revoked: boolean;
}

interface StoredReply {
  fingerprint: string;
  status: number;
  data: unknown;
}

/** A list page: `data` plus `meta.next_cursor`. */
class Paged {
  constructor(
    readonly data: unknown,
    readonly next: string | null,
  ) {}
}

class Reject extends Error {
  constructor(
    readonly code: CustomerApiErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createFakeBackend(options: FakeBackendOptions = {}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const latency = options.latencyMs ?? 0;
  const demoPhones = new Set(options.demoVisitPhones ?? []);

  const challenges = new Map<string, Challenge>();
  const locks = new Map<string, number>();
  const accounts = new Map<string, Account>();
  const accountByPhone = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const accessTokens = new Map<string, { sessionId: string; expiresAt: number }>();
  const replies = new Map<string, StoredReply>();
  const inbox: Array<{ phone: string; code: string; at: number }> = [];
  let requestSeq = 0;

  const hex = (bytes: number) =>
    Array.from({ length: bytes }, () =>
      Math.floor(random() * 256)
        .toString(16)
        .padStart(2, '0'),
    ).join('');

  /** RFC 9562 version 4. */
  function uuid(): string {
    const h = hex(16).split('');
    h[12] = '4';
    h[16] = '89ab'[Math.floor(random() * 4)] as string;
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  const otp = () => Array.from({ length: CUSTOMER_OTP_LENGTH }, () => Math.floor(random() * 10)).join('');

  // ------------------------------------------------------------------ views

  function consentState(account: Account, kind: 'terms' | 'privacy' | 'marketing'): CustomerConsentState {
    const latest = [...account.consents].reverse().find((c) => c.kind === kind);
    const current = FAKE_CONSENT_VERSIONS[kind];
    return {
      kind,
      current_version: current,
      granted: latest && latest.version === current ? latest.granted : null,
      answered_version: latest?.version ?? null,
      answered_at: latest ? iso(latest.at) : null,
      document_url: null,
    };
  }

  function meView(account: Account): CustomerMe {
    const consents = {
      terms: consentState(account, 'terms'),
      privacy: consentState(account, 'privacy'),
      marketing: consentState(account, 'marketing'),
    };
    return {
      id: account.id,
      phone_e164: account.phone,
      phone_masked: maskPhone(account.phone),
      display_name: account.displayName,
      locale: account.locale,
      status: 'active',
      consents,
      profile_complete:
        account.displayName !== null && consents.terms.granted === true && consents.privacy.granted === true,
      vehicles_count: account.vehicles.length,
      created_at: iso(account.createdAt),
    };
  }

  function summary(
    loc: CustomerLocationDetail,
    from?: { lat: number; lng: number },
  ): CustomerLocationSummary {
    const { address: _a, timezone: _t, opening_hours, photo_urls: _p, plans: _pl, ...rest } = loc;
    return {
      ...rest,
      open_now: isOpenAt(opening_hours, now()),
      distance_m:
        from && loc.lat !== null && loc.lng !== null
          ? distanceMetres(from, { lat: loc.lat, lng: loc.lng })
          : null,
    };
  }

  function issueTokens(session: Session): CustomerTokens {
    const access = hex(24);
    const expiresAt = now() + CUSTOMER_ACCESS_TTL_S * 1000;
    accessTokens.set(access, { sessionId: session.id, expiresAt });
    return {
      token_type: 'Bearer',
      access_token: access,
      access_expires_at: iso(expiresAt),
      refresh_token: session.refreshToken,
      refresh_expires_at: iso(session.refreshExpiresAt),
    };
  }

  // ------------------------------------------------------------------ guards

  function authenticate(req: HttpRequest): Account {
    const header = req.headers.Authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = accessTokens.get(token);
    if (!entry) throw new Reject('AUTH_UNAUTHENTICATED');
    const session = sessions.get(entry.sessionId);
    if (!session || session.revoked) throw new Reject('AUTH_SESSION_REVOKED');
    if (entry.expiresAt <= now()) throw new Reject('AUTH_SESSION_EXPIRED');
    const account = accounts.get(session.accountId);
    if (!account) throw new Reject('ACCOUNT_DELETED');
    return account;
  }

  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    throw new Reject('VALIDATION_FAILED', {
      fields: r.error.issues.map((i) => ({ field: i.path.map(String).join('.'), issue: i.code })),
    });
  }

  /** Locked phone? (survives new code requests, C-03 «5 محاولات ثم إيقاف 15 دقيقة»). */
  function assertNotLocked(phone: string) {
    const until = locks.get(phone);
    if (until !== undefined && until > now())
      throw new Reject('CUSTOMER_OTP_LOCKED', { locked_until: iso(until) });
  }

  // ------------------------------------------------------------------ handlers

  type Handler = (
    req: HttpRequest,
    ctx: { query: URLSearchParams; params: Record<string, string> },
  ) => unknown;

  const handlers: Record<CustomerRouteKey, Handler> = {
    otpRequest(req) {
      const raw = (req.body ?? {}) as { phone_e164?: unknown };
      if (typeof raw.phone_e164 === 'string' && normalizeSaudiMobile(raw.phone_e164) === null) {
        throw new Reject('PHONE_INVALID');
      }
      const body = parse(CUSTOMER_ROUTES.otpRequest.body, req.body);
      const phone = body.phone_e164;
      assertNotLocked(phone);
      const existing = challenges.get(phone);
      if (existing && existing.resendAt > now()) {
        throw new Reject('RATE_LIMITED', { retry_after_s: Math.ceil((existing.resendAt - now()) / 1000) });
      }
      const challenge: Challenge = {
        code: otp(),
        expiresAt: now() + CUSTOMER_OTP_TTL_S * 1000,
        resendAt: now() + CUSTOMER_OTP_RESEND_AFTER_S * 1000,
        // a new code keeps the attempts already used on this number (no reset by resending)
        attemptsLeft: existing?.attemptsLeft ?? CUSTOMER_OTP_MAX_ATTEMPTS,
      };
      challenges.set(phone, challenge);
      inbox.push({ phone, code: challenge.code, at: now() });
      return {
        channel: 'whatsapp',
        phone_masked: maskPhone(phone),
        expires_at: iso(challenge.expiresAt),
        resend_available_at: iso(challenge.resendAt),
        attempts_left: challenge.attemptsLeft,
      };
    },

    otpVerify(req) {
      const body = parse(CUSTOMER_ROUTES.otpVerify.body, req.body);
      const phone = body.phone_e164;
      assertNotLocked(phone);
      const challenge = challenges.get(phone);
      if (!challenge || challenge.expiresAt <= now()) throw new Reject('CUSTOMER_OTP_EXPIRED');
      if (challenge.code !== body.code) {
        challenge.attemptsLeft -= 1;
        if (challenge.attemptsLeft <= 0) {
          const until = now() + CUSTOMER_OTP_LOCK_MINUTES * 60_000;
          locks.set(phone, until);
          challenges.delete(phone);
          throw new Reject('CUSTOMER_OTP_LOCKED', { locked_until: iso(until) });
        }
        throw new Reject('CUSTOMER_OTP_INVALID', { attempts_left: challenge.attemptsLeft });
      }
      challenges.delete(phone);
      let accountId = accountByPhone.get(phone);
      const isNew = accountId === undefined;
      if (accountId === undefined) {
        accountId = uuid();
        accounts.set(accountId, {
          id: accountId,
          phone,
          displayName: null,
          locale: 'ar',
          createdAt: now(),
          consents: [],
          vehicles: [],
        });
        accountByPhone.set(phone, accountId);
      }
      const session: Session = {
        id: uuid(),
        accountId,
        deviceId: body.device_id,
        refreshToken: hex(32),
        refreshExpiresAt: now() + CUSTOMER_REFRESH_TTL_DAYS * 86_400_000,
        retired: new Set(),
        revoked: false,
      };
      sessions.set(session.id, session);
      const account = accounts.get(accountId) as Account;
      return { ...issueTokens(session), account: meView(account), is_new_account: isNew };
    },

    refresh(req) {
      const body = parse(CUSTOMER_ROUTES.refresh.body, req.body);
      for (const session of sessions.values()) {
        if (session.retired.has(body.refresh_token)) {
          session.revoked = true; // a stolen, already-rotated token was replayed
          throw new Reject('AUTH_SESSION_REVOKED');
        }
        if (session.refreshToken === body.refresh_token) {
          if (session.revoked || session.refreshExpiresAt <= now() || session.deviceId !== body.device_id) {
            throw new Reject('AUTH_SESSION_REVOKED');
          }
          session.retired.add(session.refreshToken);
          session.refreshToken = hex(32);
          return issueTokens(session);
        }
      }
      throw new Reject('AUTH_SESSION_REVOKED');
    },

    logout(req) {
      authenticate(req);
      const body = parse(CUSTOMER_ROUTES.logout.body, req.body);
      for (const session of sessions.values())
        if (session.refreshToken === body.refresh_token) session.revoked = true;
      return { logged_out: true };
    },

    me(req) {
      return meView(authenticate(req));
    },

    mePatch(req) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.mePatch.body, req.body);
      if (body.display_name !== undefined) account.displayName = body.display_name;
      if (body.locale !== undefined) account.locale = body.locale;
      return meView(account);
    },

    consents(req) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.consents.body, req.body);
      for (const answer of body.consents) {
        if (answer.version !== FAKE_CONSENT_VERSIONS[answer.kind]) {
          throw new Reject('CUSTOMER_CONSENT_VERSION_STALE', {
            kind: answer.kind,
            current_version: FAKE_CONSENT_VERSIONS[answer.kind],
          });
        }
      }
      for (const answer of body.consents) {
        account.consents.push({
          kind: answer.kind,
          version: answer.version,
          granted: answer.granted,
          at: now(),
        });
      }
      return meView(account);
    },

    vehicles(req) {
      return { items: authenticate(req).vehicles };
    },

    vehicleCreate(req) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.vehicleCreate.body, req.body);
      const result = normalizeSaudiPlate(body.plate);
      if (!result.ok) throw new Reject('PLATE_INVALID', { field: result.field, reason: result.reason });
      if (account.vehicles.length >= CUSTOMER_VEHICLES_MAX) {
        throw new Reject('CUSTOMER_VEHICLE_LIMIT', { max: CUSTOMER_VEHICLES_MAX });
      }
      const { plate } = result;
      if (
        account.vehicles.some(
          (v) => v.plate.digits === plate.digits && v.plate.letters_ar === plate.letters_ar,
        )
      ) {
        throw new Reject('CUSTOMER_VEHICLE_DUPLICATE');
      }
      const vehicle: CustomerVehicle = {
        id: uuid(),
        plate: { ...plate, raw: null, display: saudiPlateDisplay(plate) },
        vehicle_make: body.vehicle_make ?? null,
        vehicle_model: body.vehicle_model ?? null,
        vehicle_color: body.vehicle_color ?? null,
        vehicle_type: body.vehicle_type ?? null,
        in_active_visit: false,
        created_at: iso(now()),
      };
      account.vehicles.push(vehicle);
      return vehicle;
    },

    locations(req, { query }) {
      authenticate(req);
      const q = parse(CustomerLocationListQuerySchema, Object.fromEntries(query));
      const from = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
      let items = FAKE_LOCATIONS.map((l) => summary(l, from));
      if (q.q) {
        const needle = q.q.toLowerCase();
        items = items.filter(
          (l) => l.name_ar.includes(q.q as string) || l.name_en?.toLowerCase().includes(needle),
        );
      }
      if (q.filter === 'subscribable') items = items.filter((l) => l.subscriptions_enabled);
      if (q.filter === 'open_now') items = items.filter((l) => l.open_now === true);
      if (q.filter === 'subscribed') items = [];
      if (from) items.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
      const offset = q.cursor?.startsWith('o:') ? Number(q.cursor.slice(2)) || 0 : 0;
      const page = items.slice(offset, offset + q.limit);
      const next = offset + q.limit < items.length ? `o:${offset + q.limit}` : null;
      return new Paged({ items: page }, next);
    },

    location(req, { params }) {
      authenticate(req);
      const loc = FAKE_LOCATIONS.find((l) => l.venue_id === params.venueId);
      if (!loc) throw new Reject('VENUE_NOT_LISTED');
      return { ...loc, open_now: isOpenAt(loc.opening_hours, now()) };
    },

    home(req, { query }) {
      const account = authenticate(req);
      const q = parse(CustomerHomeQuerySchema, Object.fromEntries(query));
      const from = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
      const nearby = FAKE_LOCATIONS.map((l) => summary(l, from));
      if (from) nearby.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
      const first = FAKE_LOCATIONS[0] as CustomerLocationDetail;
      const visit: CustomerHomeVisit | null = demoPhones.has(account.phone)
        ? {
            ticket_id: '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60',
            venue_id: first.venue_id,
            venue_name_ar: first.name_ar,
            venue_name_en: first.name_en,
            status: 'parked',
            plate_display: account.vehicles[0]?.plate.display ?? null,
            received_at: iso(now() - 45 * 60_000),
          }
        : null;
      const home: CustomerHome = {
        display_name: account.displayName,
        current_visit: visit,
        subscriptions: [],
        nearby_locations: nearby.slice(0, CUSTOMER_HOME_NEARBY_MAX),
        vehicles_count: account.vehicles.length,
      };
      return home;
    },
  };

  // ------------------------------------------------------------------ routing

  function match(
    method: string,
    pathname: string,
  ): { key: CustomerRouteKey; params: Record<string, string> } | null {
    for (const [key, route] of Object.entries(CUSTOMER_ROUTES) as Array<
      [CustomerRouteKey, { method: string; path: string }]
    >) {
      if (route.method !== method) continue;
      const names: string[] = [];
      const re = new RegExp(
        `^${route.path.replace(/\{(\w+)\}/g, (_m, n: string) => {
          names.push(n);
          return '([^/]+)';
        })}$`,
      );
      const m = re.exec(pathname);
      if (m) {
        const params: Record<string, string> = {};
        names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] as string)));
        return { key, params };
      }
    }
    return null;
  }

  function envelope(data: unknown, extra: Record<string, unknown> = {}) {
    requestSeq += 1;
    return { data, meta: { request_id: `req_fake${requestSeq}`, server_time: iso(now()), ...extra } };
  }

  function errorResponse(code: CustomerApiErrorCode, details: Record<string, unknown>): HttpResponse {
    const def = customerErrorDef(code);
    requestSeq += 1;
    return {
      status: def.http,
      body: {
        error: {
          code,
          message: def.message,
          message_ar: def.message_ar,
          request_id: `req_fake${requestSeq}`,
          retryable: def.retryable,
          details,
        },
      },
    };
  }

  function handle(req: HttpRequest): HttpResponse {
    const [pathname = '', search = ''] = req.path.split('?');
    const found = match(req.method, pathname);
    if (!found) return errorResponse('RESOURCE_NOT_FOUND', {});
    const route = CUSTOMER_ROUTES[found.key];
    const query = new URLSearchParams(search);

    // Idempotency-Key (07): required on writes; the same key replays the stored answer.
    let replyKey: string | null = null;
    let fingerprint = '';
    if (route.idempotency === 'required') {
      const key = req.headers['Idempotency-Key'];
      if (!key) return errorResponse('IDEMPOTENCY_KEY_REQUIRED', {});
      replyKey = `${req.headers.Authorization ?? ''}|${key}`;
      fingerprint = `${req.method} ${pathname} ${JSON.stringify(req.body ?? null)}`;
      const stored = replies.get(replyKey);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return errorResponse('IDEMPOTENCY_KEY_REUSED', {});
        return { status: stored.status, body: envelope(stored.data, { replayed: true }) };
      }
    }

    try {
      const out = handlers[found.key](req, { query, params: found.params });
      const data = out instanceof Paged ? out.data : out;
      const next = out instanceof Paged ? out.next : undefined;
      const checked = route.data.safeParse(data);
      if (!checked.success)
        throw new Error(`fake backend broke the ${found.key} contract: ${checked.error.message}`);
      const status = req.method === 'POST' && found.key === 'vehicleCreate' ? 201 : 200;
      if (replyKey) replies.set(replyKey, { fingerprint, status, data: checked.data });
      return { status, body: envelope(checked.data, next === undefined ? {} : { next_cursor: next }) };
    } catch (e) {
      if (e instanceof Reject) return errorResponse(e.code, e.details);
      throw e;
    }
  }

  const transport: Transport = async (req) => {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    // a deep copy both ways, as over the wire
    const res = handle(JSON.parse(JSON.stringify(req)) as HttpRequest);
    return JSON.parse(JSON.stringify(res)) as HttpResponse;
  };

  return {
    transport,
    /** The WhatsApp simulator: the last code sent to a phone (development banner on C-03, tests). */
    lastCode(phone: string): string | null {
      for (let i = inbox.length - 1; i >= 0; i--)
        if (inbox[i]?.phone === phone) return inbox[i]?.code ?? null;
      return null;
    },
    /** Every message «sent» (tests). */
    get inbox(): ReadonlyArray<{ phone: string; code: string; at: number }> {
      return inbox;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;
