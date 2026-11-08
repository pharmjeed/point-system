/**
 * V2-011 (DEC-481, DEC-482): the customer API contracts of `@point/shared/customer` against
 * docs/v2/05_API_Integrations.md, and the shared Saudi mobile / plate normalisation.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ERROR_CATALOG,
  CUSTOMER_ERROR_CODES,
  CUSTOMER_OTP_CHANNELS,
  CUSTOMER_REUSED_ERROR_CODES,
  CUSTOMER_ROUTES,
  CustomerConsentsBodySchema,
  CustomerMePatchBodySchema,
  CustomerOtpRequestBodySchema,
  CustomerOtpVerifyBodySchema,
  CustomerVehicleCreateBodySchema,
  OpeningHoursSchema,
  customerErrorDef,
  normalizeSaudiMobile,
  normalizeSaudiPlate,
  saudiPlateDisplay,
} from '../src/customer/index.js';
import { BRAND_DEFAULTS, CUSTOMER_APP_BRAND_DEFAULTS, ERROR_CATALOG } from '../src/index.js';
import { readDoc, section } from './docs.js';

const doc = readDoc('v2/05_API_Integrations.md');

describe('docs/v2/05 §1: every customer route of the contracts is documented', () => {
  const routes = section(doc, '## 1. ').join('\n');
  it.each(Object.entries(CUSTOMER_ROUTES))('%s', (_key, route) => {
    const base = route.path.replace('/{venueId}', '');
    expect(routes).toContain(base);
    expect(route.path.startsWith('/v1/customer/')).toBe(true);
  });

  it('writes take an Idempotency-Key; sign-in calls do not (rate limited instead)', () => {
    const required = Object.entries(CUSTOMER_ROUTES)
      .filter(([, r]) => r.idempotency === 'required')
      .map(([k]) => k);
    expect(required).toEqual([
      'mePatch',
      'consents',
      'vehicleCreate',
      'vehicleDelete',
      'meDelete',
      // V2-022 / V2-023 (DEC-521, DEC-524)
      'visitPay',
      'paymentMethodCreate',
      'paymentMethodPatch',
      'paymentMethodDelete',
    ]);
    // signed-in auth calls: logout, and the re-verification of C-20 (V2-017, DEC-507)
    const signedIn = ['/v1/customer/auth/logout', '/v1/customer/auth/reauth/verify'];
    for (const r of Object.values(CUSTOMER_ROUTES)) {
      if (r.method === 'GET') expect(r.idempotency).toBe('none');
      if (r.path.includes('/auth/')) expect(r.auth).toBe(signedIn.includes(r.path) ? 'customer' : 'public');
    }
  });
});

describe('docs/v2/05 §5: error codes', () => {
  const codes = section(doc, '## 5. ').join('\n');
  it.each(CUSTOMER_ERROR_CODES)('%s is listed in 05 §5 and catalogued with an HTTP status', (code) => {
    expect(codes).toContain(`\`${code}\``);
    const def = CUSTOMER_ERROR_CATALOG[code];
    expect(def.http).toBeGreaterThanOrEqual(400);
    expect(def.message_ar.length).toBeGreaterThan(0);
  });

  it('reused codes keep their 08 definition', () => {
    for (const code of CUSTOMER_REUSED_ERROR_CODES) expect(customerErrorDef(code)).toBe(ERROR_CATALOG[code]);
    expect(customerErrorDef('CUSTOMER_OTP_LOCKED').http).toBe(423);
  });

  it('no customer code collides with a V1 code', () => {
    for (const code of CUSTOMER_ERROR_CODES) expect(Object.hasOwn(ERROR_CATALOG, code)).toBe(false);
  });
});

describe('sign-in over WhatsApp only (DEC-460)', () => {
  it('has a single delivery channel and no SMS anywhere in the contract', () => {
    expect(CUSTOMER_OTP_CHANNELS).toEqual(['whatsapp']);
    const texts = Object.values(CUSTOMER_ERROR_CATALOG).flatMap((d) => [d.message, d.message_ar]);
    expect(texts.join(' ')).not.toMatch(/sms|رسالة نصية/i);
  });

  it('accepts only a Saudi mobile in E.164 and a six-digit code', () => {
    const device = { device_id: 'device-0001', platform: 'ios' };
    expect(CustomerOtpRequestBodySchema.parse({ phone_e164: '+966512345678', ...device }).locale).toBe('ar');
    expect(CustomerOtpRequestBodySchema.safeParse({ phone_e164: '+447911123456', ...device }).success).toBe(
      false,
    );
    expect(CustomerOtpRequestBodySchema.safeParse({ phone_e164: '0512345678', ...device }).success).toBe(
      false,
    );
    expect(
      CustomerOtpVerifyBodySchema.safeParse({ phone_e164: '+966512345678', code: '12345', ...device })
        .success,
    ).toBe(false);
    expect(
      CustomerOtpRequestBodySchema.safeParse({ phone_e164: '+966512345678', ...device, platform: 'web' })
        .success,
    ).toBe(false);
  });
});

describe('profile and consents bodies', () => {
  it('trims the display name and refuses an empty patch', () => {
    expect(CustomerMePatchBodySchema.parse({ display_name: '  سارة   العتيبي ' })).toEqual({
      display_name: 'سارة العتيبي',
    });
    expect(CustomerMePatchBodySchema.safeParse({}).success).toBe(false);
    expect(CustomerMePatchBodySchema.safeParse({ display_name: ' س ' }).success).toBe(false);
  });

  it('terms and privacy are only granted; marketing may be declined; kinds are unique', () => {
    const v = '2026-11-01';
    expect(
      CustomerConsentsBodySchema.safeParse({ consents: [{ kind: 'marketing', version: v, granted: false }] })
        .success,
    ).toBe(true);
    expect(
      CustomerConsentsBodySchema.safeParse({ consents: [{ kind: 'terms', version: v, granted: false }] })
        .success,
    ).toBe(false);
    expect(
      CustomerConsentsBodySchema.safeParse({
        consents: [
          { kind: 'terms', version: v, granted: true },
          { kind: 'terms', version: v, granted: true },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('vehicle body and opening hours', () => {
  it('Saudi plate only in V2-011; free make text is trimmed', () => {
    const body = CustomerVehicleCreateBodySchema.parse({
      plate: { digits: '12', letters_ar: 'ا ب ح' },
      vehicle_make: '  بروتون ',
    });
    expect(body.plate.country).toBe('SA');
    expect(body.vehicle_make).toBe('بروتون');
    expect(
      CustomerVehicleCreateBodySchema.safeParse({ plate: { country: 'AE', digits: '1', letters_ar: 'ا' } })
        .success,
    ).toBe(false);
  });

  it('opening hours: HH:MM intervals per weekday, 24:00 allowed', () => {
    expect(OpeningHoursSchema.parse({ days: { sun: [{ open: '10:00', close: '24:00' }] } }).always_open).toBe(
      false,
    );
    expect(OpeningHoursSchema.safeParse({ days: { sun: [{ open: '25:00', close: '26:00' }] } }).success).toBe(
      false,
    );
    expect(OpeningHoursSchema.safeParse({ days: { xyz: [] } }).success).toBe(false);
  });
});

describe('normalizeSaudiMobile (03 §3.8)', () => {
  it.each([
    ['0512345678', '+966512345678'],
    ['512345678', '+966512345678'],
    ['+966512345678', '+966512345678'],
    ['966512345678', '+966512345678'],
    ['00966512345678', '+966512345678'],
    ['٠٥١٢٣٤٥٦٧٨', '+966512345678'],
    ['۰۵۱۲۳۴۵۶۷۸', '+966512345678'],
    ['(051) 234-5678', '+966512345678'],
    ['‎+966 51 234 5678', '+966512345678'],
  ])('%s → %s', (raw, e164) => expect(normalizeSaudiMobile(raw)).toBe(e164));

  it.each(['', null, undefined, '0412345678', '05123456', '051234567890', '+447911123456', 'abc'])(
    'refuses %s',
    (raw) => expect(normalizeSaudiMobile(raw)).toBeNull(),
  );
});

describe('normalizeSaudiPlate (07 §1.8, same table as the server)', () => {
  it('normalises digits, letter variants, spaces, tatweel and diacritics', () => {
    expect(normalizeSaudiPlate({ digits: '١٢ ٣٤', letters_ar: 'أبـحَ' })).toEqual({
      ok: true,
      plate: { country: 'SA', digits: '1234', letters_ar: 'ا ب ح', letters_en: 'A B J' },
    });
    expect(normalizeSaudiPlate({ digits: '7', letters_ar: 'ي ة ک' })).toMatchObject({
      ok: true,
      plate: { letters_ar: 'ى ه ك', letters_en: 'V H K' },
    });
  });

  it('reports the field and reason of PLATE_INVALID (08)', () => {
    expect(normalizeSaudiPlate({ digits: '', letters_ar: 'ا ب ح' })).toEqual({
      ok: false,
      field: 'plate.digits',
      reason: 'digits',
    });
    expect(normalizeSaudiPlate({ digits: '12345', letters_ar: 'ا ب ح' })).toMatchObject({ ok: false });
    expect(normalizeSaudiPlate({ digits: '1', letters_ar: 'ا ب' })).toEqual({
      ok: false,
      field: 'plate.letters_ar',
      reason: 'letters',
    });
    expect(normalizeSaudiPlate({ digits: '1', letters_ar: 'ا ب ج' })).toMatchObject({ reason: 'letters' });
    expect(normalizeSaudiPlate({ digits: '1', letters_ar: 'ا ب ح د' })).toMatchObject({ reason: 'letters' });
  });

  it('displays digits then letters (07 Plate.display)', () => {
    expect(saudiPlateDisplay({ digits: '1234', letters_ar: 'ا ب ح' })).toBe('1234 ا ب ح');
  });
});

describe('customer app brand (V2-D01, DEC-480)', () => {
  it('defaults to the platform brand, the same customer brand as the WhatsApp channel (V2-D01, DEC-470)', () => {
    expect(CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_AR).toBe(BRAND_DEFAULTS.BRAND_STAFF_NAME_AR);
    expect(CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_EN).toBe(BRAND_DEFAULTS.BRAND_STAFF_NAME_EN);
    expect(CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_AR).toBe(
      BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR,
    );
    expect(CUSTOMER_APP_BRAND_DEFAULTS.BRAND_CUSTOMER_APP_NAME_EN).toBe(
      BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_EN,
    );
  });
});
