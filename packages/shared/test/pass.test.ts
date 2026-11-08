import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  CustomerPassSchema,
  generatePassToken,
  msUntilNextPassStep,
  parsePassToken,
  PASS_STEP_S,
  passStep,
  verifyPassToken,
} from '../src/customer/index.js';

/**
 * V2-013 (DEC-500): the entry pass token, shared by the customer app (offline generation) and the server (verification
 * at intake). Pure functions: the same input gives the same token on every platform.
 */
const ACCOUNT = '0f9c2b7e-3d41-4a5b-8c6d-7e8f9a0b1c2d';
const VEHICLE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const secret = base64UrlEncode(new Uint8Array(32).map((_, i) => i * 7 + 1));
const T0 = Date.parse('2026-11-08T10:00:10.000Z');

describe('base64url', () => {
  it('round-trips every length and matches node (no padding)', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      const text = base64UrlEncode(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect([...base64UrlDecode(text)!]).toEqual([...bytes]);
    }
  });

  it('refuses foreign characters and non-canonical endings', () => {
    expect(base64UrlDecode('ab+c')).toBeNull();
    expect(base64UrlDecode('abcde')).toBeNull();
    expect([...base64UrlDecode('AQ')!]).toEqual([1]);
    expect(base64UrlDecode('AB')).toBeNull(); // unused low bits set
  });
});

describe('pass token', () => {
  it('has the documented format and the HMAC of docs/v2/05 §1.3', () => {
    const t = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, nowMs: T0 });
    const step = Math.floor(T0 / 1000 / PASS_STEP_S);
    expect(t).toMatch(/^P1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{14}$/);
    expect(t.length).toBeLessThanOrEqual(80);
    const mac = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(`point-pass:v1:${ACCOUNT}:${VEHICLE}:${step}`)
      .digest()
      .subarray(0, 10)
      .toString('base64url');
    expect(t.split('.')[4]).toBe(mac);
    expect(parsePassToken(t)).toEqual({ accountId: ACCOUNT, vehicleId: VEHICLE, step, mac });
    const none = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: null, nowMs: T0 });
    expect(none.split('.')[2]).toBe('-');
    expect(parsePassToken(none)?.vehicleId).toBeNull();
  });

  it('changes every 30 s and is deterministic within a step', () => {
    const a = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, nowMs: T0 });
    const b = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, nowMs: T0 + 5_000 });
    const c = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, nowMs: T0 + 30_000 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(passStep(T0 + 30_000)).toBe(passStep(T0) + 1);
    expect(msUntilNextPassStep(Date.parse('2026-11-08T10:00:10.000Z'))).toBe(20_000);
    expect(msUntilNextPassStep(Date.parse('2026-11-08T10:00:30.000Z'))).toBe(30_000);
  });

  it('verifies within ± 1 step (clock skew) and expires outside', () => {
    const at = (offsetSteps: number) =>
      generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, step: passStep(T0) + offsetSteps });
    for (const o of [-1, 0, 1])
      expect(verifyPassToken({ token: at(o), secrets: [secret], nowMs: T0 })).toMatchObject({
        ok: true,
        accountId: ACCOUNT,
        vehicleId: VEHICLE,
        step: passStep(T0) + o,
        secretIndex: 0,
      });
    expect(verifyPassToken({ token: at(-2), secrets: [secret], nowMs: T0 })).toMatchObject({
      ok: false,
      reason: 'stale',
    });
    expect(verifyPassToken({ token: at(2), secrets: [secret], nowMs: T0 })).toMatchObject({
      ok: false,
      reason: 'future',
    });
  });

  it('refuses a tampered token, another secret, another vehicle, and accepts a previous secret in the list', () => {
    const t = generatePassToken({ secret, accountId: ACCOUNT, vehicleId: VEHICLE, nowMs: T0 });
    const other = base64UrlEncode(new Uint8Array(32).fill(9));
    expect(verifyPassToken({ token: t, secrets: [other], nowMs: T0 })).toEqual({ ok: false, reason: 'bad_mac' });
    expect(verifyPassToken({ token: t, secrets: [other, secret], nowMs: T0 })).toMatchObject({
      ok: true,
      secretIndex: 1,
    });
    const parts = t.split('.');
    const swapped = [parts[0], parts[1], parts[1], parts[3], parts[4]].join('.');
    expect(verifyPassToken({ token: swapped, secrets: [secret], nowMs: T0 })).toEqual({
      ok: false,
      reason: 'bad_mac',
    });
    const bumped = [parts[0], parts[1], parts[2], String(Number(parts[3]) + 1), parts[4]].join('.');
    expect(verifyPassToken({ token: bumped, secrets: [secret], nowMs: T0 })).toEqual({
      ok: false,
      reason: 'bad_mac',
    });
    for (const bad of ['', 'P1', 'P2.' + parts.slice(1).join('.'), t + '.x', 'P1.a.b.c.d', 'x'.repeat(200)])
      expect(verifyPassToken({ token: bad, secrets: [secret], nowMs: T0 })).toEqual({
        ok: false,
        reason: 'malformed',
      });
  });

  it('refuses bad inputs to the generator', () => {
    expect(() => generatePassToken({ secret: 'short', accountId: ACCOUNT, vehicleId: null })).toThrow();
    expect(() => generatePassToken({ secret, accountId: 'nope', vehicleId: null })).toThrow();
    expect(() => generatePassToken({ secret, accountId: ACCOUNT, vehicleId: null, step: -1 })).toThrow();
  });

  it('the GET /v1/customer/pass contract', () => {
    const ok = CustomerPassSchema.safeParse({
      scheme: 'P1',
      account_id: ACCOUNT,
      secret,
      step_seconds: 30,
      server_time: '2026-11-08T10:00:00.000Z',
      rotated_at: '2026-11-08T10:00:00.000Z',
      refresh_after: '2026-12-08T10:00:00.000Z',
      vehicles: [{ vehicle_id: VEHICLE, plate_display: '1234 ب ح د', vehicle_make: null, vehicle_color: null }],
    });
    expect(ok.success).toBe(true);
    expect(CustomerPassSchema.safeParse({ ...ok.data, secret: 'x' }).success).toBe(false);
  });
});
