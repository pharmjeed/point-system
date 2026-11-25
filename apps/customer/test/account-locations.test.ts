/// <reference types="node" />
/**
 * V2-012 (C-07, C-08, C-15) and V2-017 (C-19, C-20): the screen logic without React Native, and the client against
 * the fake backend for the new routes (vehicle removal, re-verification, account deletion) — the server's rules.
 */
import { readFileSync } from 'node:fs';
import {
  CUSTOMER_ROUTES,
  CUSTOMER_VEHICLES_MAX,
  type CustomerLocationDetail,
  type CustomerLocationSummary,
  type CustomerMe,
  type CustomerVehicle,
} from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError, SignedOutError } from '../src/api/errors';
import { createCustomerApi } from '../src/api/client';
import { FAKE_LOCATIONS } from '../src/api/fake/seed';
import { parseAppConfig } from '../src/configModel';
import {
  AFTER_DELETE_ROUTE,
  deleteIssueFromError,
  stepAfterDeleteError,
} from '../src/features/deleteAccount';
import {
  DEFAULT_REGION,
  emptyText,
  hoursLines,
  locationDetailView,
  locationsQuery,
  mapAvailable,
  mapPins,
  mapsUrl,
  mergePage,
  regionFor,
  riyadhWeekday,
  webMapsUrl,
} from '../src/features/locations';
import { applyVerifyError, fromChallenge, otpNoticeText } from '../src/features/otp';
import { parseStoredLocale, settingsView } from '../src/features/settings';
import { canAddVehicle, removeIssueFromError, vehicleCaption, vehicleRow } from '../src/features/vehicles';
import { isolate } from '../src/i18n';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { memoryTokenStore } from '../src/session/tokenStore';
import { onboard, PHONE, setup, signIn } from './helpers';

const T0 = Date.parse('2026-11-07T09:00:00Z'); // Saturday 12:00 in Riyadh

function apiError(code: string, details: Record<string, unknown> = {}, status = 409) {
  return new ApiError(status, {
    code,
    message: code,
    message_ar: code,
    request_id: 'r',
    retryable: false,
    details,
  });
}

const summary = (over: Partial<CustomerLocationSummary> = {}): CustomerLocationSummary => {
  const {
    address: _a,
    timezone: _t,
    opening_hours: _o,
    photo_urls: _p,
    plans: _pl,
    ...s
  } = FAKE_LOCATIONS[0] as CustomerLocationDetail;
  return { ...s, ...over };
};

/** A fresh code for the account's own number, then the proof (C-20 steps 1–2). */
async function proof(ctx: ReturnType<typeof setup>, phone = PHONE) {
  ctx.clock.advance(61_000);
  await ctx.api.requestOtp(phone, 'ar');
  return ctx.api.reauthVerify(ctx.backend.lastCode(phone) as string);
}

