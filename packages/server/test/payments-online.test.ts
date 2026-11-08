import { describe, expect, it } from 'vitest';
import { MoyasarGateway, normalizePayment, sanitizeWebhookBody } from '../src/index.js';

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
  const gateway = (key: string, allowLiveKey = false, secrets = ['s1', 's0']) =>
    new MoyasarGateway({
      baseUrl: 'http://sim.test/',
      timeoutMs: 1000,
      secretKey: async () => key,
      webhookSecrets: async () => secrets,
      allowLiveKey,
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
    expect((await gateway('sk_live_abc', true).fetchPayment('p')).ok).toBe(true);
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
    expect(await gateway('k', false, []).verifyWebhook(body('s1'))).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    const noType = Buffer.from(JSON.stringify({ id: 'e1', secret_token: 's1' }));
    expect(await gateway('k').verifyWebhook(noType)).toEqual({ ok: false, reason: 'malformed' });
  });
});
