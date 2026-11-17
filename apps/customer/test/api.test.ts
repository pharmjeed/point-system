/**
 * V2-011: the typed client against the fake backend — the R1 journey (C-02 … C-06) and the contract rules the
 * server (V2-010) must keep: WhatsApp-only codes, resend wait, attempts and lock, token refresh and rotation,
 * versioned consents, plate normalisation, vehicle limit, idempotent writes, envelopes.
 */
import {
  CUSTOMER_OTP_MAX_ATTEMPTS,
  CUSTOMER_OTP_RESEND_AFTER_S,
  CUSTOMER_VEHICLES_MAX,
} from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError, BadResponseError, SignedOutError } from '../src/api/errors';
import { NetworkError } from '../src/api/transport';
import { onboard, PHONE, setup, signIn } from './helpers';

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('sign-in with a WhatsApp code (C-02, C-03)', () => {
  it('sends a code over WhatsApp with the server times of C-03', async () => {
    const ctx = setup();
    const c = await ctx.api.requestOtp(PHONE, 'ar');
    expect(c.channel).toBe('whatsapp');
    expect(c.phone_masked).toBe('05•••••678');
    expect(c.attempts_left).toBe(CUSTOMER_OTP_MAX_ATTEMPTS);
    expect(Date.parse(c.resend_available_at) - ctx.clock.now()).toBe(CUSTOMER_OTP_RESEND_AFTER_S * 1000);
    expect(ctx.backend.lastCode(PHONE)).toMatch(/^\d{6}$/);
  });

  it('refuses a resend before 60 s with retry_after_s, then allows it', async () => {
    const ctx = setup();
    await ctx.api.requestOtp(PHONE, 'ar');
    ctx.clock.advance(20_000);
    const e = await rejection(ctx.api.requestOtp(PHONE, 'ar'));
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.detailNumber('retry_after_s')).toBe(40);
    ctx.clock.advance(40_000);
    await expect(ctx.api.requestOtp(PHONE, 'ar')).resolves.toMatchObject({ channel: 'whatsapp' });
    expect(ctx.backend.inbox).toHaveLength(2);
  });

  it('refuses a non-Saudi or malformed number before and on the server', async () => {
    const ctx = setup();
    await expect(ctx.api.requestOtp('+447911123456', 'ar')).rejects.toThrow(); // the client contract refuses
    const raw = await ctx.backend.transport({
      method: 'POST',
      path: '/v1/customer/auth/otp',
      headers: {},
      body: { phone_e164: '0412345678', device_id: 'device-test-0001', platform: 'ios' },
    });
    expect(raw.status).toBe(422);
    expect((raw.body as { error: { code: string } }).error.code).toBe('PHONE_INVALID');
  });

  it('counts wrong codes down and locks for 15 minutes after the fifth', async () => {
    const ctx = setup();
    await ctx.api.requestOtp(PHONE, 'ar');
    const right = ctx.backend.lastCode(PHONE) as string;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let left = CUSTOMER_OTP_MAX_ATTEMPTS - 1; left >= 1; left--) {
      const e = await rejection(ctx.api.verifyOtp(PHONE, wrong));
      expect(e.code).toBe('CUSTOMER_OTP_INVALID');
      expect(e.detailNumber('attempts_left')).toBe(left);
    }
    const locked = await rejection(ctx.api.verifyOtp(PHONE, wrong));
    expect(locked.code).toBe('CUSTOMER_OTP_LOCKED');
    expect(Date.parse(locked.detailString('locked_until') as string) - ctx.clock.now()).toBe(15 * 60_000);
    // the right code no longer helps, and no new code is sent during the lock
    expect((await rejection(ctx.api.verifyOtp(PHONE, right))).code).toBe('CUSTOMER_OTP_LOCKED');
    expect((await rejection(ctx.api.requestOtp(PHONE, 'ar'))).code).toBe('CUSTOMER_OTP_LOCKED');
    ctx.clock.advance(15 * 60_000);
    await ctx.api.requestOtp(PHONE, 'ar');
    await expect(ctx.api.verifyOtp(PHONE, ctx.backend.lastCode(PHONE) as string)).resolves.toMatchObject({
      is_new_account: true,
    });
  });

  it('expires a code after its lifetime', async () => {
    const ctx = setup();
    await ctx.api.requestOtp(PHONE, 'ar');
    ctx.clock.advance(5 * 60_000);
    expect((await rejection(ctx.api.verifyOtp(PHONE, ctx.backend.lastCode(PHONE) as string))).code).toBe(
      'CUSTOMER_OTP_EXPIRED',
    );
  });

  it('creates the account once, stores the session, and the profile starts incomplete', async () => {
    const ctx = setup();
    const first = await signIn(ctx);
    expect(first.is_new_account).toBe(true);
    expect(first.account.profile_complete).toBe(false);
    expect(first.account.consents.terms.granted).toBeNull();
    expect(ctx.tokens.peek()?.refreshToken).toBe(first.refresh_token);
    ctx.clock.advance(61_000);
    const again = await signIn(ctx);
    expect(again.is_new_account).toBe(false);
    expect(again.account.id).toBe(first.account.id);
  });
});

