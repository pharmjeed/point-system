/**
 * Typed client of the customer API `/v1/customer/*` (docs/v2/05_API_Integrations.md §1). Every request body is
 * checked against the shared zod contract before it leaves, every answer is parsed with it (`@point/shared/
 * customer`), so the app and the server (V2-010) cannot drift silently.
 *
 * Session (DEC-482): a short access token sent as `Authorization: Bearer`, a rotating refresh token, both kept by
 * the `TokenStore` (secure storage on the device). An expired access token is refreshed once — before the call
 * when it is about to expire, or after a `401 AUTH_SESSION_EXPIRED` — and the call is retried with the same
 * `Idempotency-Key`. A refused refresh clears the tokens and signs the app out. Concurrent calls share one refresh.
 */
import type { z } from 'zod';
import {
  CUSTOMER_ROUTES,
  CustomerErrorEnvelopeSchema,
  CustomerTokensSchema,
  successEnvelopeSchema,
  type CustomerAuthResult,
  type CustomerConsentsBody,
  type CustomerDevicePlatform,
  type CustomerHome,
  type CustomerHomeQuery,
  type CustomerLocale,
  type CustomerLocationDetail,
  type CustomerLocationListQuery,
  type CustomerLocationSummary,
  type CustomerMe,
  type CustomerMePatchBody,
  type CustomerOtpChallenge,
  type CustomerRouteKey,
  type CustomerTokens,
  type CustomerVehicle,
  type CustomerVehicleCreateBody,
} from '@point/shared/customer';
import type { StoredSession, TokenStore } from '../session/tokenStore';
import { ApiError, BadResponseError, SignedOutError } from './errors';
import type { HttpRequest, Transport } from './transport';

/** Refresh ahead when the access token has less than this left. */
const REFRESH_SKEW_MS = 30_000;

export interface CustomerApiOptions {
  transport: Transport;
  tokens: TokenStore;
  device: { id: string; platform: CustomerDevicePlatform };
  /** Generates an `Idempotency-Key` (a UUID on the device). */
  newKey: () => string;
  now?: () => number;
  /** Called once when the session is refused (refresh rejected); the app shows sign-in. */
  onSignedOut?: (reason: 'revoked') => void;
}

type Route<K extends CustomerRouteKey> = (typeof CUSTOMER_ROUTES)[K];
type RouteData<K extends CustomerRouteKey> = z.infer<Route<K>['data']>;

