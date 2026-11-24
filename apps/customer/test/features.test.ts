/**
 * V2-011: the screen logic of C-01 … C-06 (journey R1) without React Native: routing, phone, OTP countdown and
 * lock, consents, plate pad, home ordering, command keys.
 */
import { VEHICLE_COLOR_LABELS_AR, type CustomerMe } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { NetworkError } from '../src/api/transport';
import { CommandKey } from '../src/features/commandKey';
import { greeting, locationRow, visitCard } from '../src/features/home';
import { nextDestination } from '../src/features/onboarding';
import {
  applyResendError,
  applyResent,
  applyVerifyError,
  canResend,
  canSubmit,
  fromChallenge,
  isLocked,
  resendSecondsLeft,
  sanitizeCode,
} from '../src/features/otp';
import { sanitizePhoneInput, validatePhone } from '../src/features/phone';
import {
  acceptRequired,
  hasErrors,
  initialProfileForm,
  profileRequests,
  validateProfile,
} from '../src/features/profile';
import {
  emptyVehicleForm,
  latinLetters,
  sanitizePlateDigits,
  validateVehicle,
  VEHICLE_COLOR_SWATCH,
  VEHICLE_COLORS_FIRST,
  vehicleBody,
  vehicleIssueFromError,
  withLettersText,
} from '../src/features/vehicle';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { onboard, setup, signIn } from './helpers';

const T0 = Date.parse('2026-11-07T09:00:00Z');

function apiError(code: string, details: Record<string, unknown> = {}, status = 422) {
  return new ApiError(status, {
    code,
    message: code,
    message_ar: code,
    request_id: 'r',
    retryable: false,
    details,
  });
}

async function freshMe(): Promise<CustomerMe> {
  const ctx = setup();
  return (await signIn(ctx)).account;
}

describe('journey R1 routing', () => {
  it('C-01 once, then C-02; C-04 until the server says complete; C-05 offered once', async () => {
    expect(nextDestination({ welcomeSeen: false, me: null, vehiclePromptDone: false })).toBe('/welcome');
    expect(nextDestination({ welcomeSeen: true, me: null, vehiclePromptDone: false })).toBe('/phone');
    const me = await freshMe();
    expect(nextDestination({ welcomeSeen: true, me, vehiclePromptDone: false })).toBe('/profile');
    const complete = { ...me, profile_complete: true };
    expect(nextDestination({ welcomeSeen: true, me: complete, vehiclePromptDone: false })).toBe('/vehicle');
    expect(nextDestination({ welcomeSeen: true, me: complete, vehiclePromptDone: true })).toBe('/home');
    expect(
      nextDestination({
        welcomeSeen: true,
        me: { ...complete, vehicles_count: 1 },
        vehiclePromptDone: false,
      }),
    ).toBe('/home');
  });
});

describe('C-02 phone', () => {
  it.each([
    ['512345678', '+966512345678'],
    ['0512345678', '+966512345678'],
    ['٠٥١٢٣٤٥٦٧٨', '+966512345678'],
    ['+966 51 234 5678', '+966512345678'],
    ['00966512345678', '+966512345678'],
  ])('%s → %s', (raw, e164) => {
    expect(validatePhone(raw)).toEqual({ ok: true, e164 });
  });

  it.each(['412345678', '51234567', '05123456789', '', 'abc'])('refuses %s', (raw) => {
    expect(validatePhone(raw).ok).toBe(false);
  });

  it('keeps digits only while typing, at most a full national number', () => {
    expect(sanitizePhoneInput('05 12-34')).toBe('051234');
    expect(sanitizePhoneInput('05123456789')).toBe('0512345678');
    expect(sanitizePhoneInput('5123456789')).toBe('512345678');
    expect(sanitizePhoneInput('+966512345678')).toBe('512345678');
  });
});

