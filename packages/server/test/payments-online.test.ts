import { vatOfInclusive } from '@point/shared';
import { describe, expect, it } from 'vitest';
import {
  MoyasarGateway,
  type MoyasarKeyPolicy,
  decideSync,
  normalizePayment,
  riyadhDate,
  riyadhDayWindow,
  sanitizeWebhookBody,
  type GatewayPayment,
} from '../src/index.js';

const gp = (o: Partial<GatewayPayment> = {}): GatewayPayment => ({
  id: 'pay-1',
  status: 'paid',
  amount: 2300,
  currency: 'SAR',
  refunded: 0,
  createdAt: null,
  updatedAt: null,
  metadata: {},
  source: {
    type: 'creditcard',
    company: 'visa',
    last4: '1111',
    failureCode: null,
    transactionUrl: null,
    token: null,
  },
  ...o,
});
const local = (status: Parameters<typeof decideSync>[0]['status'], refunded = 0) => ({
  status,
  amount_halalas: 2300,
  refunded_halalas: refunded,
  currency: 'SAR',
});

describe('the online payment machine (DEC-512)', () => {
  it('moves forward with the gateway', () => {
    expect(decideSync(local('initiated'), gp())).toEqual({ kind: 'apply', status: 'paid', refunded: 0 });
    expect(decideSync(local('initiated'), gp({ status: 'failed' }))).toMatchObject({
      kind: 'apply',
      status: 'failed',
    });
    expect(decideSync(local('initiated'), gp({ status: 'authorized' }))).toMatchObject({
      status: 'authorized',
    });
    expect(decideSync(local('authorized'), gp({ status: 'captured' }))).toMatchObject({ status: 'paid' });
    // a partial refund leaves the gateway's payment `paid`
    expect(decideSync(local('paid'), gp({ refunded: 500 }))).toEqual({
      kind: 'apply',
      status: 'partially_refunded',
      refunded: 500,
    });
    expect(decideSync(local('partially_refunded', 500), gp({ refunded: 900 }))).toEqual({
      kind: 'apply',
      status: 'partially_refunded',
      refunded: 900,
    });
    expect(decideSync(local('partially_refunded', 500), gp({ status: 'refunded', refunded: 2300 }))).toEqual({
      kind: 'apply',
      status: 'refunded',
      refunded: 2300,
    });
    // a void after the charge gives the money back; before it, nothing was paid
    expect(decideSync(local('paid'), gp({ status: 'voided' }))).toMatchObject({
      status: 'refunded',
      refunded: 2300,
    });
    expect(decideSync(local('initiated'), gp({ status: 'voided' }))).toMatchObject({ status: 'failed' });
  });

  it('never moves back on an older read (late or out-of-order delivery)', () => {
    expect(decideSync(local('paid'), gp({ status: 'initiated' }))).toEqual({ kind: 'unchanged' });
    expect(decideSync(local('refunded', 2300), gp({ refunded: 0 }))).toEqual({ kind: 'unchanged' });
    expect(decideSync(local('partially_refunded', 900), gp({ refunded: 500 }))).toEqual({
      kind: 'unchanged',
    });
    expect(decideSync(local('paid'), gp({ status: 'authorized' }))).toEqual({ kind: 'unchanged' });
    expect(decideSync(local('paid'), gp())).toEqual({ kind: 'unchanged' });
    // a card check or an abandoned page says nothing about the money
    expect(decideSync(local('initiated'), gp({ status: 'verified' }))).toEqual({ kind: 'unchanged' });
  });

  it('a contradiction is a conflict, never applied', () => {
    expect(decideSync(local('failed'), gp())).toMatchObject({ kind: 'conflict', reason: 'status' });
    expect(decideSync(local('initiated'), gp({ amount: 2400 }))).toMatchObject({
      kind: 'conflict',
      reason: 'amount',
    });
    expect(decideSync(local('initiated'), gp({ currency: 'USD' }))).toMatchObject({ reason: 'currency' });
  });
});

