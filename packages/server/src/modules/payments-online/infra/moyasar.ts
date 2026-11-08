import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ChargeSavedMethodInput,
  CreatePaymentInput,
  CreatedPayment,
  GatewayPayment,
  GatewayPaymentPage,
  GatewayResult,
  GatewayToken,
  PaymentGateway,
  WebhookVerification,
} from '../domain/gateway.js';
import { last4Of, PAN_LIKE, sanitizeWebhookBody } from '../domain/sanitize.js';

export interface MoyasarOptions {
  /** MOYASAR_BASE_URL: https://api.moyasar.com, or tools/payment-simulator */
  baseUrl: string;
  /** MOYASAR_HTTP_TIMEOUT_MS */
  timeoutMs: number;
  /** resolves MOYASAR_SECRET_KEY_REF when a call is made (never kept in a log or an error) */
  secretKey: () => Promise<string | null>;
  /** MOYASAR_WEBHOOK_SECRET_REF and, while it is rotated out, MOYASAR_WEBHOOK_SECRET_PREVIOUS_REF */
  webhookSecrets: () => Promise<string[]>;
  /**
   * DEC-510: which secret keys may be sent (keyAllowed). `live` (production only) sends `sk_live_…` only; `test`
   * (Moyasar's test API from local or staging) sends `sk_test_…` only; `simulator` never sends a live key. So no
   * real charge can leave dev, a test or staging, whatever MOYASAR_BASE_URL says.
   */
  keyPolicy: MoyasarKeyPolicy;
  fetch?: typeof fetch;
}

export type MoyasarKeyPolicy = 'live' | 'test' | 'simulator';

/** The keys a mode may send (DEC-510): live ↔ `sk_live_`, test ↔ `sk_test_`, the simulator anything but live. */
export function keyAllowed(policy: MoyasarKeyPolicy, key: string): boolean {
  if (policy === 'live') return key.startsWith('sk_live_');
  if (policy === 'test') return key.startsWith('sk_test_');
  return !/^(sk|pk)_live_/.test(key);
}

/** Constant-time equality of two strings of any length (their digests are compared). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** A short machine code for a failed or declined payment: the response code, else the message as a key. */
function failureCodeOf(source: Record<string, unknown>): string | null {
  const code = str(source.response_code);
  if (code && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  const msg = str(source.message);
  if (!msg) return null;
  const key = msg
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
  return key && !PAN_LIKE.test(key) ? key : null;
}

/** The gateway's payment object, normalized; the card number is reduced to its last four digits here. */
export function normalizePayment(raw: unknown): GatewayPayment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id) return null;
  const source = (p.source && typeof p.source === 'object' ? p.source : {}) as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  if (p.metadata && typeof p.metadata === 'object')
    for (const [k, v] of Object.entries(p.metadata as Record<string, unknown>))
      if (typeof v === 'string' || typeof v === 'number') metadata[k] = String(v);
  return {
    id,
    status: str(p.status) ?? 'unknown',
    amount: int(p.amount),
    currency: str(p.currency) ?? 'SAR',
    refunded: int(p.refunded),
    createdAt: str(p.created_at),
    updatedAt: str(p.updated_at),
    metadata,
    source: {
      type: str(source.type),
      company: str(source.company)?.toLowerCase() ?? null,
      last4: last4Of(source.number),
      failureCode: failureCodeOf(source),
      transactionUrl: str(source.transaction_url),
      token: str(source.token),
    },
  };
}

/**
 * The gateway's token object (V2-023, DEC-524), as `GET /v1/tokens/{id}` answers it: `last_four`, `brand`,
 * `month`/`year` (strings or numbers). Not confirmed against Moyasar's live documentation from this environment
 * (the domain is blocked, as in DEC-510): the simulator implements this shape; review before H3.
 */
export function normalizeToken(raw: unknown): GatewayToken | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const id = str(t.id);
  if (!id) return null;
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? Number(v) : NaN;
    return Number.isInteger(n) ? n : null;
  };
  const year = num(t.year);
  const last4 = str(t.last_four) ?? str(t.last4);
  return {
    id,
    status: str(t.status) ?? 'unknown',
    brand: str(t.brand)?.toLowerCase() ?? null,
    last4: last4 && /^[0-9]{4}$/.test(last4) ? last4 : null,
    month: num(t.month),
    year: year !== null && year < 100 ? 2000 + year : year,
  };
}

/**
 * The Moyasar adapter (V2-020, DEC-511) over its REST API: `POST /v1/payments` (amount in halalas, `given_id`,
 * `callback_url`, a `token` or `applepay` source — card data is never sent from a backend), `GET /v1/payments/{id}`,
 * `GET /v1/payments` (pages), `POST /v1/payments/{id}/refund`. Authentication is HTTP Basic with the secret key as
 * the user name and an empty password; every call has an explicit timeout; the key is only ever in the
 * Authorization header. Webhooks carry the endpoint's shared secret as `secret_token` in the body (Moyasar documents
 * no signature header): it is compared in constant time with the configured secret(s) before anything else is read.
 */