describe('C-03 code', () => {
  const challenge = {
    channel: 'whatsapp' as const,
    phone_masked: '05•••••678',
    expires_at: new Date(T0 + 300_000).toISOString(),
    resend_available_at: new Date(T0 + 60_000).toISOString(),
    attempts_left: 5,
  };
  const state = fromChallenge('+966512345678', challenge);

  it('counts down 60 s to the resend from the server time', () => {
    expect(resendSecondsLeft(state, T0)).toBe(60);
    expect(canResend(state, T0 + 59_001)).toBe(false);
    expect(resendSecondsLeft(state, T0 + 59_001)).toBe(1);
    expect(canResend(state, T0 + 60_000)).toBe(true);
  });

  it('accepts six digits from any script or a paste, and only then enables the button', () => {
    expect(sanitizeCode('١٢٣ ٤٥٦٧')).toBe('123456');
    expect(canSubmit(state, '12345', T0)).toBe(false);
    expect(canSubmit(state, '123456', T0)).toBe(true);
  });

  it('shows the attempts left from the server, then locks', () => {
    const wrong = applyVerifyError(state, apiError('CUSTOMER_OTP_INVALID', { attempts_left: 2 }), T0);
    expect(wrong.attemptsLeft).toBe(2);
    expect(wrong.notice).toEqual({ kind: 'invalid', attemptsLeft: 2 });
    const until = new Date(T0 + 15 * 60_000).toISOString();
    const locked = applyVerifyError(wrong, apiError('CUSTOMER_OTP_LOCKED', { locked_until: until }, 423), T0);
    expect(isLocked(locked, T0)).toBe(true);
    expect(canSubmit(locked, '123456', T0)).toBe(false);
    expect(canResend(locked, T0 + 120_000)).toBe(false);
    expect(isLocked(locked, T0 + 15 * 60_000)).toBe(false);
  });

  it('maps expiry, rate limit, channel outage and network failure', () => {
    expect(applyVerifyError(state, apiError('CUSTOMER_OTP_EXPIRED', {}, 410), T0).notice).toEqual({
      kind: 'expired',
    });
    const limited = applyResendError(state, apiError('RATE_LIMITED', { retry_after_s: 30 }, 429), T0);
    expect(limited.resendAvailableAt).toBe(T0 + 30_000);
    expect(applyResendError(state, apiError('WA_CHANNEL_UNAVAILABLE', {}, 503), T0).notice).toEqual({
      kind: 'channelDown',
    });
    expect(applyResendError(state, new NetworkError('x'), T0).notice).toEqual({ kind: 'network' });
  });

  it('restarts the countdown after a resend', () => {
    const next = applyResent(state, {
      ...challenge,
      resend_available_at: new Date(T0 + 120_000).toISOString(),
    });
    expect(resendSecondsLeft(next, T0 + 60_000)).toBe(60);
    expect(next.notice).toEqual({ kind: 'resent' });
  });
});

describe('C-04 name and consents', () => {
  it('requires a name and both required consents; marketing stays optional and unticked', async () => {
    const me = await freshMe();
    const form = initialProfileForm(me);
    expect(form).toEqual({ name: '', terms: false, privacy: false, marketing: false });
    expect(validateProfile(form)).toEqual({ name: 'invalid', consents: 'required' });
    expect(hasErrors(validateProfile({ ...form, name: 'س', terms: true, privacy: true }))).toBe(true);
    expect(hasErrors(validateProfile({ ...form, name: 'سارة', terms: true, privacy: true }))).toBe(false);
  });

  it('sends the versions shown and only what changed', async () => {
    const me = await freshMe();
    const { patch, consents } = profileRequests(
      { name: '  سارة   العتيبي ', terms: true, privacy: true, marketing: false },
      me,
    );
    expect(patch).toEqual({ display_name: 'سارة العتيبي' });
    expect(consents?.consents).toEqual([
      { kind: 'terms', version: me.consents.terms.current_version, granted: true },
      { kind: 'privacy', version: me.consents.privacy.current_version, granted: true },
      { kind: 'marketing', version: me.consents.marketing.current_version, granted: false },
    ]);
    const ctx = setup();
    const done = await onboard(ctx);
    expect(profileRequests(initialProfileForm(done), done)).toEqual({ patch: null, consents: null });
  });

  it('option 4 (DEC-637): «ابدأ» accepts terms and privacy, each with its version; marketing stays the answer given', async () => {
    const me = await freshMe();
    const form = acceptRequired({ ...initialProfileForm(me), name: 'سارة' });
    expect(form).toEqual({ name: 'سارة', terms: true, privacy: true, marketing: false });
    expect(hasErrors(validateProfile(form))).toBe(false);
    expect(validateProfile(acceptRequired(initialProfileForm(me)))).toEqual({ name: 'invalid' });
    expect(profileRequests(form, me).consents?.consents).toEqual([
      { kind: 'terms', version: me.consents.terms.current_version, granted: true },
      { kind: 'privacy', version: me.consents.privacy.current_version, granted: true },
      { kind: 'marketing', version: me.consents.marketing.current_version, granted: false },
    ]);
    expect(acceptRequired({ ...form, marketing: true }).marketing).toBe(true);
  });
});