describe('what is kept of a gateway payload (docs/v2/04 §6)', () => {
  it('drops the shared secret, the card number, the name and a saved-card token', () => {
    const body = {
      id: 'evt',
      type: 'payment_paid',
      secret_token: 'the-shared-secret',
      data: {
        id: 'pay-1',
        description: 'card 4111111111111111 in a free text',
        source: {
          type: 'creditcard',
          company: 'visa',
          number: '4111-11XX-XXXX-1111',
          name: 'AHMED',
          token: 'token_abc',
          message: 'APPROVED',
        },
      },
    };
    const kept = sanitizeWebhookBody(body);
    const text = JSON.stringify(kept);
    expect(text).not.toContain('the-shared-secret');
    expect(text).not.toContain('AHMED');
    expect(text).not.toContain('token_abc');
    expect(text).not.toMatch(/[0-9]{13,}/);
    expect(text).not.toContain('4111-11XX');
    expect((kept.data as { source: unknown }).source).toEqual({
      type: 'creditcard',
      company: 'visa',
      message: 'APPROVED',
      last4: '1111',
      has_token: true,
    });
  });

  it('normalizes the gateway payment without its card number', () => {
    const p = normalizePayment({
      id: 'pay-2',
      status: 'failed',
      amount: 1000,
      currency: 'SAR',
      refunded: 0,
      metadata: { online_payment_id: 'x', n: 3 },
      source: {
        type: 'creditcard',
        company: 'MADA',
        number: '4400-00XX-XXXX-0008',
        response_code: '51',
        message: 'INSUFFICIENT FUNDS',
      },
    })!;
    expect(p.source).toMatchObject({ company: 'mada', last4: '0008', failureCode: '51' });
    expect(p.metadata).toEqual({ online_payment_id: 'x', n: '3' });
    expect(JSON.stringify(p)).not.toContain('4400-00XX');
    expect(normalizePayment({ status: 'paid' })).toBeNull();
  });
});

describe('the Moyasar adapter', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ id: 'p', status: 'paid', amount: 100, currency: 'SAR', refunded: 0 }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof fetch;
  const gateway = (key: string, keyPolicy: MoyasarKeyPolicy = 'simulator', secrets = ['s1', 's0']) =>
    new MoyasarGateway({
      baseUrl: 'http://sim.test/',
      timeoutMs: 1000,
      secretKey: async () => key,
      webhookSecrets: async () => secrets,
      keyPolicy,
      fetch: fakeFetch,
    });

  it('sends the secret key as the Basic user name with an empty password', async () => {
    const r = await gateway('sk_test_abc').fetchPayment('p');
    expect(r.ok).toBe(true);
    expect(calls.at(-1)!.url).toBe('http://sim.test/v1/payments/p');
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('sk_test_abc:').toString('base64')}`,
    );
  });

  it('never sends a live key outside production (DEC-510)', async () => {
    const before = calls.length;
    const r = await gateway('sk_live_abc').fetchPayment('p');
    expect(r).toMatchObject({ ok: false, kind: 'refused' });
    expect(calls).toHaveLength(before);
    expect((await gateway('sk_live_abc', 'live').fetchPayment('p')).ok).toBe(true);
    // live sends only a live key, test (the gateway's test API) only a test key
    expect(await gateway('sk_test_abc', 'live').fetchPayment('p')).toMatchObject({
      ok: false,
      kind: 'refused',
    });
    expect((await gateway('sk_test_abc', 'test').fetchPayment('p')).ok).toBe(true);
    expect(await gateway('sk_live_abc', 'test').fetchPayment('p')).toMatchObject({
      ok: false,
      kind: 'refused',
    });
    expect(await gateway('pk_test_abc', 'test').fetchPayment('p')).toMatchObject({
      ok: false,
      kind: 'refused',
    });
    expect(calls).toHaveLength(before + 2);
  });

  it('verifies the shared secret in the body (the current one or the previous one)', async () => {
    const body = (secret: string) =>
      Buffer.from(
        JSON.stringify({ id: 'e1', type: 'payment_paid', secret_token: secret, data: { id: 'p' } }),
      );
    expect(await gateway('k').verifyWebhook(body('s1'))).toMatchObject({
      ok: true,
      event: { id: 'e1', paymentId: 'p' },
    });
    expect((await gateway('k').verifyWebhook(body('s0'))).ok).toBe(true);
    expect(await gateway('k').verifyWebhook(body('forged'))).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
    expect(await gateway('k').verifyWebhook(Buffer.from('not json'))).toEqual({
      ok: false,
      reason: 'not_json',
    });
    expect(await gateway('k', 'simulator', []).verifyWebhook(body('s1'))).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    const noType = Buffer.from(JSON.stringify({ id: 'e1', secret_token: 's1' }));
    expect(await gateway('k').verifyWebhook(noType)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('amounts and days', () => {
  it('VAT inside a VAT-inclusive price (15%)', () => {
    expect(vatOfInclusive(2300)).toBe(300);
    expect(vatOfInclusive(1000)).toBe(130);
    expect(vatOfInclusive(100)).toBe(13);
  });

  it('a Riyadh day is 21:00 UTC to 21:00 UTC', () => {
    expect(riyadhDate(new Date('2026-10-27T20:59:59Z'))).toBe('2026-10-27');
    expect(riyadhDate(new Date('2026-10-27T21:00:00Z'))).toBe('2026-10-28');
    expect(riyadhDayWindow('2026-10-27')).toEqual({
      from: new Date('2026-10-26T21:00:00.000Z'),
      to: new Date('2026-10-27T20:59:59.999Z'),
    });
  });
});
