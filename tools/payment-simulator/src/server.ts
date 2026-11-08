import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applePayBehaviour, cardByNumber, type CardBehaviour, type TestCard } from './cards.js';
import { PaymentSimulatorClient } from './client.js';
import { assertNotProduction, assertTestKey, type PaymentSimulatorOptions } from './config.js';
import { NotFound, PaymentSimulatorState, RefundRefused, type SimPayment } from './state.js';
import { deliver, emitChange, webhookBody } from './webhook.js';

const MAX_BODY = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Answer extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Moyasar's error body: `{ type, message, errors }`. */
const fail = (status: number, type: string, message: string, errors: unknown = null) =>
  new Answer(status, { type, message, errors });

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw fail(413, 'invalid_request_error', 'Request too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw fail(400, 'invalid_request_error', 'Malformed JSON');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** HTTP Basic with the key as the user name and an empty password (Moyasar's authentication). */
function keyOf(req: IncomingMessage): string | null {
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? decoded : decoded.slice(0, i);
}

function requireKey(
  state: PaymentSimulatorState,
  req: IncomingMessage,
  kinds: ('secret' | 'publishable')[],
): 'secret' | 'publishable' {
  const key = keyOf(req);
  if (key && /^(sk|pk)_live_/.test(key))
    throw fail(401, 'authentication_error', 'Live keys are refused by the simulator');
  if (key && kinds.includes('secret') && key === state.config.secretKey) return 'secret';
  if (key && kinds.includes('publishable') && key === state.config.publishableKey) return 'publishable';
  throw fail(401, 'authentication_error', 'Invalid authorization credentials');
}

function sourceOf(state: PaymentSimulatorState, raw: unknown, auth: 'secret' | 'publishable') {
  if (!isObj(raw) || typeof raw.type !== 'string')
    throw fail(400, 'invalid_request_error', 'Validation Failed', { source: ['is required'] });
  if (raw.type === 'token') {
    const t = typeof raw.token === 'string' ? state.tokens.get(raw.token) : undefined;
    if (!t) throw fail(400, 'invalid_request_error', 'Validation Failed', { 'source.token': ['is invalid'] });
    return {
      type: 'creditcard' as const,
      card: t.card,
      behaviour: behaviourOf(t.card, raw['3ds']),
      token: t.id,
    };
  }
  if (raw.type === 'applepay') {
    if (typeof raw.token !== 'string' || !raw.token)
      throw fail(400, 'invalid_request_error', 'Validation Failed', { 'source.token': ['is required'] });
    return { type: 'applepay' as const, card: null, behaviour: applePayBehaviour(raw.token), token: null };
  }
  if (raw.type === 'creditcard') {
    // card data may only be sent from the payer's device with the publishable key (Moyasar forbids it from a backend)
    if (auth !== 'publishable')
      throw fail(400, 'invalid_request_error', 'Card details must be sent from the payer device', {
        source: ['card data is not accepted with a secret key'],
      });
    const card = typeof raw.number === 'string' ? cardByNumber(raw.number) : null;
    if (!card)
      throw fail(400, 'invalid_request_error', 'Validation Failed', { 'source.number': ['is invalid'] });
    const token = raw.save_card === true ? state.tokenize({ number: card.number }).id : null;
    return { type: 'creditcard' as const, card, behaviour: behaviourOf(card, raw['3ds']), token };
  }
  throw fail(400, 'invalid_request_error', 'Validation Failed', { 'source.type': ['is not supported'] });
}

/** `3ds: false` skips the challenge of a 3-D Secure card (frictionless). */
function behaviourOf(card: TestCard, threeDs: unknown): CardBehaviour {
  if (threeDs === false && card.behaviour === '3ds_success') return 'success';
  if (threeDs === false && card.behaviour === '3ds_declined') return 'declined';
  return card.behaviour;
}

