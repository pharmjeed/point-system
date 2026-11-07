/// <reference types="node" />
/**
 * V2-011: dictionaries (parity, no SMS, no brand literal), formatting (Western digits, Riyadh time), design tokens
 * read from brand/tokens, runtime config guards, and the fake backend's opening hours.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { distanceMetres, isOpenAt } from '../src/api/fake/hours';
import { parseAppConfig } from '../src/configModel';
import { errorText } from '../src/features/errorText';
import { ApiError } from '../src/api/errors';
import { NetworkError } from '../src/api/transport';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { fmt, isolate, resolveLocale } from '../src/i18n';
import { formatDate, formatDistance, formatMoney, formatTime, minutesUntil } from '../src/i18n/format';
import { color, fontSize, layout, px, radius, resolveTokenValue, space } from '../src/theme/tokens';

const tokens = JSON.parse(
  readFileSync(new URL('../../../brand/tokens/tokens.json', import.meta.url), 'utf8'),
);

function leaves(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, path ? `${path}.${k}` : k),
  );
}

describe('dictionaries', () => {
  it('English has exactly the Arabic keys', () => {
    expect(leaves(en).map(([k]) => k)).toEqual(leaves(ar).map(([k]) => k));
  });

  it('no text promises SMS: the code arrives on WhatsApp only (DEC-460)', () => {
    for (const [, text] of [...leaves(ar), ...leaves(en)]) expect(text).not.toMatch(/sms|رسالة نصية|نصية/i);
    expect(ar.otp.sentTo).toContain('واتساب');
    expect(en.otp.resend).toContain('WhatsApp');
  });

  it('no brand name is written; {brand} is filled from the config (canon §1)', () => {
    const all = [...leaves(ar), ...leaves(en)].map(([, t]) => t).join('\n');
    expect(all).not.toMatch(/POINT|MASAF/);
    expect(ar.welcome.title).toContain('{brand}');
  });

  it('uses Western digits only (DEC-17)', () => {
    for (const [, text] of leaves(ar)) expect(text).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('placeholders match between languages', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const enMap = new Map(leaves(en));
    for (const [k, t] of leaves(ar)) expect(holes(enMap.get(k) ?? '')).toEqual(holes(t));
  });
});

describe('language (DEC-481)', () => {
  it('Arabic unless English comes first; a forced locale wins', () => {
    expect(resolveLocale(['ar-SA', 'en-US'])).toBe('ar');
    expect(resolveLocale(['en-GB', 'ar'])).toBe('en');
    expect(resolveLocale(['fr-FR'])).toBe('ar');
    expect(resolveLocale([])).toBe('ar');
    expect(resolveLocale(['en-US'], 'ar')).toBe('ar');
  });

  it('fills placeholders and isolates left-to-right values', () => {
    expect(fmt('مرحبًا {name} {x}', { name: 'سارة' })).toBe('مرحبًا سارة {x}');
    expect(isolate('05•••••678')).toBe('⁨05•••••678⁩');
  });
});

describe('formatting', () => {
  it('money in halalas with two decimals and the currency word', () => {
    expect(formatMoney(2500, ar)).toBe('25.00 ر.س');
    expect(formatMoney(345000, en)).toBe('3,450.00 SAR');
    expect(formatMoney(5, ar)).toBe('0.05 ر.س');
  });

  it('distance, Riyadh time and date with Western digits', () => {
    expect(formatDistance(850, ar)).toBe('850 م');
    expect(formatDistance(2400, en)).toBe('2.4 km');
    expect(formatTime('2026-11-07T21:05:00Z')).toBe('00:05');
    expect(formatDate('2026-11-07T21:05:00Z')).toBe('2026-11-08');
    expect(minutesUntil('2026-11-07T09:14:30Z', Date.parse('2026-11-07T09:00:00Z'))).toBe(15);
  });
});

describe('design tokens come from brand/tokens (DEC-49)', () => {
  it('resolves references and units', () => {
    expect(resolveTokenValue(tokens, '{color.ink.50}')).toBe('#F5F7FA');
    expect(px('16px')).toBe(16);
    expect(() => resolveTokenValue(tokens, '{color.nope}')).toThrow();
  });

  it('semantic roles, spacing, radius, type and touch sizes equal the token file', () => {
    expect(color.primary).toBe(tokens.color.blue['600'].$value);
    expect(color.text).toBe(tokens.color.ink['950'].$value);
    expect(color.borderStrong).toBe(tokens.semantic.light['border-strong'].$value);
    expect(space[4]).toBe(16);
    expect(radius.md).toBe(12);
    expect(radius.lg).toBe(16);
    expect(fontSize.base).toEqual({ fontSize: 16, lineHeight: 26 });
    expect(layout.touchMin).toBe(44);
    expect(layout.buttonLg).toBe(56);
  });

  it('no colour literal in the app outside the token reader', () => {
    const files = [
      'src/ui/AppText.tsx',
      'src/ui/Button.tsx',
      'src/ui/Controls.tsx',
      'src/ui/Field.tsx',
      'src/ui/CodeInput.tsx',
      'src/ui/PlateInput.tsx',
      'src/ui/Screen.tsx',
      'src/app/home.tsx',
      'src/app/welcome.tsx',
    ];
    for (const f of files) {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});

describe('runtime config guards', () => {
  const brand = { nameAr: 'ع', nameEn: 'E' };
  it('development may use the fake; a release build only when asked explicitly', () => {
    expect(parseAppConfig({ brand, api: { mode: 'fake' } }, true).api.mode).toBe('fake');
    expect(() => parseAppConfig({ brand, api: { mode: 'fake' } }, false)).toThrow();
    expect(parseAppConfig({ brand, api: { mode: 'fake', explicit: true } }, false).api.mode).toBe('fake');
  });

  it('http needs a base URL, https in release; brand names are required', () => {
    expect(() => parseAppConfig({ brand, api: { mode: 'http' } }, true)).toThrow();
    expect(() => parseAppConfig({ brand, api: { mode: 'http', baseUrl: 'http://x' } }, false)).toThrow();
    expect(parseAppConfig({ brand, api: { mode: 'http', baseUrl: 'https://x' } }, false).api.baseUrl).toBe(
      'https://x',
    );
    expect(() => parseAppConfig({ api: { mode: 'fake' } }, true)).toThrow();
    expect(parseAppConfig({ brand, api: { mode: 'fake' }, forceLocale: 'en' }, true).forceLocale).toBe('en');
  });
});

describe('error text', () => {
  const e = (code: string) =>
    new ApiError(400, {
      code,
      message: 'srv',
      message_ar: 'خادم',
      request_id: 'r',
      retryable: false,
      details: {},
    });
  it('dictionary for known codes, the server text otherwise, generic for the rest', () => {
    expect(errorText(e('PHONE_INVALID'), ar, 'ar')).toBe(ar.errors.PHONE_INVALID);
    expect(errorText(e('NEW_CODE'), ar, 'ar')).toBe('خادم');
    expect(errorText(e('NEW_CODE'), en, 'en')).toBe('srv');
    expect(errorText(new NetworkError('x'), ar, 'ar')).toBe(ar.common.networkError);
    expect(errorText(new Error('x'), en, 'en')).toBe(en.common.unexpectedError);
  });
});

describe('opening hours (fake backend, Asia/Riyadh)', () => {
  const at = (iso: string) => Date.parse(iso);
  const mall = {
    always_open: false,
    days: { fri: [{ open: '16:00', close: '01:00' }], sat: [{ open: '10:00', close: '01:00' }] },
  };
  it('runs past midnight into the next day', () => {
    // 2026-11-06 is a Friday; 13:00Z = 16:00 Riyadh
    expect(isOpenAt(mall, at('2026-11-06T12:59:00Z'))).toBe(false);
    expect(isOpenAt(mall, at('2026-11-06T13:00:00Z'))).toBe(true);
    expect(isOpenAt(mall, at('2026-11-06T21:30:00Z'))).toBe(true); // Saturday 00:30, from Friday's interval
    expect(isOpenAt(mall, at('2026-11-06T22:00:00Z'))).toBe(false); // Saturday 01:00
    expect(isOpenAt({ always_open: true, days: {} }, at('2026-11-06T22:00:00Z'))).toBe(true);
  });

  it('measures distances in metres', () => {
    expect(distanceMetres({ lat: 24.7, lng: 46.7 }, { lat: 24.7, lng: 46.7 })).toBe(0);
    const d = distanceMetres({ lat: 24.6936, lng: 46.6853 }, { lat: 24.7743, lng: 46.7386 });
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeLessThan(11_000);
  });
});