describe('V2-012 — C-07 list, filters and map', () => {
  it('builds the list query from the search box and the chip', () => {
    expect(locationsQuery('  ', 'all')).toEqual({ limit: 20 });
    expect(locationsQuery(' الواحة ', 'open_now', 'o:20')).toEqual({
      q: 'الواحة',
      filter: 'open_now',
      cursor: 'o:20',
      limit: 20,
    });
    expect(locationsQuery('x'.repeat(80), 'subscribable').q).toHaveLength(60);
  });

  it('merges pages without listing a venue twice', () => {
    const a = summary({ venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a01' });
    const b = summary({ venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a02' });
    expect(mergePage([a], [a, b]).map((l) => l.venue_id)).toEqual([a.venue_id, b.venue_id]);
  });

  it('pins only the locations with coordinates, and a region around them', () => {
    const pins = mapPins(
      [summary(), summary({ venue_id: '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4aff', lat: null, lng: null })],
      ar,
      'ar',
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ title: 'برج الأعمال — العليا', description: 'تشغيل: ركن لخدمات الصف' });
    expect(mapPins([summary()], en, 'en')[0]).toMatchObject({ title: 'Business Tower — Olaya' });
    expect(regionFor([])).toEqual(DEFAULT_REGION);
    const r = regionFor([
      { id: 'a', title: '', description: '', lat: 24.6, lng: 46.6 },
      { id: 'b', title: '', description: '', lat: 24.8, lng: 46.8 },
    ]);
    expect(r.latitude).toBeCloseTo(24.7);
    expect(r.latitudeDelta).toBeCloseTo(0.28);
    expect(regionFor([{ id: 'a', title: '', description: '', lat: 1, lng: 2 }]).latitudeDelta).toBe(0.01);
  });

  it('the map: always on iOS, on Android only with a key in the build (DEC-506)', () => {
    expect(mapAvailable('ios', { maps: { android: false } })).toBe(true);
    expect(mapAvailable('android', { maps: { android: false } })).toBe(false);
    expect(mapAvailable('android', { maps: { android: true } })).toBe(true);
    expect(mapAvailable('web', { maps: { android: true } })).toBe(false);
  });

  it('«فتح في الخرائط»: Apple Maps on iOS, a geo: intent on Android, the address without coordinates', () => {
    const at = { lat: 24.6936, lng: 46.6853, name: 'برج الأعمال' };
    expect(mapsUrl('ios', at)).toBe(
      `https://maps.apple.com/?ll=24.6936,46.6853&q=${encodeURIComponent('برج الأعمال')}`,
    );
    expect(mapsUrl('android', at)).toBe(
      `geo:24.6936,46.6853?q=24.6936,46.6853(${encodeURIComponent('برج الأعمال')})`,
    );
    expect(mapsUrl('android', { lat: null, lng: null, name: 'برج', address: 'العليا' })).toBe(
      `geo:0,0?q=${encodeURIComponent('برج العليا')}`,
    );
    expect(mapsUrl('ios', { lat: null, lng: null, name: 'برج', address: '  ' })).toBeNull();
    expect(webMapsUrl(at)).toBe('https://www.google.com/maps/search/?api=1&query=24.6936,46.6853');
    expect(webMapsUrl({ lat: null, lng: null, name: 'x' })).toBeNull();
  });

  it('empty states say what to change', () => {
    expect(emptyText('', 'all', ar)).toBe(ar.locations.empty);
    expect(emptyText('x', 'all', ar)).toBe(ar.locations.emptyFiltered);
    expect(emptyText('', 'open_now', ar)).toBe(ar.locations.emptyFiltered);
    expect(emptyText('', 'subscribed', ar)).toBe(ar.locations.emptySubscribed);
  });

  it('the fake backend filters, searches and pages like the server', async () => {
    const ctx = setup();
    await onboard(ctx);
    const all = await ctx.api.locations(locationsQuery('', 'all'));
    expect(all.items.length).toBe(FAKE_LOCATIONS.length);
    const subs = await ctx.api.locations(locationsQuery('', 'subscribable'));
    expect(subs.items.every((l) => l.subscriptions_enabled)).toBe(true);
    expect((await ctx.api.locations(locationsQuery('', 'subscribed'))).items).toEqual([]);
    const found = await ctx.api.locations(locationsQuery('Waha', 'all'));
    expect(found.items.map((l) => l.name_en)).toEqual(['Al Waha Mall']);
  });
});

describe('V2-012 — C-08 location detail', () => {
  const detail = FAKE_LOCATIONS[0] as CustomerLocationDetail;

  it('per-visit price, the plans’ monthly and yearly prices with «اشترك» (V2-032), address, operator, open now', () => {
    const v = locationDetailView({ ...detail, open_now: true }, ar, 'ar');
    expect(v.operator).toBe('تشغيل: ركن لخدمات الصف');
    expect(v.address).toBe('طريق العليا العام، حي العليا، الرياض');
    expect(v.openNow).toBe(ar.home.openNow);
    expect(v.prices).toEqual([
      { label: ar.locations.perVisit, value: isolate('25.00 ر.س') },
      { label: ar.locations.monthly, value: isolate('345.00 ر.س') },
      { label: ar.locations.yearly, value: isolate('3,450.00 ر.س') },
    ]);
    expect(v.canSubscribe).toBe(true);
    const hall = locationDetailView(
      { ...detail, subscriptions_enabled: false, pay_per_visit_halalas: null, open_now: null, address: null },
      en,
      'en',
    );
    expect(hall).toMatchObject({ prices: [], canSubscribe: false, openNow: null, address: 'الرياض' });
    expect(hall.title).toBe('Business Tower — Olaya');
  });

  it('the week from Sunday, today marked, closed days, overnight intervals, 24/7', () => {
    expect(riyadhWeekday(T0)).toBe('sat');
    expect(riyadhWeekday(Date.parse('2026-11-07T21:30:00Z'))).toBe('sun'); // 00:30 Sunday in Riyadh
    const lines = hoursLines(
      {
        always_open: false,
        days: {
          sun: [{ open: '10:00', close: '01:00' }],
          sat: [
            { open: '08:00', close: '12:00' },
            { open: '16:00', close: '23:00' },
          ],
        },
      },
      ar,
      T0,
    );
    expect(lines.map((l) => l.day)).toEqual(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
    expect(lines[0]).toMatchObject({ label: 'الأحد', text: isolate('10:00–01:00'), today: false });
    expect(lines[1]?.text).toBe(ar.locations.closedDay);
    expect(lines[6]).toMatchObject({
      today: true,
      text: `${isolate('08:00–12:00')}${ar.locations.listSeparator}${isolate('16:00–23:00')}`,
    });
    expect(
      hoursLines({ always_open: true, days: {} }, en, T0).every((l) => l.text === en.locations.allDay),
    ).toBe(true);
  });

  it('an unlisted venue is VENUE_NOT_LISTED with its own text', async () => {
    const ctx = setup();
    await onboard(ctx);
    const e = await ctx.api.location('00000000-0000-4000-8000-000000000000').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('VENUE_NOT_LISTED');
    expect(ar.errors.VENUE_NOT_LISTED).toBe(ar.locations.notListed);
  });
});

describe('V2-012 — C-15 my vehicles', () => {
  it('DEC-643: the car card line names the known parts (the pass has no model, the form maybe no type)', () => {
    expect(vehicleCaption({ vehicle_make: 'toyota', vehicle_color: 'red', vehicle_type: 'suv' }, ar)).toBe(
      'تويوتا · أحمر · دفع رباعي',
    );
    expect(vehicleCaption({ vehicle_make: null, vehicle_color: 'أخضر زيتي', vehicle_type: null }, ar)).toBe(
      'أخضر زيتي',
    );
    expect(vehicleCaption({}, ar)).toBe('');
    expect(vehicleCaption({ vehicle_type: 'van', vehicle_color: 'white' }, en)).toBe('White · Van');
  });

  it('rows: plate isolated, known details only, removal unless in a visit', () => {
    const v: CustomerVehicle = {
      id: '0b8c7a1e-1f2d-4c3b-9a8e-7d6c5b4a3f21',
      plate: {
        country: 'SA',
        digits: '4821',
        letters_ar: 'ب ح د',
        letters_en: 'B J D',
        raw: null,
        display: '4821 ب ح د',
      },
      vehicle_make: 'toyota',
      vehicle_model: 'كامري',
      vehicle_color: 'لون خاص',
      vehicle_type: 'sedan',
      in_active_visit: false,
      created_at: new Date(T0).toISOString(),
    };
    expect(vehicleRow(v, ar)).toEqual({
      id: v.id,
      plate: isolate('4821 ب ح د'),
      details: 'تويوتا · كامري · لون خاص · سيدان',
      inActiveVisit: false,
      canRemove: true,
    });
    expect(
      vehicleRow(
        {
          ...v,
          in_active_visit: true,
          vehicle_make: null,
          vehicle_model: null,
          vehicle_color: null,
          vehicle_type: null,
        },
        en,
      ),
    ).toMatchObject({
      details: '',
      canRemove: false,
    });
    expect(canAddVehicle(CUSTOMER_VEHICLES_MAX - 1)).toBe(true);
    expect(canAddVehicle(CUSTOMER_VEHICLES_MAX)).toBe(false);
    expect(removeIssueFromError(apiError('CUSTOMER_VEHICLE_IN_ACTIVE_VISIT'))).toBe('in_visit');
    expect(removeIssueFromError(apiError('RESOURCE_NOT_FOUND', {}, 404))).toBe('gone');
    expect(removeIssueFromError(new Error('x'))).toBeNull();
  });

  it('remove: soft on the fake as on the server; the same key replays, a new one is RESOURCE_NOT_FOUND', async () => {
    const ctx = setup();
    await onboard(ctx);
    const car = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '12', letters_ar: 'ب ح د' } });
    const removed = await ctx.api.removeVehicle(car.id, 'key-remove-1');
    expect(removed).toEqual({ vehicle_id: car.id, removed_at: new Date(T0).toISOString() });
    expect(await ctx.api.removeVehicle(car.id, 'key-remove-1')).toEqual(removed);
    const again = await ctx.api.removeVehicle(car.id, 'key-remove-2').catch((e: unknown) => e);
    expect((again as ApiError).code).toBe('RESOURCE_NOT_FOUND');
    expect(await ctx.api.vehicles()).toEqual([]);
    // the plate can be added again
    await ctx.api.addVehicle({ plate: { country: 'SA', digits: '12', letters_ar: 'ب ح د' } });
  });

  it('a car in the visit in progress cannot be removed (demo visit phone)', async () => {
    const phone = '+966500000099';
    const ctx = setup({ demoVisitPhones: [phone] });
    await onboard(ctx, phone);
    const car = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '7', letters_ar: 'ا ب ح' } });
    const other = await ctx.api.addVehicle({ plate: { country: 'SA', digits: '8', letters_ar: 'ا ب ح' } });
    expect((await ctx.api.vehicles()).map((v) => v.in_active_visit)).toEqual([true, false]);
    const e = await ctx.api.removeVehicle(car.id).catch((x: unknown) => x);
    expect((e as ApiError).code).toBe('CUSTOMER_VEHICLE_IN_ACTIVE_VISIT');
    await ctx.api.removeVehicle(other.id);
  });

  it('the route is a DELETE with an Idempotency-Key and no body', () => {
    expect(CUSTOMER_ROUTES.vehicleDelete).toMatchObject({ method: 'DELETE', idempotency: 'required' });
    expect('body' in CUSTOMER_ROUTES.vehicleDelete).toBe(false);
  });
});

