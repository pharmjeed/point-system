/**
 * In-memory fake of the customer API (V2-011, DEC-482) — the `/v1/customer/*` routes of `CUSTOMER_ROUTES` with the
 * server's rules, so the app's flows run before V2-010 exists: WhatsApp-only codes with a 60 s resend wait, 5
 * attempts then a 15-minute lock, rotating refresh tokens (reuse revokes the session), versioned consents,
 * Saudi plate normalisation, the 5-vehicle limit, `Idempotency-Key` replay, and the 08 error envelope; and since
 * V2-012/V2-017 the vehicle removal (C-15), the re-verification proof and the account deletion (C-20).
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
  CUSTOMER_REAUTH_TTL_S,
  CUSTOMER_REFRESH_TTL_DAYS,
  CUSTOMER_ROUTES,
  CUSTOMER_VEHICLES_MAX,
  CustomerHomeQuerySchema,
  CustomerLocationListQuerySchema,
  customerErrorDef,
  maskPhone,
  normalizeSaudiMobile,
  normalizeSaudiPlate,
  PASS_SECRET_BYTES,
  PASS_STEP_S,
  PASS_TOKEN_PREFIX,
  saudiPlateDisplay,
  verifyPassToken,
  type CustomerApiErrorCode,
  type CustomerConsentKind,
  type CustomerConsentState,
  type CustomerHome,
  type CustomerHomeVisit,
  type CustomerLocale,
  type CustomerLocationDetail,
  type CustomerLocationSummary,
  type CustomerMe,
  type CustomerPass,
  type CustomerPaymentMethod,
  type CustomerRouteKey,
  type CustomerVisitPayment,
  type CustomerTokens,
  type CustomerVehicle,
} from '@point/shared/customer';
import type { z } from 'zod';
import type { HttpRequest, HttpResponse, Transport } from '../transport';
import { distanceMetres, isOpenAt } from './hours';
import {
  FAKE_CARD_ON_FILE_VERSION,
  FAKE_CONSENT_VERSIONS,
  FAKE_LOCATIONS,
  FAKE_VISIT_FEE_HALALAS,
} from './seed';
import { parseFakeToken, type FakeCardBehaviour } from './tokens';

export interface FakeBackendOptions {
  now?: () => number;
  /** Uniform random in [0, 1); inject a seeded one for deterministic tests. */
  random?: () => number;
  /** Simulated network latency (the app uses ~300 ms so loading states are visible). */
  latencyMs?: number;
  /** Phones whose account gets a sample visit in progress on C-06 (to see the card without the server). */
  demoVisitPhones?: readonly string[];
  /** The seller named on the C-17 receipt data (the app's configured brand, never a literal here). */
  brand?: { nameAr: string; nameEn: string };
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
  /** V2-013: the entry pass secret (base64url), created by the first `GET /v1/customer/pass` */
  passSecret: string | null;
  /** V2-023 (C-18): saved cards; the token stays here, the app sees brand/last4/expiry */
  cards: Array<CustomerPaymentMethod & { token: string; behaviour: FakeCardBehaviour }>;
}

/** V2-022: a visit payment of the fake (the server's machine: initiated → paid | failed). */
interface FakePayment {
  id: string;
  accountId: string;
  ticketId: string;
  status: 'initiated' | 'paid' | 'failed';
  behaviour: FakeCardBehaviour;
  brand: string | null;
  last4: string | null;
  createdAt: number;
  paidAt: number | null;
  /** a card kept by «حفظ البطاقة» once paid */
  saveCard: { token: string; brand: string; last4: string; month: number; year: number } | null;
  savedCardId: string | null;
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
  /** C-20's single-use re-verification proof of this session (DEC-507). */
  reauth: { token: string; expiresAt: number } | null;
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
  const payments = new Map<string, FakePayment>();