export class MoyasarGateway implements PaymentGateway {
  readonly name = 'moyasar' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MoyasarOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/${path}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    parse: (json: unknown) => T | null,
  ): Promise<GatewayResult<T>> {
    const key = await this.opts.secretKey().catch(() => null);
    if (!key)
      return { ok: false, kind: 'refused', status: null, type: null, message: 'gateway key not configured' };
    if (!keyAllowed(this.opts.keyPolicy, key))
      return {
        ok: false,
        kind: 'refused',
        status: null,
        type: null,
        message: `key refused in ${this.opts.keyPolicy} mode`,
      };
    try {
      const res = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = null;
      }
      if (res.ok) {
        const value = parse(json);
        if (value === null)
          return {
            ok: false,
            kind: 'http',
            status: res.status,
            type: 'malformed',
            message: 'unexpected answer',
          };
        return { ok: true, status: res.status, value };
      }
      const err = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
      return {
        ok: false,
        kind: 'http',
        status: res.status,
        type: str(err.type),
        // the gateway's message is generic; card digits never pass (the request carried none)
        message: (str(err.message) ?? `HTTP ${res.status}`).replace(/[0-9]{13,}/g, '[REMOVED]').slice(0, 200),
      };
    } catch (e) {
      const name = (e as Error)?.name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      return {
        ok: false,
        kind: timeout ? 'timeout' : 'network',
        status: null,
        type: null,
        message: timeout ? `no answer within ${this.opts.timeoutMs} ms` : 'gateway unreachable',
      };
    }
  }

  private created(json: unknown): CreatedPayment | null {
    const payment = normalizePayment(json);
    if (!payment) return null;
    return {
      payment,
      actionUrl: payment.status === 'initiated' ? payment.source.transactionUrl : null,
    };
  }

  createPayment(input: CreatePaymentInput): Promise<GatewayResult<CreatedPayment>> {
    return this.request(
      'POST',
      'payments',
      {
        given_id: input.givenId,
        amount: input.amountHalalas,
        currency: 'SAR',
        description: input.description,
        callback_url: input.callbackUrl,
        source: { type: input.source.type, token: input.source.token },
        metadata: input.metadata,
      },
      (j) => this.created(j),
    );
  }

  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<GatewayResult<CreatedPayment>> {
    // the gateway applies 3-D Secure by the token's own status (an active token is charged without a challenge;
    // a recurring/merchant-initiated flag could not be confirmed in its documentation, DEC-511)
    const { token, ...rest } = input;
    return this.createPayment({ ...rest, source: { type: 'token', token } });
  }

  refund(id: string, amountHalalas?: number): Promise<GatewayResult<GatewayPayment>> {
    return this.request(
      'POST',
      `payments/${encodeURIComponent(id)}/refund`,
      amountHalalas === undefined ? {} : { amount: amountHalalas },
      normalizePayment,
    );
  }

  fetchPayment(id: string): Promise<GatewayResult<GatewayPayment>> {
    return this.request('GET', `payments/${encodeURIComponent(id)}`, undefined, normalizePayment);
  }

  listPayments(input: { from: Date; to: Date; page: number }): Promise<GatewayResult<GatewayPaymentPage>> {
    const q = new URLSearchParams({
      page: String(input.page),
      'created[gte]': input.from.toISOString(),
      'created[lte]': input.to.toISOString(),
    });
    return this.request('GET', `payments?${q.toString()}`, undefined, (j) => {
      if (!j || typeof j !== 'object') return null;
      const o = j as { payments?: unknown; meta?: { next_page?: unknown } };
      if (!Array.isArray(o.payments)) return null;
      const payments = o.payments.map(normalizePayment).filter((p): p is GatewayPayment => p !== null);
      const next = o.meta?.next_page;
      return {
        payments,
        // without pagination metadata a full page is followed by a request for the next one (DEC-511)
        nextPage:
          typeof next === 'number' ? next : next === null ? null : payments.length ? input.page + 1 : null,
      };
    });
  }

  fetchToken(token: string): Promise<GatewayResult<GatewayToken>> {
    return this.request('GET', `tokens/${encodeURIComponent(token)}`, undefined, normalizeToken);
  }

  async deleteToken(token: string): Promise<GatewayResult<null>> {
    // any 2xx answer (with or without a body) is a deletion
    const r = await this.request('DELETE', `tokens/${encodeURIComponent(token)}`, undefined, () => ({}));
    return r.ok ? { ok: true, status: r.status, value: null } : r;
  }

  async verifyWebhook(raw: Buffer): Promise<WebhookVerification> {
    const secrets = (await this.opts.webhookSecrets().catch(() => [])).filter(Boolean);
    if (!secrets.length) return { ok: false, reason: 'not_configured' };
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return { ok: false, reason: 'not_json' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'not_json' };
    const b = body as Record<string, unknown>;
    const given = typeof b.secret_token === 'string' ? b.secret_token : '';
    if (!given) return { ok: false, reason: 'no_secret' };
    let ok = false;
    for (const s of secrets) if (constantTimeEqual(given, s)) ok = true; // same work for every secret
    if (!ok) return { ok: false, reason: 'secret_mismatch' };
    const id = str(b.id);
    const type = str(b.type);
    if (!id || !type) return { ok: false, reason: 'malformed' };
    const data = b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : {};
    return {
      ok: true,
      event: {
        id,
        type,
        createdAt: str(b.created_at),
        live: typeof b.live === 'boolean' ? b.live : null,
        paymentId: str(data.id),
        sanitized: sanitizeWebhookBody(b),
      },
    };
  }
}