describe('V2-017 — C-19 settings', () => {
  const config = parseAppConfig(
    {
      brand: { nameAr: 'ب', nameEn: 'B' },
      api: { mode: 'fake' },
      maps: { android: true },
      support: { whatsapp: '966500000000', email: 'help@example.com' },
    },
    true,
    '0.1.0',
  );

  it('config: maps flag, support channels validated, the version', () => {
    expect(config.maps.android).toBe(true);
    expect(config.support).toEqual({ whatsapp: '966500000000', email: 'help@example.com' });
    expect(config.version).toBe('0.1.0');
    const bare = parseAppConfig(
      {
        brand: { nameAr: 'ب', nameEn: 'B' },
        api: { mode: 'fake' },
        support: { whatsapp: '+9665 x', email: 'nope' },
      },
      true,
    );
    expect(bare).toMatchObject({
      maps: { android: false },
      support: { whatsapp: null, email: null },
      version: '0.0.0',
    });
  });

  it('support links from the config, the privacy page from the account, each language named in itself', async () => {
    const ctx = setup();
    const me = await onboard(ctx);
    const withDocs: CustomerMe = {
      ...me,
      consents: {
        ...me.consents,
        terms: { ...me.consents.terms, document_url: 'https://example.com/terms' },
        privacy: { ...me.consents.privacy, document_url: 'https://example.com/privacy' },
      },
    };
    const v = settingsView(withDocs, config, ar);
    expect(v.support).toEqual([
      { key: 'whatsapp', label: ar.settings.supportWhatsapp, url: 'https://wa.me/966500000000' },
      { key: 'email', label: ar.settings.supportEmail, url: 'mailto:help@example.com' },
    ]);
    // the terms are C-24 in the app (DEC-614): only the privacy page is a link
    expect(v.documents.map((d) => d.url)).toEqual(['https://example.com/privacy']);
    expect(v.languages).toEqual([
      { value: 'ar', label: 'العربية' },
      { value: 'en', label: 'English' },
    ]);
    expect(settingsView(withDocs, config, en).languages).toEqual(v.languages);
    expect(v.version).toBe('0.1.0');
    expect(settingsView(me, { support: { whatsapp: null, email: null }, version: '1' }, ar)).toMatchObject({
      support: [],
      documents: [],
    });
  });

  it('the stored language: ar or en, anything else follows the device', () => {
    expect(parseStoredLocale('en')).toBe('en');
    expect(parseStoredLocale('ar')).toBe('ar');
    expect(parseStoredLocale('fr')).toBeNull();
    expect(parseStoredLocale(null)).toBeNull();
  });

  it('the language reaches the account (PATCH /v1/customer/me locale)', async () => {
    const ctx = setup();
    await onboard(ctx);
    expect((await ctx.api.updateMe({ locale: 'en' })).locale).toBe('en');
  });
});

