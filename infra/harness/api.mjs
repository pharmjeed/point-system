// A staff client of the real API as the PWA talks to it: one session cookie, the CSRF headers of DEC-29, an
// Idempotency-Key on every ✓ command, Socket.IO on /ws with the same cookie and Origin. Every HTTP exchange is
// recorded (route template, status, error code, duration) for the run's statistics.
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from './deps.mjs';

/** One record per HTTP exchange of the run (shared by every client). */
export const httpLog = [];

/** `/v1/tasks/<uuid>/ready` → `/v1/tasks/{id}/ready` (statistics per route). */
export function routeOf(method, path) {
  return `${method} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')}`;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) of a base32 secret — the MFA code of a seeded owner. */
export function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export class ApiClient {
  /**
   * @param {string} base e.g. http://127.0.0.1:4100
   * @param {{ label?: string, cookieName?: string }} o
   */
  constructor(base, o = {}) {
    this.base = base;
    this.label = o.label ?? 'client';
    this.cookieName = o.cookieName ?? 'point_sid';
    this.cookie = null;
    this.userId = null;
  }

  /** Raw request; `key: true` adds a fresh Idempotency-Key, a string reuses one (a client retry). */
  async request(method, path, { body, key, timeoutMs = 30_000 } = {}) {
    const headers = { 'X-Requested-With': 'point-web', Origin: this.base, Accept: 'application/json' };
    if (this.cookie) headers.Cookie = `${this.cookieName}=${this.cookie}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const idempotencyKey = key === true ? `h-${randomUUID()}` : key || undefined;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const started = performance.now();
    const at = Date.now();
    const rec = {
      at,
      client: this.label,
      route: routeOf(method, path),
      status: 0,
      code: null,
      ms: 0,
      error: null,
    };
    try {
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      rec.ms = performance.now() - started;
      rec.status = res.status;
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const m = new RegExp(`${this.cookieName}=([^;]*)`).exec(setCookie);
        if (m) this.cookie = m[1] || null;
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      rec.code = json?.error?.code ?? null;
      httpLog.push(rec);
      return {
        status: res.status,
        ok: res.ok,
        data: json?.data,
        error: json?.error ?? null,
        replayed: res.headers.get('idempotent-replayed') === 'true',
        retryAfter: res.headers.get('retry-after'),
        key: idempotencyKey,
        ms: rec.ms,
      };
    } catch (e) {
      rec.ms = performance.now() - started;
      rec.error = e?.cause?.code ?? e?.name ?? 'network';
      httpLog.push(rec);
      return {
        status: 0,
        ok: false,
        data: null,
        error: { code: rec.error },
        replayed: false,
        retryAfter: null,
        key: idempotencyKey,
        ms: rec.ms,
      };
    }
  }

  get(path, o) {
    return this.request('GET', path, o);
  }

  /** A ✓ command with a fresh key; retried with the same key on 503/429/network (07 §1.4 client rule). */
  async command(method, path, body = {}, { retries = 4, key = true } = {}) {
    let k = key === true ? `h-${randomUUID()}` : key;
    let r;
    for (let attempt = 0; attempt <= retries; attempt++) {
      r = await this.request(method, path, { body, key: k });
      if (!(
        r.status === 0 ||
        r.status === 503 ||
        r.status === 429 ||
        r.error?.code === 'IDEMPOTENCY_IN_PROGRESS'
      ))
        return r;
      await sleep(Math.min(4000, 400 * 2 ** attempt));
    }
    return r;
  }

  /** Staff sign-in (phone + PIN or password), with the TOTP step when the account has MFA. */
  async login(phone, secret, totpSecret) {
    const r = await this.request('POST', '/v1/auth/login', { body: { phone, secret } });
    if (r.status !== 200) throw new Error(`${this.label}: login ${r.status} ${r.error?.code}`);
    if (r.data.mfa_required) {
      if (!totpSecret) throw new Error(`${this.label}: MFA required`);
      const v = await this.request('POST', '/v1/auth/mfa/verify', {
        body: { mfa_token: r.data.mfa_token, code: totp(totpSecret) },
      });
      if (v.status !== 200) throw new Error(`${this.label}: MFA ${v.status} ${v.error?.code}`);
      this.userId = v.data.user?.id ?? null;
      return v.data;
    }
    this.userId = r.data.me?.user?.id ?? null;
    return r.data.me;
  }

  /** Socket.IO on /ws with this session (the server decides the rooms). */
  socket({ wsPath = '/ws', reconnection = true } = {}) {
    return io(this.base, {
      path: wsPath,
      transports: ['websocket'],
      reconnection,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      extraHeaders: { origin: this.base, cookie: `${this.cookieName}=${this.cookie}` },
    });
  }
}

/** Resolves when the socket is connected (rejects on a refused handshake). */
export function connected(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve(socket);
    const t = setTimeout(() => reject(new Error('socket connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.once('connect_error', (e) => {
      clearTimeout(t);
      reject(
        Object.assign(new Error(`socket refused: ${e?.data?.code ?? e?.message}`), { code: e?.data?.code }),
      );
    });
  });
}
