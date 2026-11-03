import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiFetch, freshServerTime, onApiError, onApiSuccess } from '@/api/client';
import { ApiError, NetworkError, displayMessage } from '@/api/errors';
import { errorMessagesAr } from '@/i18n/errors';
import { clockOffsetMs } from '@/lib/serverClock';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  });
}

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('apiFetch (07 §1, DEC-29)', () => {
  it('sends same-origin requests with the session cookie and parses the {data, meta} envelope', async () => {
    const serverTime = new Date(Date.now() + 120_000).toISOString();
    vi.stubGlobal(
      'fetch',
      respond(200, { data: { ok: true }, meta: { request_id: 'req_1', server_time: serverTime } }),
    );
    const res = await api.get<{ ok: boolean }>('/v1/me');
    expect(res.data).toEqual({ ok: true });
    expect(res.meta.request_id).toBe('req_1');
    expect(calls[0]?.url).toBe('/v1/me');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(header(calls[0], 'X-Requested-With')).toBeNull(); // safe method: no CSRF header needed
    expect(header(calls[0], 'Idempotency-Key')).toBeNull();
    // meta.server_time feeds the server clock (02 §1.7)
    expect(clockOffsetMs()).toBeGreaterThan(110_000);
  });

  it('a replayed answer (meta.replayed) never moves the server clock nor «آخر مزامنة» (realtime:RT-4)', async () => {
    const now = new Date().toISOString();
    vi.stubGlobal('fetch', respond(200, { data: {}, meta: { request_id: 'r0', server_time: now } }));
    await api.get('/v1/me');
    const before = clockOffsetMs();
    // 07 §1.4: the stored answer of the first attempt, 90 s old, replayed verbatim
    const stored = new Date(Date.now() - 90_000).toISOString();
    vi.stubGlobal(
      'fetch',
      respond(
        201,
        { data: { id: 't' }, meta: { request_id: 'r1', server_time: stored, replayed: true } },
        { 'Idempotent-Replayed': 'true' },
      ),
    );
    const seen: Array<string | null> = [];
    const off = onApiSuccess(({ meta }) => seen.push(freshServerTime(meta)));
    const res = await api.post('/v1/tickets', { body: {}, idempotencyKey: 'k-1' });
    off();
    expect(res.meta.replayed).toBe(true);
    expect(Math.abs(clockOffsetMs() - before)).toBeLessThan(5_000);
    expect(seen).toEqual([null]);
    // the header alone marks the replay too
    vi.stubGlobal(
      'fetch',
      respond(
        201,
        { data: {}, meta: { request_id: 'r2', server_time: stored } },
        { 'Idempotent-Replayed': 'true' },
      ),
    );
    await api.post('/v1/tickets', { body: {}, idempotencyKey: 'k-1' });
    expect(Math.abs(clockOffsetMs() - before)).toBeLessThan(5_000);
    expect(freshServerTime({ request_id: 'r3', server_time: now })).toBe(now);
  });

  it('adds X-Requested-With: point-web on every unsafe method and Idempotency-Key when given', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, { data: {}, meta: { request_id: 'r', server_time: new Date().toISOString() } }),
    );
    await api.post('/v1/auth/login', { body: { phone: '+966551234567', secret: 'x' } });
    await api.post('/v1/me/duty/start', { body: {}, idempotencyKey: 'key-123' });
    await api.patch('/v1/tickets/t/intake', { body: { a: 1 }, idempotencyKey: 'key-456' });
    await api.put('/v1/me/devices/d', { body: {} });
    for (const call of calls) expect(header(call, 'X-Requested-With')).toBe('point-web');
    expect(header(calls[0], 'Idempotency-Key')).toBeNull();
    expect(header(calls[1], 'Idempotency-Key')).toBe('key-123');
    expect(header(calls[2], 'Idempotency-Key')).toBe('key-456');
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ phone: '+966551234567', secret: 'x' }));
  });

  it('throws ApiError with code, message_ar, status, details, retryable and Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      respond(
        429,
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests.',
            message_ar: 'طلبات كثيرة. انتظر قليلًا ثم حاول.',
            request_id: 'req_9',
            retryable: true,
            details: { retry_after_s: 30 },
          },
        },
        { 'Retry-After': '30' },
      ),
    );
    const listener = vi.fn();
    const off = onApiError(listener);
    const error = await api.post('/v1/tickets', { body: {} }).catch((e: unknown) => e);
    off();
    expect(error).toBeInstanceOf(ApiError);
    const e = error as ApiError;
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.status).toBe(429);
    expect(e.message_ar).toBe('طلبات كثيرة. انتظر قليلًا ثم حاول.');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterS).toBe(30);
    expect(e.requestId).toBe('req_9');
    expect(e.details).toEqual({ retry_after_s: 30 });
    expect(listener).toHaveBeenCalledWith(e, { method: 'POST', path: '/v1/tickets', status: 429 });
  });

  it('exposes VALIDATION_FAILED field errors', async () => {
    vi.stubGlobal(
      'fetch',
      respond(422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are invalid.',
          message_ar: 'تحقّق من الحقول المحددة.',
          request_id: 'r',
          retryable: false,
          details: { fields: [{ field: 'phone', issue: 'invalid', message_ar: 'رقم الجوال غير صالح.' }] },
        },
      }),
    );
    const e = (await api.post('/v1/auth/login', { body: {} }).catch((x: unknown) => x)) as ApiError;
    expect(e.fields).toEqual([{ field: 'phone', issue: 'invalid', message_ar: 'رقم الجوال غير صالح.' }]);
  });

  it('falls back to the 08 text when a reply carries no envelope (e.g. a proxy 502)', async () => {
    vi.stubGlobal('fetch', respond(502, '<html>bad gateway</html>', { 'X-Request-Id': 'req_gw' }));
    const e = (await api.get('/v1/me').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.retryable).toBe(true);
    expect(e.message_ar).toBe(errorMessagesAr.INTERNAL_ERROR);
  });

  it('handles 204 No Content', async () => {
    vi.stubGlobal('fetch', respond(204, undefined));
    const res = await api.post<void>('/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(res.data).toBeUndefined();
  });

  it('turns a failed fetch into NetworkError (outcome unknown)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const e = await api.post('/v1/me/duty/start', { body: {}, idempotencyKey: 'k' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).reason).toBe('network');
    expect(displayMessage(e)).toBe('تعذر الوصول للخادم. سنعيد إرسال الطلب نفسه دون تكرار.');
  });

  it('times out after 10 s without a reply (02 §1.8)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    );
    const pending = apiFetch('POST', '/v1/me/duty/start', { body: {}, idempotencyKey: 'k' }).catch(
      (x: unknown) => x,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const e = await pending;
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).reason).toBe('timeout');
  });
});