describe('V2-017 — C-20 delete the account', () => {
  it('maps the refusals to the step to show', () => {
    expect(deleteIssueFromError(apiError('CUSTOMER_ACCOUNT_VISIT_ACTIVE'))).toBe('visit_active');
    expect(deleteIssueFromError(apiError('CUSTOMER_REAUTH_REQUIRED', { reason: 'expired' }, 403))).toBe(
      'reauth',
    );
    expect(deleteIssueFromError(new Error('offline'))).toBeNull();
    expect(stepAfterDeleteError('reauth')).toBe('confirm');
    expect(stepAfterDeleteError('visit_active')).toBe('confirm');
    expect(stepAfterDeleteError(null)).toBe('code');
    expect(AFTER_DELETE_ROUTE).toBe('/welcome');
  });

  it('the confirmation code follows the C-03 rules (attempts, lock text)', () => {
    const s = fromChallenge(PHONE, {
      channel: 'whatsapp',
      phone_masked: '05•••••678',
      expires_at: new Date(T0 + 300_000).toISOString(),
      resend_available_at: new Date(T0 + 60_000).toISOString(),
      attempts_left: 5,
    });
    const wrong = applyVerifyError(s, apiError('CUSTOMER_OTP_INVALID', { attempts_left: 3 }, 422), T0);
    expect(otpNoticeText(wrong, ar, 'ar', T0)).toEqual({
      tone: 'danger',
      text: 'رمز غير صحيح. المحاولات المتبقية: 3',
    });
    const until = new Date(T0 + 15 * 60_000).toISOString();
    const locked = applyVerifyError(s, apiError('CUSTOMER_OTP_LOCKED', { locked_until: until }, 423), T0);
    expect(otpNoticeText(locked, en, 'en', T0)?.text).toContain('15');
    expect(otpNoticeText(locked, en, 'en', T0 + 16 * 60_000)).toBeNull(); // the lock ran out
    expect(otpNoticeText(s, ar, 'ar', T0)).toBeNull();
  });

  it('needs a fresh proof of this session; refused during a visit; then the account is gone everywhere', async () => {
    const ctx = setup();
    await onboard(ctx);
    const missing = await ctx.api.deleteAccount('').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Error); // the client refuses an empty proof before sending (zod)
    const forged = await ctx.api.deleteAccount('pcv.forged-proof-123456').catch((e: unknown) => e);
    expect((forged as ApiError).code).toBe('CUSTOMER_REAUTH_REQUIRED');
    expect((forged as ApiError).details).toEqual({ reason: 'invalid' });
    const late = await proof(ctx);
    ctx.clock.advance(301_000);
    const expired = await ctx.api.deleteAccount(late.reauth_token).catch((e: unknown) => e);
    expect((expired as ApiError).details).toEqual({ reason: 'expired' });

    const p = await proof(ctx);
    expect(Date.parse(p.expires_at) - ctx.clock.now()).toBe(300_000);
    expect(await ctx.api.deleteAccount(p.reauth_token)).toEqual({
      deletedAt: new Date(ctx.clock.now()).toISOString(),
    });
    expect(await ctx.api.hasSession()).toBe(false);
    expect(ctx.signedOut).toEqual([]);
  });

  it('a wrong confirmation code costs an attempt like the sign-in', async () => {
    const ctx = setup();
    await onboard(ctx);
    ctx.clock.advance(61_000);
    await ctx.api.requestOtp(PHONE, 'ar');
    const code = ctx.backend.lastCode(PHONE) as string;
    const bad = await ctx.api.reauthVerify(code === '000000' ? '111111' : '000000').catch((e: unknown) => e);
    expect((bad as ApiError).code).toBe('CUSTOMER_OTP_INVALID');
    expect((bad as ApiError).detailNumber('attempts_left')).toBe(4);
    await ctx.api.reauthVerify(code);
    const reused = await ctx.api.reauthVerify(code).catch((e: unknown) => e);
    expect((reused as ApiError).code).toBe('CUSTOMER_OTP_EXPIRED');
  });

  it('refused while a visit is in progress', async () => {
    const phone = '+966500000099';
    const ctx = setup({ demoVisitPhones: [phone] });
    await onboard(ctx, phone);
    const p = await proof(ctx, phone);
    const e = await ctx.api.deleteAccount(p.reauth_token).catch((x: unknown) => x);
    expect((e as ApiError).code).toBe('CUSTOMER_ACCOUNT_VISIT_ACTIVE');
    expect((await ctx.api.me()).phone_e164).toBe(phone);
  });

  it('another device of the deleted account is signed out (ACCOUNT_DELETED); the number signs up anew', async () => {
    const ctx = setup();
    await onboard(ctx);
    // a second install of the same account
    const tokens = memoryTokenStore();
    const signedOut: string[] = [];
    const other = createCustomerApi({
      transport: ctx.backend.transport,
      tokens,
      device: { id: 'device-test-0002', platform: 'android' },
      newKey: (() => {
        let n = 0;
        return () => `other-${++n}`;
      })(),
      now: ctx.clock.now,
      onSignedOut: (r) => signedOut.push(r),
    });
    ctx.clock.advance(61_000);
    await other.requestOtp(PHONE, 'ar');
    await other.verifyOtp(PHONE, ctx.backend.lastCode(PHONE) as string);
    const p = await proof(ctx);
    await ctx.api.deleteAccount(p.reauth_token);
    const e = await other.me().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignedOutError);
    expect((e as SignedOutError).reason).toBe('deleted');
    expect(signedOut).toEqual(['deleted']);
    expect(await other.hasSession()).toBe(false);
    ctx.clock.advance(61_000);
    const again = await signIn(ctx);
    expect(again.is_new_account).toBe(true);
    expect(again.account).toMatchObject({ display_name: null, profile_complete: false, vehicles_count: 0 });
  });
});

