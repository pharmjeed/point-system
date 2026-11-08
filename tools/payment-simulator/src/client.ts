import type { PaymentSimulatorConfig } from './config.js';
import type { SimPayment, WebhookDelivery } from './state.js';

export class PaymentSimulatorClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`payment simulator answered ${status}: ${JSON.stringify(body)}`);
  }
}

/** Test and dev client of the simulator's control API (`/_sim/*`) and of its device-side tokenization. */
export class PaymentSimulatorClient {
  constructor(
    readonly url: string,
    private readonly config: Pick<PaymentSimulatorConfig, 'publishableKey'>,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, auth?: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(auth ? { authorization: `Basic ${Buffer.from(`${auth}:`).toString('base64')}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) throw new PaymentSimulatorClientError(res.status, json);
    return json as T;
  }

  configure(patch: Partial<PaymentSimulatorConfig>): Promise<{ ok: true }> {
    return this.call('PATCH', '/_sim/config', patch);
  }

  reset(): Promise<{ ok: true }> {
    return this.call('POST', '/_sim/reset', {});
  }

  /** What the customer's device does (publishable key): a card number becomes a gateway token. */
  async tokenize(number: string): Promise<string> {
    const t = await this.call<{ id: string }>(
      'POST',
      '/v1/tokens',
      { name: 'TEST CARD', number, cvc: '123', month: '12', year: '2030' },
      this.config.publishableKey,
    );
    return t.id;
  }

  /** The tokens the gateway holds and those deleted by the server (V2-023: a removed card's token leaves). */
  tokens(): Promise<{ active: string[]; deleted: string[] }> {
    return this.call('GET', '/_sim/tokens');
  }

  payment(id: string): Promise<SimPayment> {
    return this.call('GET', `/_sim/payments/${encodeURIComponent(id)}`);
  }

  payments(): Promise<SimPayment[]> {
    return this.call('GET', '/_sim/payments');
  }

  /** The customer answers the 3-D Secure page; returns the redirect to the callback URL (which changes nothing). */
  complete3ds(
    id: string,
    outcome?: 'success' | 'fail',
  ): Promise<{ payment: SimPayment; redirect_url: string }> {
    return this.call('POST', `/_sim/payments/${encodeURIComponent(id)}/3ds`, outcome ? { outcome } : {});
  }

  /** A payment the platform never created (dashboard, another integration). */
  externalPayment(amount: number, opts: { emit?: boolean } = {}): Promise<SimPayment> {
    return this.call('POST', '/_sim/payments', { amount, emit: opts.emit ?? true });
  }

  /** Changes the gateway's record behind the platform's back (reconciliation tests). */
  mutate(
    id: string,
    patch: { status?: SimPayment['status']; amount?: number; refunded?: number },
  ): Promise<SimPayment> {
    return this.call('POST', `/_sim/payments/${encodeURIComponent(id)}/mutate`, patch);
  }

  /** Builds (and by default delivers) an event for a payment; `deliver: false` only returns its body. */
  webhook(
    id: string,
    o: { type?: string; status?: SimPayment['status']; deliver?: boolean; secret?: string } = {},
  ): Promise<{ body: string; status?: number | null }> {
    return this.call('POST', `/_sim/payments/${encodeURIComponent(id)}/webhook`, o);
  }

  /** Waits for every event in flight. */
  flush(): Promise<{ deliveries: number }> {
    return this.call('POST', '/_sim/webhooks/flush', {});
  }

  deliveries(): Promise<WebhookDelivery[]> {
    return this.call('GET', '/_sim/webhooks');
  }

  replay(eventId: string): Promise<{ status: number | null }> {
    return this.call('POST', '/_sim/webhooks/replay', { event_id: eventId });
  }
}