function createPayment(
  state: PaymentSimulatorState,
  body: unknown,
  auth: 'secret' | 'publishable',
): { status: number; payment: SimPayment } {
  if (!isObj(body)) throw fail(400, 'invalid_request_error', 'Validation Failed');
  const errors: Record<string, string[]> = {};
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100)
    errors.amount = ['must be an integer of at least 100 (1.00 SAR)'];
  const currency = typeof body.currency === 'string' ? body.currency : 'SAR';
  if (currency !== 'SAR') errors.currency = ['is not supported by the simulator'];
  const callbackUrl = typeof body.callback_url === 'string' ? body.callback_url : null;
  if (!callbackUrl) errors.callback_url = ['is required'];
  const givenId = body.given_id === undefined ? null : body.given_id;
  if (givenId !== null && (typeof givenId !== 'string' || !UUID.test(givenId)))
    errors.given_id = ['must be a UUID'];
  if (Object.keys(errors).length) throw fail(400, 'invalid_request_error', 'Validation Failed', errors);
  if (typeof givenId === 'string' && state.payments.has(givenId)) {
    const existing = state.payments.get(givenId)!;
    if (existing.amount !== amount) throw fail(400, 'invalid_request_error', 'Payment already exists');
    return { status: 201, payment: existing };
  }
  const metadata = isObj(body.metadata)
    ? Object.fromEntries(Object.entries(body.metadata).map(([k, v]) => [k, String(v)]))
    : null;
  const payment = state.createPayment({
    amount: amount as number,
    currency,
    description: typeof body.description === 'string' ? body.description : null,
    callbackUrl,
    metadata,
    givenId: givenId as string | null,
    source: sourceOf(state, body.source, auth),
  });
  emitChange(state, payment);
  return { status: 201, payment };
}

function listPayments(state: PaymentSimulatorState, url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const from = url.searchParams.get('created[gte]');
  const to = url.searchParams.get('created[lte]');
  const status = url.searchParams.get('status');
  const all = [...state.payments.values()]
    .filter(
      (p) =>
        (!from || p.created_at >= new Date(from).toISOString()) &&
        (!to || p.created_at <= new Date(to).toISOString()),
    )
    .filter((p) => !status || p.status === status)
    .sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id.localeCompare(b.id),
    );
  const size = state.config.pageSize;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  return {
    payments: all.slice((page - 1) * size, page * size),
    meta: {
      current_page: page,
      next_page: page < totalPages ? page + 1 : null,
      prev_page: page > 1 ? page - 1 : null,
      total_pages: totalPages,
      total_count: all.length,
    },
  };
}

/** `/v1/*`: the Moyasar API the server's adapter calls. */
async function api(
  state: PaymentSimulatorState,
  req: IncomingMessage,
  url: URL,
  method: string,
): Promise<[number, unknown]> {
  const parts = url.pathname.split('/').filter(Boolean); // v1, …
  if (parts[1] === 'tokens' && parts.length === 2 && method === 'POST') {
    requireKey(state, req, ['publishable']);
    const body = await readBody(req);
    if (!isObj(body) || typeof body.number !== 'string' || !cardByNumber(body.number))
      throw fail(400, 'invalid_request_error', 'Validation Failed', {
        number: ['is not a simulator test card'],
      });
    const { card: _card, ...token } = state.tokenize({
      number: body.number,
      name: typeof body.name === 'string' ? body.name : undefined,
      month: body.month as string | undefined,
      year: body.year as string | undefined,
    });
    return [201, { ...token, verification_url: null }];
  }
  // V2-023 (DEC-524): the server reads a saved card's token (brand, last four, expiry) and deletes it when the card
  // is removed — secret key only
  if (parts[1] === 'tokens' && parts.length === 3 && (method === 'GET' || method === 'DELETE')) {
    requireKey(state, req, ['secret']);
    const t = state.tokens.get(parts[2] ?? '');
    if (!t) throw fail(404, 'api_error', 'Object not found');
    if (method === 'DELETE') {
      state.tokens.delete(t.id);
      state.deletedTokens.add(t.id);
      return [204, ''];
    }
    const { card: _card, ...token } = t;
    return [200, { ...token, verification_url: null }];
  }
  if (parts[1] !== 'payments') throw fail(404, 'api_error', 'Not found');
  if (parts.length === 2 && method === 'POST') {
    const auth = requireKey(state, req, ['secret', 'publishable']);
    const r = createPayment(state, await readBody(req), auth);
    return [r.status, r.payment];
  }
  requireKey(state, req, ['secret']);
  if (parts.length === 2 && method === 'GET') return [200, listPayments(state, url)];
  const id = parts[2] ?? '';
  try {
    if (parts.length === 3 && method === 'GET') return [200, state.mustGet(id)];
    if (parts.length === 4 && parts[3] === 'refund' && method === 'POST') {
      const body = await readBody(req);
      const amount = isObj(body) && body.amount !== undefined ? body.amount : undefined;
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isInteger(amount)))
        throw fail(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be an integer'] });
      const p = state.refund(id, amount as number | undefined);
      emitChange(state, p, true);
      return [200, p];
    }
  } catch (e) {
    if (e instanceof NotFound) throw fail(404, 'api_error', 'Object not found');
    if (e instanceof RefundRefused) throw fail(400, 'invalid_request_error', e.message);
    throw e;
  }
  throw fail(404, 'api_error', 'Not found');
}