interface CallInput {
  body?: unknown;
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | undefined>>;
  idempotencyKey?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const toStored = (t: CustomerTokens): StoredSession => ({
  accessToken: t.access_token,
  accessExpiresAt: t.access_expires_at,
  refreshToken: t.refresh_token,
  refreshExpiresAt: t.refresh_expires_at,
});

function buildPath(template: string, params: CallInput['params'], query: CallInput['query']): string {
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

export function createCustomerApi(opts: CustomerApiOptions) {
  const now = opts.now ?? Date.now;
  let refreshing: Promise<StoredSession> | null = null;

  function parseError(status: number, body: unknown): Error {
    const parsed = CustomerErrorEnvelopeSchema.safeParse(body);
    return parsed.success
      ? new ApiError(status, parsed.data.error)
      : new BadResponseError(status, `HTTP ${status} without an error envelope`);
  }

  async function signOut(): Promise<never> {
    await opts.tokens.clear();
    opts.onSignedOut?.('revoked');
    throw new SignedOutError('revoked');
  }

  /** One refresh at a time; every waiting call gets the same new pair. */
  function refresh(current: StoredSession): Promise<StoredSession> {
    refreshing ??= (async () => {
      try {
        const res = await opts.transport({
          method: CUSTOMER_ROUTES.refresh.method,
          path: CUSTOMER_ROUTES.refresh.path,
          headers: {},
          body: CUSTOMER_ROUTES.refresh.body.parse({
            refresh_token: current.refreshToken,
            device_id: opts.device.id,
          }),
        });
        if (res.status === 401 || res.status === 410) return await signOut();
        if (res.status < 200 || res.status >= 300) throw parseError(res.status, res.body);
        const parsed = successEnvelopeSchema(CustomerTokensSchema).safeParse(res.body);
        if (!parsed.success) throw new BadResponseError(res.status, 'refresh: unexpected body');
        const next = toStored(parsed.data.data);
        await opts.tokens.save(next);
        return next;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function bearer(): Promise<StoredSession> {
    const session = await opts.tokens.load();
    if (!session) throw new SignedOutError('missing');
    if (Date.parse(session.accessExpiresAt) - now() < REFRESH_SKEW_MS) return refresh(session);
    return session;
  }

  async function call<K extends CustomerRouteKey>(
    key: K,
    input: CallInput = {},
  ): Promise<{ data: RouteData<K>; nextCursor: string | null }> {
    const route: Route<K> = CUSTOMER_ROUTES[key];
    const body = 'body' in route ? route.body.parse(input.body) : undefined;
    const idempotencyKey =
      route.idempotency === 'required' ? (input.idempotencyKey ?? opts.newKey()) : undefined;
    const path = buildPath(route.path, input.params, input.query);

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {};
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      if (route.auth === 'customer') headers.Authorization = `Bearer ${(await bearer()).accessToken}`;
      const req: HttpRequest = {
        method: route.method,
        path,
        headers,
        ...(body === undefined ? {} : { body }),
      };
      const res = await opts.transport(req);

      if (res.status >= 200 && res.status < 300) {
        const parsed = successEnvelopeSchema(route.data).safeParse(res.body);
        if (!parsed.success) throw new BadResponseError(res.status, `${key}: unexpected body`);
        return {
          data: parsed.data.data as RouteData<K>,
          nextCursor: parsed.data.meta.next_cursor ?? null,
        };
      }
      const error = parseError(res.status, res.body);
      if (route.auth === 'customer' && error instanceof ApiError && res.status === 401) {
        if (error.code === 'AUTH_SESSION_EXPIRED' && attempt === 0) {
          const session = await opts.tokens.load();
          if (!session) throw new SignedOutError('missing');
          await refresh(session);
          continue;
        }
        return signOut();
      }
      throw error;
    }
  }

  return {
    /** True when tokens are stored (the server still decides whether they are valid). */
    async hasSession(): Promise<boolean> {
      return (await opts.tokens.load()) !== null;
    },

    /** C-02 / C-03 «إعادة الإرسال»: a code is sent over WhatsApp. */
    async requestOtp(phoneE164: string, locale: CustomerLocale): Promise<CustomerOtpChallenge> {
      const body = {
        phone_e164: phoneE164,
        device_id: opts.device.id,
        platform: opts.device.platform,
        locale,
      };
      return (await call('otpRequest', { body })).data;
    },

    /** C-03: verifies the code, stores the session and returns the account. */
    async verifyOtp(phoneE164: string, code: string): Promise<CustomerAuthResult> {
      const body = { phone_e164: phoneE164, code, device_id: opts.device.id, platform: opts.device.platform };
      const { data } = await call('otpVerify', { body });
      await opts.tokens.save(toStored(data));
      return data;
    },

    /** Revokes this device's session on the server (best effort) and always forgets the tokens. */
    async logout(): Promise<void> {
      const session = await opts.tokens.load();
      try {
        if (session) await call('logout', { body: { refresh_token: session.refreshToken } });
      } catch {
        // offline or already revoked: the local sign-out still happens
      } finally {
        await opts.tokens.clear();
      }
    },

    async me(): Promise<CustomerMe> {
      return (await call('me')).data;
    },

    async updateMe(patch: CustomerMePatchBody, idempotencyKey?: string): Promise<CustomerMe> {
      return (await call('mePatch', { body: patch, idempotencyKey })).data;
    },

    async submitConsents(body: CustomerConsentsBody, idempotencyKey?: string): Promise<CustomerMe> {
      return (await call('consents', { body, idempotencyKey })).data;
    },

    async vehicles(): Promise<CustomerVehicle[]> {
      return (await call('vehicles')).data.items;
    },

    async addVehicle(body: CustomerVehicleCreateBody, idempotencyKey?: string): Promise<CustomerVehicle> {
      return (await call('vehicleCreate', { body, idempotencyKey })).data;
    },

    async locations(query: CustomerLocationListQuery = {}): Promise<Page<CustomerLocationSummary>> {
      const { data, nextCursor } = await call('locations', { query: { ...query } });
      return { items: data.items, nextCursor };
    },

    async location(venueId: string): Promise<CustomerLocationDetail> {
      return (await call('location', { params: { venueId } })).data;
    },

    async home(query: CustomerHomeQuery = {}): Promise<CustomerHome> {
      return (await call('home', { query: { ...query } })).data;
    },
  };
}

export type CustomerApi = ReturnType<typeof createCustomerApi>;
