import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  createPaymentSimulatorServer,
  DEFAULT_SECRET_KEY,
  optionsFromEnv,
  ProductionRefusedError,
  startPaymentSimulator,
  TEST_CARDS,
  type RunningPaymentSimulator,
} from '../src/index.js';

const basic = (key: string) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

describe('payment simulator guards (DEC-510)', () => {
  it.each([{ APP_ENV: 'production' }, { NODE_ENV: 'production' }, { APP_ENV: ' Production ' }])(
    'refuses to start with %o',
    async (env) => {
      expect(() => createPaymentSimulatorServer({ env })).toThrow(ProductionRefusedError);
      await expect(startPaymentSimulator({ env })).rejects.toThrow(ProductionRefusedError);
    },
  );

  it('never takes a live key', () => {
    expect(() => createPaymentSimulatorServer({ env: {}, secretKey: 'sk_live_abcdef' })).toThrow(ConfigError);
    expect(() => optionsFromEnv({ MOYASAR_SECRET_KEY: 'sk_live_abcdef' })).toThrow(ConfigError);
    expect(optionsFromEnv({ MOYASAR_SECRET_KEY: 'sk_test_x', PORT: '4021' })).toMatchObject({
      port: 4021,
      secretKey: 'sk_test_x',
    });
  });
});

describe('payment simulator API (the Moyasar subset the server uses)', () => {
  let sim: RunningPaymentSimulator;
  const received: string[] = [];
  let hook: ReturnType<typeof createServer>;

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    sim = await startPaymentSimulator({ env: {}, pageSize: 2 });
    await sim.client.configure({
      webhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`,
    });
  });
  afterAll(async () => {
    await sim.close();
    await new Promise<void>((r) => hook.close(() => r()));
  });

  const api = (method: string, path: string, body?: unknown, key = DEFAULT_SECRET_KEY) =>
    fetch(`${sim.url}${path}`, {
      method,
      headers: { authorization: basic(key), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const pay = async (number: string, amount = 2300) => {
    const token = await sim.client.tokenize(number);
    const r = await api('POST', '/v1/payments', {
      amount,
      currency: 'SAR',
      description: 'test',
      callback_url: 'https://app.example.test/return',
      source: { type: 'token', token },
      metadata: { online_payment_id: 'x' },
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  it('authenticates with the secret key as the Basic user name; card data is refused from a backend', async () => {
    expect((await api('GET', '/v1/payments', undefined, 'sk_test_wrong')).status).toBe(401);
    expect((await api('GET', '/v1/payments', undefined, 'sk_live_whatever')).status).toBe(401);
    const card = await api('POST', '/v1/payments', {
      amount: 1000,
      callback_url: 'https://x.test',
      source: {
        type: 'creditcard',
        number: TEST_CARDS.success.number,
        cvc: '123',
        month: '12',
        year: '2030',
      },
    });
    expect(card.status).toBe(400);
    expect(JSON.stringify(await card.json())).toContain('payer device');
  });

  it('the test cards: paid at once, declined, 3-D Secure then paid or failed', async () => {
    const ok = await pay(TEST_CARDS.success.number);
    expect(ok).toMatchObject({
      status: 201,
      body: { status: 'paid', amount: 2300, currency: 'SAR', refunded: 0 },
    });
    expect(ok.body.source).toMatchObject({
      company: 'visa',
      number: '4111-11XX-XXXX-1111',
      transaction_url: null,
    });
    const no = await pay(TEST_CARDS.declined.number);
    expect(no.body).toMatchObject({ status: 'failed', source: { response_code: '51' } });
    const tds = await pay(TEST_CARDS.threeDs.number);
    expect(tds.body.status).toBe('initiated');
    expect(tds.body.source.transaction_url).toBe(`${sim.url}/sim/3ds/${tds.body.id}`);
    const done = await sim.client.complete3ds(tds.body.id);
    expect(done.payment.status).toBe('paid');
    expect(done.redirect_url).toContain(`id=${tds.body.id}`);
    const bad = await pay(TEST_CARDS.threeDsDeclined.number);
    expect((await sim.client.complete3ds(bad.body.id)).payment.status).toBe('failed');
  });

  it('given_id makes a creation idempotent', async () => {
    const token = await sim.client.tokenize(TEST_CARDS.success.number);
    const body = {
      given_id: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      amount: 1500,
      callback_url: 'https://x.test',
      source: { type: 'token', token },
    };
    const a = (await (await api('POST', '/v1/payments', body)).json()) as { id: string };
    const b = (await (await api('POST', '/v1/payments', body)).json()) as { id: string };
    expect(a.id).toBe('4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    expect(b.id).toBe(a.id);
    expect((await api('POST', '/v1/payments', { ...body, amount: 1600 })).status).toBe(400);
  });

  it('refunds: partial keeps paid with refunded, full makes it refunded, more is refused', async () => {
    const p = await pay(TEST_CARDS.success.number, 5000);
    const part = (await (
      await api('POST', `/v1/payments/${p.body.id}/refund`, { amount: 2000 })
    ).json()) as any;
    expect(part).toMatchObject({ status: 'paid', refunded: 2000 });
    expect((await api('POST', `/v1/payments/${p.body.id}/refund`, { amount: 3001 })).status).toBe(400);
    const rest = (await (await api('POST', `/v1/payments/${p.body.id}/refund`, {})).json()) as any;
    expect(rest).toMatchObject({ status: 'refunded', refunded: 5000 });
    expect((await api('POST', `/v1/payments/${p.body.id}/refund`, {})).status).toBe(400);
  });

  it('lists by page and fetches one payment', async () => {
    const page1 = (await (await api('GET', '/v1/payments?page=1')).json()) as any;
    expect(page1.payments).toHaveLength(2);
    expect(page1.meta).toMatchObject({ current_page: 1, next_page: 2 });
    const one = await api('GET', `/v1/payments/${page1.payments[0].id}`);
    expect(one.status).toBe(200);
    expect((await api('GET', '/v1/payments/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('webhooks carry the shared secret and the payment, never a full card number', async () => {
    await sim.client.flush();
    expect(received.length).toBeGreaterThan(3);
    const event = JSON.parse(received[0]!) as Record<string, any>;
    expect(event).toMatchObject({
      type: 'payment_paid',
      secret_token: sim.state.config.webhookSecret,
      live: false,
    });
    expect(event.data.status).toBe('paid');
    for (const b of received) expect(b).not.toMatch(/[0-9]{13,}/);
  });
});
