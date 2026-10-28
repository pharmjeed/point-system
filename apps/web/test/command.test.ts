import { describe, expect, it, vi } from 'vitest';
import { CommandSession, fingerprint, newIdempotencyKey, retryDelayFor } from '@/api/command';
import { ApiError, NetworkError } from '@/api/errors';

const noSleep = () => Promise.resolve();
const business = (code: string, status = 409) => new ApiError({ code, status, message_ar: code });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Idempotency-Key per user intent (02 §1.8, 03 §3.1, 07 §1.4)', () => {
  it('generates UUIDv4 keys', () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it('retries a network failure automatically with the SAME key and body', async () => {
    const session = new CommandSession<{ a: number }>();
    const keys: string[] = [];
    const send = vi.fn(async (_: { a: number }, key: string) => {
      keys.push(key);
      if (keys.length < 3) throw new NetworkError('network');
      return 'ok';
    });
    await expect(session.run({ a: 1 }, send, { sleep: noSleep })).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps the key for a manual retry after the automatic retries are exhausted', async () => {
    const session = new CommandSession<{ a: number }>();
    const keys: string[] = [];
    const failing = async (_: { a: number }, key: string) => {
      keys.push(key);
      throw new NetworkError('timeout');
    };
    await expect(session.run({ a: 1 }, failing, { sleep: noSleep })).rejects.toBeInstanceOf(NetworkError);
    expect(keys).toHaveLength(4); // first try + 1 s, 3 s, 7 s
    await session.run({ a: 1 }, async (_, key) => keys.push(key), { sleep: noSleep });
    expect(new Set(keys).size).toBe(1); // «إعادة المحاولة» resends the same intent
  });

  it('uses a new key when the inputs changed', async () => {
    const session = new CommandSession<{ a: number }>();
    const first = session.keyFor({ a: 1 });
    expect(session.keyFor({ a: 1 })).toBe(first);
    expect(session.keyFor({ a: 2 })).not.toBe(first);
  });

  it('uses a new key after a definitive answer (success or a business error)', async () => {
    const session = new CommandSession<object>();
    const keys: string[] = [];
    await session.run({}, async (_, key) => keys.push(key), { sleep: noSleep });
    await expect(
      session.run(
        {},
        async (_, key) => {
          keys.push(key);
          throw business('DUTY_REQUIRED');
        },
        { sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    await session.run({}, async (_, key) => keys.push(key), { sleep: noSleep });
    expect(new Set(keys).size).toBe(3);
  });

  it('blocks double submission: a second press while pending sends nothing new', async () => {
    const session = new CommandSession<object>();
    let release: (v: string) => void = () => undefined;
    const send = vi.fn(() => new Promise<string>((r) => (release = r)));
    const a = session.run({}, send);
    const b = session.run({}, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.busy).toBe(true);
    release('done');
    await expect(a).resolves.toBe('done');
    await expect(b).resolves.toBe('done');
    expect(session.busy).toBe(false);
  });

  it('fingerprints inputs independently of key order', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe('retryDelayFor (08 §3 auto-retry, §8.2)', () => {
  it('backs off 1, 3, 7 s for network failures, then stops', () => {
    const e = new NetworkError('network');
    expect([0, 1, 2, 3].map((n) => retryDelayFor(e, n))).toEqual([1000, 3000, 7000, null]);
  });

  it('waits Retry-After (or 2 s) for IDEMPOTENCY_IN_PROGRESS', () => {
    expect(
      retryDelayFor(new ApiError({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409, retryAfterS: 1 }), 0),
    ).toBe(1000);
    expect(retryDelayFor(new ApiError({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 }), 0)).toBe(2000);
  });

  it('retries INTERNAL_ERROR once and never retries business errors or RATE_LIMITED', () => {
    const internal = new ApiError({ code: 'INTERNAL_ERROR', status: 500, retryable: true });
    expect(retryDelayFor(internal, 0)).toBe(1000);
    expect(retryDelayFor(internal, 1)).toBeNull();
    expect(retryDelayFor(business('TASK_ALREADY_CLAIMED'), 0)).toBeNull();
    expect(retryDelayFor(new ApiError({ code: 'RATE_LIMITED', status: 429, retryable: true }), 0)).toBeNull();
  });
});