describe('session (access + rotating refresh token)', () => {
  it('refreshes ahead of expiry and rotates the refresh token', async () => {
    const ctx = setup();
    await signIn(ctx);
    const before = ctx.tokens.peek();
    ctx.clock.advance(15 * 60_000);
    await expect(ctx.api.me()).resolves.toMatchObject({ phone_e164: PHONE });
    const after = ctx.tokens.peek();
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
  });

  it('refreshes once after 401 AUTH_SESSION_EXPIRED and retries the call', async () => {
    const ctx = setup();
    await signIn(ctx);
    const stored = ctx.tokens.peek();
    if (!stored) throw new Error('no session');
    // the device thinks the token is fresh; the server says it expired
    await ctx.tokens.save({
      ...stored,
      accessExpiresAt: new Date(ctx.clock.now() + 3_600_000).toISOString(),
    });
    ctx.clock.advance(16 * 60_000);
    await expect(ctx.api.me()).resolves.toMatchObject({ phone_e164: PHONE });
    expect(ctx.tokens.peek()?.refreshToken).not.toBe(stored.refreshToken);
  });

  it('shares one refresh between concurrent calls', async () => {
    const ctx = setup();
    await onboard(ctx);
    ctx.clock.advance(15 * 60_000);
    const [me, vehicles, home] = await Promise.all([ctx.api.me(), ctx.api.vehicles(), ctx.api.home()]);
    expect(me.profile_complete).toBe(true);
    expect(vehicles).toEqual([]);
    expect(home.display_name).toBe('سارة');
    expect(ctx.signedOut).toEqual([]);
  });

  it('signs out when a rotated refresh token is replayed (and revokes the session)', async () => {
    const ctx = setup();
    await signIn(ctx);
    const old = ctx.tokens.peek();
    if (!old) throw new Error('no session');
    ctx.clock.advance(15 * 60_000);
    await ctx.api.me(); // rotates
    await ctx.tokens.save({ ...old, accessExpiresAt: new Date(0).toISOString() });
    await expect(ctx.api.me()).rejects.toBeInstanceOf(SignedOutError);
    expect(ctx.signedOut).toEqual(['revoked']);
    expect(ctx.tokens.peek()).toBeNull();
  });

  it('logout forgets the tokens even offline', async () => {
    const ctx = setup({
      transport: (t) => async (req) => {
        if (req.path.endsWith('/logout')) throw new NetworkError('offline');
        return t(req);
      },
    });
    await signIn(ctx);
    await ctx.api.logout();
    expect(ctx.tokens.peek()).toBeNull();
    await expect(ctx.api.me()).rejects.toBeInstanceOf(SignedOutError);
  });
});

