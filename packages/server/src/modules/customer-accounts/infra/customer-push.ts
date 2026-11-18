import type { Env } from '../../../core/config/env.js';
import { loadEnv } from '../../../core/config/env.js';
import { createLogger, type Logger } from '../../../core/logging/logger.js';
import { SecretResolver } from '../../../core/secrets/secret-resolver.js';
import type { CustomerPushMessage } from '../application/push-messages.js';

/**
 * `CustomerPushSender` (V2-016, DEC-519): the provider of the customer app's pushes behind one interface — the Expo
 * Push API (`live`, production only) or the in-process simulator (every other environment, and tests). The worker
 * calls it outside any transaction (canon rule 3).
 *
 * Facts of the Expo Push API (from the official `expo-server-sdk` 8.0.0, read at implementation time because the
 * documentation host is not reachable from the build environment; to re-check before H2): `POST
 * https://exp.host/--/api/v2/push/send` with a JSON array of at most 100 messages answers `{ data: [ticket…] }` in
 * the same order, a ticket being `{ status: 'ok', id }` or `{ status: 'error', message, details: { error } }`;
 * `POST https://exp.host/--/api/v2/push/getReceipts` with `{ ids }` (at most 300) answers `{ data: { <id>: receipt } }`,
 * receipts being kept about a day; `details.error = 'DeviceNotRegistered'` means the token must not be used again;
 * an access token, when the project enables push security, goes in `Authorization: Bearer`; HTTP 429 is a rate limit.
 */
export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; error: string | null };
export type PushReceipt = { status: 'ok' } | { status: 'error'; error: string | null };

export interface CustomerPushSender {
  readonly provider: 'expo' | 'simulator';
  /** One ticket per message, in order. Throws {@link CustomerPushTransportError} when the provider was not reached. */
  send(messages: CustomerPushMessage[]): Promise<PushTicket[]>;
  /** The receipts known for these ids (an id still unknown to the provider is absent). */
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

export class CustomerPushTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CustomerPushTransportError';
  }
}

export const EXPO_PUSH_BASE_URL = 'https://exp.host';
export const EXPO_PUSH_SEND_LIMIT = 100;
export const EXPO_PUSH_RECEIPTS_LIMIT = 300;
/** The token is gone (app uninstalled, notifications revoked): never sent to again. */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/** The Expo Push API adapter (HTTPS; optional access token resolved by reference on every call). */
export class ExpoPushSender implements CustomerPushSender {
  readonly provider = 'expo' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      baseUrl?: string;
      timeoutMs: number;
      accessToken: () => Promise<string | null>;
      fetch?: typeof fetch;
    },
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const token = await this.opts.accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl ?? EXPO_PUSH_BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new CustomerPushTransportError(`expo push unreachable: ${(e as Error).name}`, true);
    }
    if (res.status === 429 || res.status >= 500)
      throw new CustomerPushTransportError(`expo push http ${res.status}`, true);
    if (res.status !== 200) throw new CustomerPushTransportError(`expo push http ${res.status}`, false);
    const json = (await res.json().catch(() => null)) as { data?: unknown; errors?: unknown } | null;
    if (!json || json.errors || json.data === undefined)
      throw new CustomerPushTransportError('expo push: unexpected body', false);
    return json.data;
  }

  async send(messages: CustomerPushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) return [];
    if (messages.length > EXPO_PUSH_SEND_LIMIT) throw new Error('at most 100 messages per send');
    const data = await this.post(
      '/--/api/v2/push/send',
      messages.map((m) => ({
        to: m.to,
        title: m.title,
        body: m.body,
        data: m.data,
        sound: 'default',
        priority: 'high',
        channelId: 'visits',
      })),
    );
    if (!Array.isArray(data) || data.length !== messages.length)
      throw new CustomerPushTransportError('expo push: ticket count mismatch', false);
    return data.map((t: { status?: string; id?: string; details?: { error?: string } }) =>
      t?.status === 'ok' && typeof t.id === 'string'
        ? { status: 'ok', id: t.id }
        : { status: 'error', error: t?.details?.error ?? null },
    );
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    if (ids.length === 0) return {};
    if (ids.length > EXPO_PUSH_RECEIPTS_LIMIT) throw new Error('at most 300 receipts per call');
    const data = await this.post('/--/api/v2/push/getReceipts', { ids });
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new CustomerPushTransportError('expo receipts: unexpected body', false);
    const out: Record<string, PushReceipt> = {};
    for (const [id, r] of Object.entries(
      data as Record<string, { status?: string; details?: { error?: string } }>,
    ))
      out[id] = r?.status === 'ok' ? { status: 'ok' } : { status: 'error', error: r?.details?.error ?? null };
    return out;
  }
}