describe('V2-012 / V2-017 — copy and identity', () => {
  it('every new error code has its text in both languages', () => {
    for (const code of [
      'VENUE_NOT_LISTED',
      'CUSTOMER_VEHICLE_IN_ACTIVE_VISIT',
      'CUSTOMER_ACCOUNT_VISIT_ACTIVE',
      'CUSTOMER_REAUTH_REQUIRED',
    ] as const) {
      expect(ar.errors[code].length).toBeGreaterThan(0);
      expect(en.errors[code].length).toBeGreaterThan(0);
    }
    expect(ar.deleteAccount.consequences).toHaveLength(en.deleteAccount.consequences.length);
    expect(ar.deleteAccount.sendCode).toContain('واتساب');
  });

  it('no colour literal and no hard-coded size in the new screens (values from brand/tokens)', () => {
    const files = [
      'src/app/locations.tsx',
      'src/app/location/[venueId].tsx',
      'src/app/vehicles.tsx',
      'src/app/settings.tsx',
      'src/app/delete-account.tsx',
      'src/ui/ScreenHeader.tsx',
      'src/ui/LocationsMap.tsx',
    ];
    for (const f of files) {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
      expect(text, f).not.toMatch(/fontSize:\s*\d/);
    }
  });

  it('the fake backend serves every customer route', () => {
    const source = readFileSync(new URL('../src/api/fake/backend.ts', import.meta.url), 'utf8');
    for (const key of Object.keys(CUSTOMER_ROUTES))
      expect(source, key).toMatch(new RegExp(`\\n    ${key}\\(`));
  });
});