/** `/_sim/*` and `/sim/3ds/*`: the test controls (no authentication: local only). */
async function control(
  state: PaymentSimulatorState,
  req: IncomingMessage,
  url: URL,
  method: string,
): Promise<[number, unknown]> {
  const parts = url.pathname.split('/').filter(Boolean);
  const body = method === 'GET' ? {} : await readBody(req);
  const b = isObj(body) ? body : {};
  const route = `${method} /${parts
    .slice(1)
    .map((p, i) => (i === 1 && parts[1] === 'payments' ? ':id' : p))
    .join('/')}`;
  const id = parts[2] ?? '';
  try {
    switch (route) {
      case 'GET /health':
        return [200, { status: 'ok' }];
      case 'GET /config':
        return [200, { ...state.config, secretKey: '[set]', webhookSecret: '[set]' }];
      case 'PATCH /config': {
        for (const k of ['secretKey', 'publishableKey'] as const)
          if (typeof b[k] === 'string') assertTestKey(k, b[k] as string);
        Object.assign(state.config, b);
        return [200, { ok: true }];
      }
      case 'POST /reset':
        state.reset();
        return [200, { ok: true }];
      case 'POST /tokens':
        return [201, state.tokenize({ number: String(b.number ?? '') }).id];
      case 'GET /payments':
        return [200, [...state.payments.values()]];
      case 'GET /tokens':
        return [
          200,
          {
            active: [...state.tokens.keys()],
            deleted: [...state.deletedTokens],
          },
        ];
      case 'POST /payments': {
        // a payment made outside this platform (e.g. on the dashboard): unknown to the server
        const p = state.createPayment({
          amount: Number(b.amount ?? 1000),
          currency: 'SAR',
          description: 'external',
          callbackUrl: null,
          metadata: null,
          givenId: null,
          source: {
            type: 'creditcard',
            card: cardByNumber('4111111111111111'),
            behaviour: 'success',
            token: null,
          },
        });
        if (b.emit !== false) emitChange(state, p);
        return [201, p];
      }
      case 'GET /payments/:id':
        return [200, state.mustGet(id)];
      case 'POST /payments/:id/3ds': {
        const p = state.complete3ds(
          id,
          b.outcome === 'fail' ? 'fail' : b.outcome === 'success' ? 'success' : undefined,
        );
        emitChange(state, p);
        const redirect = new URL(p.callback_url ?? 'http://callback.invalid/');
        redirect.searchParams.set('id', p.id);
        redirect.searchParams.set('status', p.status);
        redirect.searchParams.set('message', p.source.message ?? '');
        return [200, { payment: p, redirect_url: redirect.toString() }];
      }
      case 'POST /payments/:id/mutate': {
        // reconciliation tests: the gateway's record changes without telling the platform
        const p = state.mustGet(id);
        if (typeof b.status === 'string') p.status = b.status as SimPayment['status'];
        if (typeof b.amount === 'number') p.amount = b.amount;
        if (typeof b.refunded === 'number') p.refunded = b.refunded;
        p.updated_at = state.iso();
        return [200, p];
      }
      case 'POST /payments/:id/webhook': {
        // an event built now from the payment (or with `status` overriding it), delivered or only returned
        const p = structuredClone(state.mustGet(id));
        if (typeof b.status === 'string') p.status = b.status as SimPayment['status'];
        const text = webhookBody(state, typeof b.type === 'string' ? b.type : 'payment_paid', p, {
          ...(typeof b.secret === 'string' ? { secret: b.secret } : {}),
        });
        if (b.deliver === false) return [200, { body: text }];
        const d = await deliver(state, text);
        return [200, { body: text, status: d.status }];
      }
      case 'GET /webhooks':
        return [200, state.deliveries];
      case 'POST /webhooks/flush':
        await state.idle();
        return [200, { deliveries: state.deliveries.length }];
      case 'POST /webhooks/replay': {
        const d = state.deliveries.find((x) => x.id === b.delivery_id || x.event_id === b.event_id);
        if (!d) throw new NotFound();
        const again = await deliver(state, d.body);
        return [200, { status: again.status }];
      }
      default:
        throw fail(404, 'api_error', `no control route ${route}`);
    }
  } catch (e) {
    if (e instanceof NotFound) throw fail(404, 'api_error', 'Object not found');
    if (e instanceof Answer) throw e;
    throw fail(400, 'invalid_request_error', (e as Error).message);
  }
}