export interface SimulatedPush {
  id: string;
  to: string;
  title: string;
  body: string;
  data: CustomerPushMessage['data'];
  at: Date;
}

/**
 * The push simulator (dev, tests, CI, staging): records what would have been sent and never opens a connection —
 * no real device receives a push outside production (CUSTOMER_PUSH_MODE rules, like WA_MODE / MOYASAR_MODE).
 * `unregister(token)` makes the provider answer `DeviceNotRegistered` at send; `failReceipt(token)` at the receipt.
 */
export class CustomerPushSimulator implements CustomerPushSender {
  readonly provider = 'simulator' as const;
  readonly sent: SimulatedPush[] = [];
  private readonly gone = new Set<string>();
  private readonly receiptGone = new Set<string>();
  private readonly byId = new Map<string, string>();
  private seq = 0;
  /** a transport failure for the next n sends (retry tests) */
  failNext = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  unregister(token: string): void {
    this.gone.add(token);
  }

  failReceipt(token: string): void {
    this.receiptGone.add(token);
  }

  clear(): void {
    this.sent.length = 0;
    this.gone.clear();
    this.receiptGone.clear();
    this.byId.clear();
    this.failNext = 0;
  }

  async send(messages: CustomerPushMessage[]): Promise<PushTicket[]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new CustomerPushTransportError('simulated outage', true);
    }
    return messages.map((m) => {
      if (this.gone.has(m.to)) return { status: 'error', error: DEVICE_NOT_REGISTERED };
      const id = `sim-${++this.seq}`;
      this.byId.set(id, m.to);
      this.sent.push({ id, to: m.to, title: m.title, body: m.body, data: m.data, at: this.now() });
      return { status: 'ok', id };
    });
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (const id of ids) {
      const to = this.byId.get(id);
      if (to === undefined) continue;
      out[id] = this.receiptGone.has(to)
        ? { status: 'error', error: DEVICE_NOT_REGISTERED }
        : { status: 'ok' };
    }
    return out;
  }
}

export interface CustomerPushDeps {
  env: Env;
  secrets?: SecretResolver;
  logger?: Logger;
  secretEnv?: Record<string, string | undefined>;
  /** test seam: another sender (the simulator of a test, a failing one) */
  sender?: CustomerPushSender;
  fetch?: typeof fetch;
}

/**
 * Process-wide customer push dependencies (worker jobs). `CUSTOMER_PUSH_MODE=live` reaches Expo from production only
 * (loadEnv refuses it elsewhere, and a hand-built Env outside production still gets the simulator here).
 */
export class CustomerPushRuntime {
  readonly env: Env;
  readonly secrets: SecretResolver;
  readonly logger: Logger;
  readonly sender: CustomerPushSender;

  constructor(deps: CustomerPushDeps) {
    this.env = deps.env;
    this.secrets = deps.secrets ?? new SecretResolver(deps.secretEnv ?? process.env);
    this.logger = deps.logger ?? createLogger({ level: deps.env.LOG_LEVEL, name: 'point-customer-push' });
    const live = deps.env.CUSTOMER_PUSH_MODE === 'live' && deps.env.APP_ENV === 'production';
    this.sender =
      deps.sender ??
      (live
        ? new ExpoPushSender({
            timeoutMs: deps.env.CUSTOMER_PUSH_HTTP_TIMEOUT_MS,
            accessToken: () => this.secrets.resolve(deps.env.CUSTOMER_PUSH_ACCESS_TOKEN_REF),
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          })
        : defaultCustomerPushSimulator());
  }
}

let simulator: CustomerPushSimulator | null = null;
/** The process's simulator (what dev and staging «sent»). */
export function defaultCustomerPushSimulator(): CustomerPushSimulator {
  simulator ??= new CustomerPushSimulator();
  return simulator;
}

let defaultRuntime: CustomerPushRuntime | null = null;
/** The worker builds its runtime lazily from process.env (already validated by loadEnvOrExit). */
export function defaultCustomerPushRuntime(): CustomerPushRuntime {
  defaultRuntime ??= new CustomerPushRuntime({ env: loadEnv(process.env) });
  return defaultRuntime;
}
