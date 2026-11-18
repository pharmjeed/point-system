/**
 * V2-022 / V2-023: paying a visit from C-12 (card checks, device tokenization with the publishable key only, the
 * pay flow with 3-D Secure and its poll) and the saved cards of C-18, on the in-app fake backend that follows the
 * server's rules (DEC-521 … DEC-525).
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { fakeTokenize, parseFakeToken } from '../src/api/fake/tokens';
import { ConfigError, parseAppConfig } from '../src/configModel';
import {
  cardBrandHint,
  digitsOnly,
  formatCardNumber,
  formatExpiry,
  luhnValid,
  sar,
  validateCard,
} from '../src/features/pay/card';
import { cardRow, consentVersionFrom, orderCards } from '../src/features/pay/methods';
import { checkPayment, payVisit, type PayDeps } from '../src/features/pay/payFlow';
import { createCardTokenizer, TokenizeError } from '../src/features/pay/tokenize';
import { ar } from '../src/i18n/ar';
import { setup, signIn } from './helpers';

const DEMO_PHONE = '+966500000099';
const DEMO_TICKET = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';
const NOW = Date.parse('2026-11-07T09:00:00Z');
const card = (number: string) => ({ number, month: 12, year: 2030, cvc: '123', name: 'SARA' });

describe('C-10 card entry (pure)', () => {
  it('formats, converts Arabic-Indic digits, checks Luhn, expiry, CVC and name', () => {
    expect(digitsOnly('٤١١١ ١١١١')).toBe('41111111');
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(formatExpiry('1230')).toBe('12/30');
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(cardBrandHint('4400000000000008')).toBe('mada');
    const ok = validateCard(
      { number: '4111 1111 1111 1111', expiry: '12/30', cvc: '123', name: 'Sara' },
      NOW,
    );
    expect(ok).toEqual({
      card: { number: '4111111111111111', month: 12, year: 2030, cvc: '123', name: 'Sara' },
      issues: [],
    });
    expect(validateCard({ number: '4111', expiry: '13/30', cvc: '1', name: '' }, NOW).issues).toEqual([
      'number',
      'expiry',
      'cvc',
      'name',
    ]);
    // a card is valid through the end of its month
    expect(
      validateCard({ number: '4111111111111111', expiry: '11/26', cvc: '123', name: 'Sara' }, NOW).issues,
    ).toEqual([]);
    expect(
      validateCard({ number: '4111111111111111', expiry: '10/26', cvc: '123', name: 'Sara' }, NOW).issues,
    ).toEqual(['expired']);
    expect(sar(2000)).toBe('20');
    expect(sar(2050)).toBe('20.50');
  });
});

describe('device tokenization (DEC-524)', () => {
  const base = parseAppConfig(
    {
      brand: { nameAr: 'بوينت', nameEn: 'POINT' },
      api: { mode: 'http', baseUrl: 'https://api.example.test' },
      payments: { moyasarPublishableKey: 'pk_test_abc123', moyasarBaseUrl: 'https://pay.example.test/' },
    },
    true,
  );

  it('the configuration refuses a secret key, and a test key in a release unless asked', () => {
    const extra = (key: string) => ({
      brand: { nameAr: 'بوينت', nameEn: 'POINT' },
      api: { mode: 'http', baseUrl: 'https://api.example.test' },
      payments: { moyasarPublishableKey: key },
    });
    expect(() => parseAppConfig(extra('sk_test_secret'), true)).toThrow(ConfigError);
    expect(() => parseAppConfig(extra('sk_live_secret'), true)).toThrow(ConfigError);
    expect(() => parseAppConfig(extra('pk_test_abc'), false)).toThrow(ConfigError);
    expect(parseAppConfig(extra('pk_live_abc'), false).payments.moyasarPublishableKey).toBe('pk_live_abc');
    expect(base.payments.moyasarBaseUrl).toBe('https://pay.example.test');
  });

  it('posts the card to the gateway alone, with the publishable key and save_only, and returns the token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ id: 'token_abcDEF123', status: 'active', verification_url: null }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;
    const tokenize = createCardTokenizer(base, {
      fetchImpl,
      callbackUrl: 'sa.point.app://pay/return',
      btoa: (s) => Buffer.from(s).toString('base64'),
    });
    expect(await tokenize(card('4111111111111111'))).toEqual({
      token: 'token_abcDEF123',
      verificationUrl: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://pay.example.test/v1/tokens');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(Buffer.from(headers.authorization!.replace('Basic ', ''), 'base64').toString()).toBe(
      'pk_test_abc123:',
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      number: '4111111111111111',
      month: '12',
      year: '2030',
      save_only: true,
    });
  });

  it('refuses without a key, maps a refusal, and the fake keeps the card out of its token', async () => {
    const noKey = createCardTokenizer({
      ...base,
      payments: { ...base.payments, moyasarPublishableKey: null },
    });
    await expect(noKey(card('4111111111111111'))).rejects.toMatchObject({ kind: 'unavailable' });
    const refused = createCardTokenizer(base, {
      fetchImpl: (async () =>
        new Response('{"type":"invalid_request_error"}', { status: 400 })) as unknown as typeof fetch,
      callbackUrl: 'x://y',
      btoa: (s) => Buffer.from(s).toString('base64'),
    });
    await expect(refused(card('4111111111111111'))).rejects.toBeInstanceOf(TokenizeError);
    const t = fakeTokenize(card('4000000000000002'));
    expect(t).not.toMatch(/[0-9]{13,}/);
    expect(parseFakeToken(t)).toMatchObject({ behaviour: 'tds', last4: '0002', month: 12, year: 2030 });
  });
});

describe('C-12 pay flow on the fake backend (V2-022)', () => {
  async function ready() {
    const ctx = setup({ demoVisitPhones: [DEMO_PHONE] });
    await signIn(ctx, DEMO_PHONE);
    const opened: string[] = [];
    const deps: PayDeps = {
      api: ctx.api,
      openAuthSession: async (url) => {
        opened.push(url);
        ctx.clock.advance(1000);
      },
      sleep: async (ms) => ctx.clock.advance(ms),
      now: ctx.clock.now,
    };
    return { ctx, deps, opened };
  }

  it('a frictionless card is paid at once, with the receipt; a second payment is «already paid»', async () => {
    const { deps } = await ready();
    const out = await payVisit(deps, {
      ticketId: DEMO_TICKET,
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('paid');
    if (out.kind === 'paid')
      expect(out.payment.receipt).toMatchObject({
        amount_halalas: 2000,
        vat_halalas: 261,
        net_halalas: 1739,
      });
    const again = await payVisit(deps, {
      ticketId: DEMO_TICKET,
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      idempotencyKey: 'k-2',
    });
    expect(again.kind).toBe('already_paid');
  });

  it('3-D Secure: the page opens in the in-app browser, the return proves nothing, the poll reads paid', async () => {
    const { deps, opened } = await ready();
    const out = await payVisit(
      deps,
      {
        ticketId: DEMO_TICKET,
        source: { type: 'token', token: fakeTokenize(card('4000000000000002')) },
        saveCard: true,
        cardOnFileVersion: '2026-11-01',
        idempotencyKey: 'k-3',
      },
      { pollMs: 500 },
    );
    expect(opened).toHaveLength(1);
    expect(out.kind).toBe('paid');
    // the card saved with it is on file once paid
    const cards = await deps.api.payment(out.kind === 'paid' ? out.payment.payment_id : '');
    expect(cards.saved_payment_method_id).toBeTruthy();
  });

  it('a decline, a 3-D Secure failure, a missing consent, a stale consent', async () => {
    const { deps } = await ready();
    const declined = await payVisit(deps, {
      ticketId: DEMO_TICKET,
      source: { type: 'token', token: fakeTokenize(card('4201320000311101')) },
      idempotencyKey: 'k-4',
    });
    expect(declined).toMatchObject({ kind: 'failed', code: '51' });
    const consent = await payVisit(deps, {
      ticketId: DEMO_TICKET,
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      idempotencyKey: 'k-5',
    });
    expect(consent).toEqual({ kind: 'consent', currentVersion: '2026-11-01' });
    const stale = await payVisit(deps, {
      ticketId: DEMO_TICKET,
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      saveCard: true,
      cardOnFileVersion: '2020-01-01',
      idempotencyKey: 'k-6',
    });
    expect(stale.kind).toBe('consent');
    const tds = await payVisit(
      deps,
      {
        ticketId: DEMO_TICKET,
        source: { type: 'token', token: fakeTokenize(card('4201320131000508')) },
        idempotencyKey: 'k-7',
      },
      { pollMs: 500 },
    );
    expect(tds.kind).toBe('failed');
  });

  it('a slow bank: «قيد التأكيد» after the timeout, then checkPayment reads the outcome', async () => {
    const { ctx, deps } = await ready();
    const slow: PayDeps = {
      ...deps,
      sleep: async (ms) => ctx.clock.advance(Math.min(ms, 100)),
      openAuthSession: async () => {},
    };
    const out = await payVisit(
      slow,
      {
        ticketId: DEMO_TICKET,
        source: { type: 'token', token: fakeTokenize(card('4000000000000002')) },
        idempotencyKey: 'k-8',
      },
      { pollMs: 100, timeoutMs: 500 },
    );
    expect(out.kind).toBe('pending');
    if (out.kind !== 'pending') return;
    ctx.clock.advance(5000);
    expect((await checkPayment(deps, out.payment.payment_id)).kind).toBe('paid');
  });

  it('another visit is not the account’s (RESOURCE_NOT_FOUND → error)', async () => {
    const { deps } = await ready();
    const out = await payVisit(deps, {
      ticketId: '00000000-0000-4000-8000-000000000000',
      source: { type: 'token', token: fakeTokenize(card('4111111111111111')) },
      idempotencyKey: 'k-9',
    });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect((out.error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('C-18 saved cards on the fake backend (V2-023)', () => {
  it('add with consent, default, remove, the view shows network/last4/expiry only', async () => {
    const ctx = setup();
    await signIn(ctx);
    await expect(
      ctx.api.addPaymentMethod({ token: fakeTokenize(card('4111111111111111')) }),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_CONSENT_REQUIRED',
    });
    try {
      await ctx.api.addPaymentMethod({
        token: fakeTokenize(card('4111111111111111')),
        card_on_file_version: 'old',
      });
    } catch (e) {
      expect(consentVersionFrom(e)).toBe('2026-11-01');
    }
    const a = await ctx.api.addPaymentMethod({
      token: fakeTokenize(card('4111111111111111')),
      card_on_file_version: '2026-11-01',
    });
    ctx.clock.advance(1000);
    const b = await ctx.api.addPaymentMethod({
      token: fakeTokenize(card('4400000000000008')),
      card_on_file_version: '2026-11-01',
    });
    expect(a.is_default).toBe(true);
    expect(b.is_default).toBe(false);
    expect(cardRow(b, ar)).toMatchObject({ isDefault: false, expires: 'تنتهي 12/30' });
    expect(cardRow(b, ar).title).toContain('مدى');
    await ctx.api.setDefaultPaymentMethod(b.id);
    expect(orderCards(await ctx.api.paymentMethods()).map((c) => [c.id, c.is_default])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
    await ctx.api.removePaymentMethod(b.id);
    expect((await ctx.api.paymentMethods()).map((c) => [c.id, c.is_default])).toEqual([[a.id, true]]);
    await expect(ctx.api.removePaymentMethod(b.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(JSON.stringify(await ctx.api.paymentMethods())).not.toContain('token_');
  });
});