describe('profile and consents (C-04)', () => {
  it('completes the profile with a name and the current terms and privacy', async () => {
    const ctx = setup();
    const me = await onboard(ctx);
    expect(me.profile_complete).toBe(true);
    expect(me.display_name).toBe('سارة');
    expect(me.consents.marketing.granted).toBe(false);
  });

  it('refuses an answer to an older version of a text', async () => {
    const ctx = setup();
    await signIn(ctx);
    const e = await rejection(
      ctx.api.submitConsents({ consents: [{ kind: 'terms', version: '2020-01-01', granted: true }] }),
    );
    expect(e.code).toBe('CUSTOMER_CONSENT_VERSION_STALE');
    expect(e.status).toBe(409);
  });

  it('never sends a refusal of terms or privacy (withdrawal is account deletion, C-20)', async () => {
    const ctx = setup();
    await signIn(ctx);
    await expect(
      ctx.api.submitConsents({ consents: [{ kind: 'terms', version: '2026-11-01', granted: false }] }),
    ).rejects.toThrow();
  });
});

describe('vehicles (C-05)', () => {
  it('normalises the plate (any digit script, keyboard letter variants)', async () => {
    const ctx = setup();
    await onboard(ctx);
    const v = await ctx.api.addVehicle({
      plate: { digits: '١٢٣٤', letters_ar: 'أ ب ي' },
      vehicle_make: 'toyota',
      vehicle_color: 'white',
      vehicle_type: 'sedan',
    });
    expect(v.plate).toMatchObject({
      digits: '1234',
      letters_ar: 'ا ب ى',
      letters_en: 'A B V',
      display: '1234 ا ب ى',
    });
    expect((await ctx.api.me()).vehicles_count).toBe(1);
  });

  it('answers PLATE_INVALID with the field and reason of 08', async () => {
    const ctx = setup();
    await onboard(ctx);
    const digits = await rejection(ctx.api.addVehicle({ plate: { digits: '12345', letters_ar: 'ا ب ح' } }));
    expect(digits.code).toBe('PLATE_INVALID');
    expect(digits.details).toEqual({ field: 'plate.digits', reason: 'digits' });
    const letters = await rejection(ctx.api.addVehicle({ plate: { digits: '12', letters_ar: 'ا ب ج' } }));
    expect(letters.details).toEqual({ field: 'plate.letters_ar', reason: 'letters' });
  });

  it('refuses a duplicate plate and a sixth vehicle', async () => {
    const ctx = setup();
    await onboard(ctx);
    const letters = ['ا ب ح', 'د ر س', 'ص ط ع', 'ق ك ل', 'م ن ه'];
    for (const l of letters) await ctx.api.addVehicle({ plate: { digits: '77', letters_ar: l } });
    expect((await rejection(ctx.api.addVehicle({ plate: { digits: '77', letters_ar: 'ا ب ح' } }))).code).toBe(
      'CUSTOMER_VEHICLE_LIMIT',
    );
    const e = await rejection(ctx.api.addVehicle({ plate: { digits: '1', letters_ar: 'و ى ا' } }));
    expect(e.code).toBe('CUSTOMER_VEHICLE_LIMIT');
    expect(e.detailNumber('max')).toBe(CUSTOMER_VEHICLES_MAX);
    const other = setup();
    await onboard(other);
    await other.api.addVehicle({ plate: { digits: '5', letters_ar: 'ا ب ح' } });
    expect((await rejection(other.api.addVehicle({ plate: { digits: '5', letters_ar: 'ابح' } }))).code).toBe(
      'CUSTOMER_VEHICLE_DUPLICATE',
    );
  });

  it('replays a write sent again with the same Idempotency-Key, and refuses the key for another body', async () => {
    const ctx = setup();
    await onboard(ctx);
    const body = { plate: { digits: '42', letters_ar: 'ن ه و' } };
    const a = await ctx.api.addVehicle(body, 'same-key');
    const b = await ctx.api.addVehicle(body, 'same-key');
    expect(b.id).toBe(a.id);
    expect(await ctx.api.vehicles()).toHaveLength(1);
    const e = await rejection(
      ctx.api.addVehicle({ plate: { digits: '43', letters_ar: 'ن ه و' } }, 'same-key'),
    );
    expect(e.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('locations and home (C-06)', () => {
  it('lists locations with cursor paging and reads one', async () => {
    const ctx = setup();
    await onboard(ctx);
    const first = await ctx.api.locations({ limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await ctx.api.locations({ limit: 4, cursor: first.nextCursor as string });
    expect(second.items).toHaveLength(3); // 7 locations since the university of V2-036;
    expect(second.nextCursor).toBeNull();
    const detail = await ctx.api.location(first.items[0]?.venue_id as string);
    expect(detail.timezone).toBe('Asia/Riyadh');
    const missing = await rejection(ctx.api.location('00000000-0000-4000-8000-000000000000'));
    expect(missing.code).toBe('VENUE_NOT_LISTED');
    expect(missing.status).toBe(404);
  });

  it('home: at most five nearby locations, nearest first with a position, no visit or subscription yet', async () => {
    const ctx = setup();
    await onboard(ctx);
    const home = await ctx.api.home({ lat: 24.7451, lng: 46.6573 });
    expect(home.nearby_locations.length).toBeLessThanOrEqual(5);
    expect(home.nearby_locations[0]?.distance_m).toBe(0);
    const d = home.nearby_locations.map((l) => l.distance_m ?? 0);
    expect([...d].sort((x, y) => x - y)).toEqual(d);
    expect(home.current_visit).toBeNull();
    expect(home.subscriptions).toEqual([]);
  });

  it('shows the sample visit for the demo phone', async () => {
    const ctx = setup({ demoVisitPhones: [PHONE] });
    await onboard(ctx);
    expect((await ctx.api.home()).current_visit?.status).toBe('parked');
  });
});

describe('client contract checks', () => {
  it('reports a body that is not the contract instead of trusting it', async () => {
    const ctx = setup({ transport: () => async () => ({ status: 200, body: { data: { channel: 'sms' } } }) });
    await expect(ctx.api.requestOtp(PHONE, 'ar')).rejects.toBeInstanceOf(BadResponseError);
  });

  it('reports an error without an envelope', async () => {
    const ctx = setup({ transport: () => async () => ({ status: 502, body: null }) });
    await expect(ctx.api.requestOtp(PHONE, 'ar')).rejects.toBeInstanceOf(BadResponseError);
  });

  it('keeps unknown error codes readable (forward compatible)', async () => {
    const ctx = setup({
      transport: () => async () => ({
        status: 409,
        body: {
          error: {
            code: 'SOMETHING_NEW',
            message: 'x',
            message_ar: 'نص من الخادم',
            request_id: 'req_1',
            retryable: false,
            details: {},
          },
        },
      }),
    });
    const e = await rejection(ctx.api.requestOtp(PHONE, 'ar'));
    expect(e.code).toBe('SOMETHING_NEW');
    expect(e.messageAr).toBe('نص من الخادم');
  });

  it('sends Idempotency-Key on writes only and Bearer on customer routes only', async () => {
    const seen: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
    const ctx = setup({
      transport: (t) => async (req) => {
        seen.push({ path: `${req.method} ${req.path}`, headers: req.headers });
        return t(req);
      },
    });
    await onboard(ctx);
    const byPath = (p: string) => seen.find((s) => s.path === p)?.headers ?? {};
    expect(byPath('POST /v1/customer/auth/otp')).toEqual({});
    expect(byPath('PATCH /v1/customer/me')['Idempotency-Key']).toMatch(/^key-/);
    expect(byPath('PATCH /v1/customer/me').Authorization).toMatch(/^Bearer /);
    await ctx.api.me();
    expect(byPath('GET /v1/customer/me')['Idempotency-Key']).toBeUndefined();
  });
});