/** The 3-D Secure page a customer would see (dev only): two buttons that complete the challenge. */
function threeDsPage(p: SimPayment): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>3-D Secure (محاكي)</title>
<body style="font-family:sans-serif;max-width:28rem;margin:3rem auto"><h1>التحقق ثلاثي الأبعاد — محاكي</h1>
<p>${(p.amount / 100).toFixed(2)} ${p.currency}</p>
<form method="post" action="/sim/3ds/${p.id}?outcome=success"><button>نجاح</button></form>
<form method="post" action="/sim/3ds/${p.id}?outcome=fail"><button>رفض</button></form></body></html>`;
}

export interface PaymentSimulatorServer {
  server: Server;
  state: PaymentSimulatorState;
}

/** Builds the HTTP server (not listening yet). Refuses to run in production. */
export function createPaymentSimulatorServer(opts: PaymentSimulatorOptions = {}): PaymentSimulatorServer {
  assertNotProduction(opts.env ?? process.env);
  const { port: _p, host: _h, env: _e, logger, now, ...config } = opts;
  for (const k of ['secretKey', 'publishableKey'] as const) if (config[k]) assertTestKey(k, config[k]);
  const state = new PaymentSimulatorState(config, now, logger);
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://payment-simulator.local');
    const method = (req.method ?? 'GET').toUpperCase();
    if (url.pathname.startsWith('/v1/')) {
      const [status, body] = await api(state, req, url, method);
      return send(res, status, body);
    }
    if (url.pathname.startsWith('/_sim/')) {
      const [status, body] = await control(state, req, url, method);
      return send(res, status, body);
    }
    const tds = /^\/sim\/3ds\/([^/]+)$/.exec(url.pathname);
    if (tds) {
      const p = state.payments.get(decodeURIComponent(tds[1]!));
      if (!p) return send(res, 404, 'not found', 'text/plain');
      if (method === 'GET') return send(res, 200, threeDsPage(p), 'text/html');
      const done = state.complete3ds(p.id, url.searchParams.get('outcome') === 'fail' ? 'fail' : 'success');
      emitChange(state, done);
      const back = new URL(done.callback_url ?? 'http://callback.invalid/');
      back.searchParams.set('id', done.id);
      back.searchParams.set('status', done.status);
      back.searchParams.set('message', done.source.message ?? '');
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    send(res, 404, { type: 'api_error', message: 'Not found', errors: null });
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof Answer) return send(res, err.status, err.body);
      state.log(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      send(res, 500, { type: 'api_error', message: 'simulator internal error', errors: null });
    });
  });
  return { server, state };
}

export interface RunningPaymentSimulator {
  /** Base URL, e.g. http://127.0.0.1:4020 — use it as MOYASAR_BASE_URL. */
  url: string;
  port: number;
  client: PaymentSimulatorClient;
  state: PaymentSimulatorState;
  close(): Promise<void>;
}

/** Starts the simulator in-process (the API integration tests run it without Docker). Port 0 = a free port. */
export async function startPaymentSimulator(
  opts: PaymentSimulatorOptions = {},
): Promise<RunningPaymentSimulator> {
  const host = opts.host ?? '127.0.0.1';
  const { server, state } = createPaymentSimulatorServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const publicHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${publicHost}:${port}`;
  state.baseUrl = url;
  let closed: Promise<void> | null = null;
  return {
    url,
    port,
    state,
    client: new PaymentSimulatorClient(url, state.config),
    close() {
      closed ??= new Promise<void>((resolve) => {
        void state.idle().finally(() => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      });
      return closed;
    },
  };
}