describe('C-05 vehicle', () => {
  it('option 3 (DEC-638): reads the plate letters typed in Arabic or Latin, keeps three and flags others', () => {
    let f = withLettersText(emptyVehicleForm(), 'abj');
    expect(f.letters).toEqual(['ا', 'ب', 'ح']);
    expect(latinLetters(f.letters)).toBe('ABJ');
    f = withLettersText(f, 'أ ب ي');
    expect(f.letters).toEqual(['ا', 'ب', 'ى']);
    expect(f.lettersText).toBe('أ ب ي');
    expect(validateVehicle({ ...f, digits: '12' })).toEqual({});
    expect(withLettersText(f, 'A ب D').letters).toEqual(['ا', 'ب', 'د']);
    expect(validateVehicle({ ...withLettersText(f, 'ABQ'), digits: '12' })).toEqual({ letters: true });
    expect(validateVehicle({ ...withLettersText(f, 'ا ب ج'), digits: '12' })).toEqual({ letters: true });
    expect(validateVehicle({ ...withLettersText(f, 'ABJD'), digits: '12' })).toEqual({ letters: true });
    expect(validateVehicle({ ...withLettersText(f, 'AB'), digits: '12' })).toEqual({ letters: true });
    expect(withLettersText(f, 'abjdabjdabjdabjd').lettersText).toHaveLength(12);
  });

  it('has a swatch for every colour but «other», and the first nine are colours of the list', () => {
    for (const key of Object.keys(VEHICLE_COLOR_LABELS_AR))
      expect(Object.hasOwn(VEHICLE_COLOR_SWATCH, key)).toBe(key !== 'other');
    for (const key of VEHICLE_COLORS_FIRST) expect(Object.hasOwn(VEHICLE_COLOR_LABELS_AR, key)).toBe(true);
    expect(VEHICLE_COLORS_FIRST).toHaveLength(9);
  });

  it('validates digits and letters with the shared plate rule', () => {
    const f = { ...emptyVehicleForm(), digits: sanitizePlateDigits('٩٨٧٦٥'), letters: ['ا', 'ب', 'ح'] };
    expect(f.digits).toBe('9876');
    expect(validateVehicle(f)).toEqual({});
    expect(validateVehicle({ ...f, digits: '' })).toEqual({ digits: true });
    expect(validateVehicle({ ...f, letters: ['ا'] })).toEqual({ letters: true });
  });

  it('builds the body with pick-list keys or the typed «other»', () => {
    const f = {
      ...emptyVehicleForm(),
      digits: '12',
      letters: ['ا', 'ب', 'ح'],
      make: 'other',
      makeOther: ' بروتون ',
      color: 'white',
      type: 'suv' as const,
    };
    expect(vehicleBody(f)).toEqual({
      plate: { country: 'SA', digits: '12', letters_ar: 'ا ب ح' },
      vehicle_make: 'بروتون',
      vehicle_model: null,
      vehicle_color: 'white',
      vehicle_type: 'suv',
    });
  });

  it('maps server refusals to the field or a message', () => {
    expect(
      vehicleIssueFromError(apiError('PLATE_INVALID', { field: 'plate.digits', reason: 'digits' })),
    ).toEqual({
      kind: 'field',
      errors: { digits: true },
    });
    expect(vehicleIssueFromError(apiError('CUSTOMER_VEHICLE_LIMIT', { max: 5 }))).toEqual({
      kind: 'limit',
      max: 5,
    });
    expect(vehicleIssueFromError(apiError('CUSTOMER_VEHICLE_DUPLICATE', {}, 409))).toEqual({
      kind: 'duplicate',
    });
    expect(vehicleIssueFromError(new Error('x'))).toBeNull();
  });
});

describe('C-06 home', () => {
  it('greets by the time of day and the name, and describes the visit in progress', async () => {
    const ctx = setup({ demoVisitPhones: ['+966512345678'] });
    await onboard(ctx);
    await ctx.api.addVehicle({ plate: { digits: '1234', letters_ar: 'ا ب ح' } });
    const home = await ctx.api.home();
    expect(greeting(home, ar, 'evening')).toBe('مساء الخير، سارة');
    expect(greeting({ display_name: null }, ar, 'morning')).toBe('صباح الخير');
    expect(greeting(home, en, 'evening')).toBe('Good evening, سارة');
    const card = visitCard(home, ar, 'ar');
    expect(card?.status).toBe(ar.ticketStatus.parked);
    expect(card?.plate).toBe('⁨1234 ا ب ح⁩');
    expect(card?.since).toBe('⁨11:15⁩'); // 09:00Z − 45 min, shown in Riyadh time (UTC+3)
  });

  it('describes a location with operator, facts and the cheapest price, digits isolated', async () => {
    const ctx = setup();
    await onboard(ctx);
    const home = await ctx.api.home({ lat: 24.6936, lng: 46.6853 });
    const row = locationRow(home.nearby_locations[0] as never, ar, 'ar');
    expect(row.title).toBe('برج الأعمال — العليا');
    expect(row.operator).toBe('تشغيل: ركن لخدمات الصف');
    expect(row.facts[0]).toBe('⁨0 م⁩');
    expect(row.price).toBe('شهريًا من ⁨345.00 ر.س⁩');
    const en = locationRow(home.nearby_locations[0] as never, ar, 'en');
    expect(en.title).toBe('Business Tower — Olaya');
  });
});

describe('Idempotency-Key per command', () => {
  it('reuses the key for the same input and renews it when the input changes or after success', () => {
    let n = 0;
    const k = new CommandKey(() => `k${++n}`);
    expect(k.for('a')).toBe('k1');
    expect(k.for('a')).toBe('k1');
    expect(k.for('b')).toBe('k2');
    k.reset();
    expect(k.for('b')).toBe('k3');
  });
});