  const base64Url = (bytes: number) => {
    const b = Array.from({ length: bytes }, () => Math.floor(random() * 256));
    let s = '';
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
      s += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!;
      if (i + 1 < b.length) s += A[(n >> 6) & 63]!;
      if (i + 2 < b.length) s += A[n & 63]!;
    }
    return s;
  };
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
    // a deleted account (C-20) answers its own tokens with ACCOUNT_DELETED, before the revocation (DEC-508)
    if (session && !accounts.has(session.accountId)) throw new Reject('ACCOUNT_DELETED');
    if (!session || session.revoked) throw new Reject('AUTH_SESSION_REVOKED');
    if (entry.expiresAt <= now()) throw new Reject('AUTH_SESSION_EXPIRED');
    return accounts.get(session.accountId) as Account;
  }

  /** The session of an authenticated request (C-20's proof is bound to it). */
  function sessionOf(req: HttpRequest): Session {
    const header = req.headers.Authorization ?? '';
    const entry = accessTokens.get(header.startsWith('Bearer ') ? header.slice(7) : '');
    return sessions.get(entry?.sessionId ?? '') as Session;
  }

  /** `in_active_visit` (C-15): the demo visit of `demoVisitPhones` holds the account's first car. */
  function vehiclesView(account: Account): CustomerVehicle[] {
    const inVisit = demoPhones.has(account.phone);
    return account.vehicles.map((v, i) => ({ ...v, in_active_visit: inVisit && i === 0 }));
  }

  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    throw new Reject('VALIDATION_FAILED', {
      fields: r.error.issues.map((i) => ({ field: i.path.map(String).join('.'), issue: i.code })),
    });
  }

  /** The code check shared by the sign-in and C-20's re-verification: attempts, lock, expiry; consumed on success. */
  function consumeCode(phone: string, code: string) {
    assertNotLocked(phone);
    const challenge = challenges.get(phone);
    if (!challenge || challenge.expiresAt <= now()) throw new Reject('CUSTOMER_OTP_EXPIRED');
    if (challenge.code !== code) {
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

  // ---- V2-022 / V2-023: visit payments and saved cards, with the server's rules (DEC-521 … DEC-525)

  const DEMO_TICKET_ID = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';
  /** The 3-D Secure page of the fake is «answered» this long after it opened (the in-app browser returned). */
  const FAKE_3DS_MS = 2000;

  function cardView(c: Account['cards'][number]): CustomerPaymentMethod {
    return {
      id: c.id,
      brand: c.brand,
      last4: c.last4,
      expires_month: c.expires_month,
      expires_year: c.expires_year,
      is_default: c.is_default,
      created_at: c.created_at,
    };
  }

  function keepCard(
    account: Account,
    card: { token: string; brand: string; last4: string; month: number; year: number },
    behaviour: FakeCardBehaviour,
    makeDefault = false,
  ) {
    const existing = account.cards.find((c) => c.token === card.token);
    if (existing) return existing;
    const first = account.cards.length === 0;
    if (makeDefault) for (const c of account.cards) c.is_default = false;
    const row = {
      id: uuid(),
      brand: card.brand,
      last4: card.last4,
      expires_month: card.month,
      expires_year: card.year,
      is_default: first || makeDefault,
      created_at: iso(now()),
      token: card.token,
      behaviour,
    };
    account.cards.push(row);
    return row;
  }

  function assertCardConsent(version: string | undefined) {
    if (!version)
      throw new Reject('CUSTOMER_CONSENT_REQUIRED', {
        kind: 'card_on_file',
        current_version: FAKE_CARD_ON_FILE_VERSION,
      });
    if (version !== FAKE_CARD_ON_FILE_VERSION)
      throw new Reject('CUSTOMER_CONSENT_VERSION_STALE', {
        kind: 'card_on_file',
        current_version: FAKE_CARD_ON_FILE_VERSION,
      });
  }

  /** The 3-D Secure page answered: paid (or failed for the 3-D Secure declined card), a saved card kept. */
  function settlePayment(p: FakePayment, outcome?: 'success' | 'fail') {
    if (p.status !== 'initiated') return;
    const fail = outcome ? outcome === 'fail' : p.behaviour === 'tdd';
    p.status = fail ? 'failed' : 'paid';
    if (!fail) {
      p.paidAt = now();
      const account = accounts.get(p.accountId);
      if (account && p.saveCard) p.savedCardId = keepCard(account, p.saveCard, 'ok').id;
    }
  }

  function paymentView(p: FakePayment, transactionUrl: string | null = null): CustomerVisitPayment {
    const venue = FAKE_LOCATIONS[0] as CustomerLocationDetail;
    const amount = FAKE_VISIT_FEE_HALALAS;
    const vat = amount - Math.round((amount * 10_000) / 11_500);
    return {
      payment_id: p.id,
      ticket_id: p.ticketId,
      status: p.status,
      amount_halalas: amount,
      vat_halalas: vat,
      currency: 'SAR',
      card_brand: p.brand,
      card_last4: p.last4,
      failure_code: p.status === 'failed' ? '51' : null,
      transaction_url: p.status === 'initiated' ? transactionUrl : null,
      callback_url: 'sa.point.app://pay/return',
      paid_at: p.paidAt ? iso(p.paidAt) : null,
      saved_payment_method_id: p.savedCardId,
      receipt: p.paidAt
        ? {
            payment_id: p.id,
            issued_at: iso(p.paidAt),
            seller_name_ar: options.brand?.nameAr ?? '—',
            seller_name_en: options.brand?.nameEn ?? '—',
            venue_name_ar: venue.name_ar,
            venue_name_en: venue.name_en,
            operator_name_ar: venue.operator_name_ar,
            operator_name_en: venue.operator_name_en,
            description: 'visit',
            amount_halalas: amount,
            net_halalas: amount - vat,
            vat_halalas: vat,
            vat_rate_bp: 1500,
            refunded_halalas: 0,
            currency: 'SAR',
            card_brand: p.brand,
            card_last4: p.last4,
          }
        : null,
    };
  }

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
      consumeCode(phone, body.code);
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
          passSecret: null,
          cards: [],
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
        reauth: null,
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
          if (!accounts.has(session.accountId)) throw new Reject('ACCOUNT_DELETED');
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
      return { items: vehiclesView(authenticate(req)) };
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

    // ---- V2-013 (C-11, DEC-500): the entry pass secret, delivered to the signed-in device only

    pass(req) {
      const account = authenticate(req);
      account.passSecret ??= base64Url(PASS_SECRET_BYTES);
      const rotatedAt = account.createdAt;
      const out: CustomerPass = {
        scheme: PASS_TOKEN_PREFIX,
        account_id: account.id,
        secret: account.passSecret,
        step_seconds: PASS_STEP_S,
        server_time: iso(now()),
        rotated_at: iso(rotatedAt),
        refresh_after: iso(rotatedAt + 30 * 24 * 3600_000),
        vehicles: account.vehicles.map((v) => ({
          vehicle_id: v.id,
          plate_display: v.plate.display,
          vehicle_make: v.vehicle_make,
          vehicle_color: v.vehicle_color,
        })),
      };
      return out;
    },

    // ---- V2-012 (C-15) and V2-017 (C-20), the server's rules (DEC-505, DEC-507, DEC-508)

    vehicleDelete(req, { params }) {
      const account = authenticate(req);
      const at = vehiclesView(account).find((v) => v.id === params.vehicleId);
      if (!at) throw new Reject('RESOURCE_NOT_FOUND', { resource: 'customer_vehicle' });
      if (at.in_active_visit) throw new Reject('CUSTOMER_VEHICLE_IN_ACTIVE_VISIT');
      account.vehicles = account.vehicles.filter((v) => v.id !== at.id);
      return { vehicle_id: at.id, removed_at: iso(now()) };
    },

    reauthVerify(req) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.reauthVerify.body, req.body);
      consumeCode(account.phone, body.code);
      const session = sessionOf(req);
      session.reauth = { token: `pcv.${hex(24)}`, expiresAt: now() + CUSTOMER_REAUTH_TTL_S * 1000 };
      return { reauth_token: session.reauth.token, expires_at: iso(session.reauth.expiresAt) };
    },

    // ---- V2-022 (C-12 → C-10) and V2-023 (C-18)

    visitPay(req, { params }) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.visitPay.body, req.body);
      if (!demoPhones.has(account.phone) || params.ticketId !== DEMO_TICKET_ID)
        throw new Reject('RESOURCE_NOT_FOUND', { resource: 'visit' });
      const mine = [...payments.values()].filter(
        (p) => p.accountId === account.id && p.ticketId === params.ticketId,
      );
      const done = mine.find((p) => p.status === 'paid');
      if (done) throw new Reject('PAYMENT_ALREADY_RECORDED', { online_payment_id: done.id, method: 'app' });
      const live = mine.find((p) => p.status === 'initiated' && now() - p.createdAt < 15 * 60_000);
      if (live)
        throw new Reject('PAYMENT_IN_PROGRESS', {
          online_payment_id: live.id,
          retry_after_s: Math.ceil((live.createdAt + 15 * 60_000 - now()) / 1000),
        });
      if (body.save_card) assertCardConsent(body.card_on_file_version);
      let behaviour: FakeCardBehaviour;
      let brand: string | null;
      let last4: string | null;
      let saveCard: FakePayment['saveCard'] = null;
      if (body.source.type === 'token') {
        const info = parseFakeToken(body.source.token);
        if (!info) throw new Reject('PAYMENT_FAILED', { failure_code: 'gateway_invalid_request_error' });
        ({ behaviour, brand, last4 } = info);
        if (body.save_card)
          saveCard = {
            token: body.source.token,
            brand: info.brand,
            last4: info.last4,
            month: info.month,
            year: info.year,
          };
      } else if (body.source.type === 'applepay') {
        behaviour = /declined/i.test(body.source.token)
          ? 'dec'
          : /3ds/i.test(body.source.token)
            ? 'tds'
            : 'ok';
        brand = 'visa';
        last4 = '4242';
      } else {
        const id = body.source.payment_method_id;
        const card = account.cards.find((c) => c.id === id);
        if (!card) throw new Reject('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
        ({ behaviour, brand, last4 } = card);
      }
      const p: FakePayment = {
        id: uuid(),
        accountId: account.id,
        ticketId: params.ticketId as string,
        status: 'initiated',
        behaviour,
        brand,
        last4,
        createdAt: now(),
        paidAt: null,
        saveCard,
        savedCardId: null,
      };
      payments.set(p.id, p);
      if (behaviour === 'dec') {
        p.status = 'failed';
        throw new Reject('PAYMENT_FAILED', { online_payment_id: p.id, failure_code: '51' });
      }
      if (behaviour === 'ok') {
        settlePayment(p, 'success');
        return paymentView(p);
      }
      return paymentView(p, `https://payments.fake.invalid/3ds/${p.id}`);
    },

    payment(req, { params }) {
      const account = authenticate(req);
      const p = payments.get(params.paymentId ?? '');
      if (!p || p.accountId !== account.id)
        throw new Reject('RESOURCE_NOT_FOUND', { resource: 'online_payment' });
      // the customer answered the 3-D Secure page in the in-app browser (the webhook, on the server)
      if (p.status === 'initiated' && now() - p.createdAt >= FAKE_3DS_MS) settlePayment(p);
      return paymentView(p);
    },

    paymentMethods(req) {
      const account = authenticate(req);
      const items = [...account.cards]
        .sort(
          (a, b) => Number(b.is_default) - Number(a.is_default) || b.created_at.localeCompare(a.created_at),
        )
        .map(cardView);
      return { items };
    },

    paymentMethodCreate(req) {
      const account = authenticate(req);
      const body = parse(CUSTOMER_ROUTES.paymentMethodCreate.body, req.body);
      assertCardConsent(body.card_on_file_version);
      const info = parseFakeToken(body.token);
      if (!info)
        throw new Reject('VALIDATION_FAILED', { fields: [{ field: 'token', issue: 'unknown_token' }] });
      const card = keepCard(
        account,
        { token: body.token, brand: info.brand, last4: info.last4, month: info.month, year: info.year },
        info.behaviour,
        body.make_default === true,
      );
      return cardView(card);
    },

    paymentMethodPatch(req, { params }) {
      const account = authenticate(req);
      parse(CUSTOMER_ROUTES.paymentMethodPatch.body, req.body);
      const card = account.cards.find((c) => c.id === params.paymentMethodId);
      if (!card) throw new Reject('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
      for (const c of account.cards) c.is_default = c.id === card.id;
      return cardView(card);
    },

    paymentMethodDelete(req, { params }) {
      const account = authenticate(req);
      const card = account.cards.find((c) => c.id === params.paymentMethodId);
      if (!card) throw new Reject('RESOURCE_NOT_FOUND', { resource: 'payment_method' });
      account.cards = account.cards.filter((c) => c.id !== card.id);
      if (card.is_default && account.cards.length) {
        const newest = [...account.cards].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
        newest.is_default = true;
      }
      return { payment_method_id: card.id, removed_at: iso(now()) };
    },

    meDelete(req) {
      const account = authenticate(req);
      const raw = (req.body ?? {}) as { reauth_token?: unknown };
      if (raw.reauth_token === undefined || raw.reauth_token === null || raw.reauth_token === '')
        throw new Reject('CUSTOMER_REAUTH_REQUIRED', { reason: 'missing' });
      const body = parse(CUSTOMER_ROUTES.meDelete.body, req.body);
      const session = sessionOf(req);
      if (!session.reauth || session.reauth.token !== body.reauth_token)
        throw new Reject('CUSTOMER_REAUTH_REQUIRED', { reason: 'invalid' });
      if (session.reauth.expiresAt <= now())
        throw new Reject('CUSTOMER_REAUTH_REQUIRED', { reason: 'expired' });
      if (demoPhones.has(account.phone)) throw new Reject('CUSTOMER_ACCOUNT_VISIT_ACTIVE');
      accounts.delete(account.id);
      accountByPhone.delete(account.phone);
      for (const s of sessions.values())
        if (s.accountId === account.id) {
          s.revoked = true;
          s.reauth = null;
        }
      return { deleted: true, deleted_at: iso(now()) };
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
      const status =
        req.method === 'POST' && ['vehicleCreate', 'visitPay', 'paymentMethodCreate'].includes(found.key)
          ? 201
          : 200;
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
    /**
     * The driver's scan (O-01, tests): verifies a token shown on C-11 as `POST /v1/tickets/intake-pass` does, with the
     * account's secret and this backend's clock.
     */
    verifyPass(token: string, atMs = now()) {
      const secrets = [...accounts.values()].map((a) => a.passSecret).filter((s): s is string => !!s);
      return verifyPassToken({ token, secrets, nowMs: atMs });
    },
    /** The customer answers a 3-D Secure page of the fake (tests; the app's poll settles it after a moment). */
    complete3ds(paymentId: string, outcome: 'success' | 'fail' = 'success') {
      const p = payments.get(paymentId);
      if (p) settlePayment(p, outcome);
    },
    /** Every message «sent» (tests). */
    get inbox(): ReadonlyArray<{ phone: string; code: string; at: number }> {
      return inbox;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;
