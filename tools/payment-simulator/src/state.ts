import { randomBytes, randomUUID } from 'node:crypto';
import { cardByNumber, maskedNumber, type CardBehaviour, type TestCard } from './cards.js';
import { defaultConfig, type PaymentSimulatorConfig } from './config.js';

/** A payment as the Moyasar API returns it (the fields this platform reads, plus the usual ones). */
export interface SimPayment {
  id: string;
  status: 'initiated' | 'paid' | 'failed' | 'authorized' | 'captured' | 'refunded' | 'voided';
  amount: number;
  fee: number;
  currency: string;
  refunded: number;
  refunded_at: string | null;
  captured: number;
  captured_at: string | null;
  voided_at: string | null;
  description: string | null;
  invoice_id: string | null;
  ip: string | null;
  callback_url: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string> | null;
  source: {
    type: 'creditcard' | 'applepay' | 'stcpay';
    company: string | null;
    name: string | null;
    number: string | null;
    gateway_id: string;
    reference_number: string | null;
    token: string | null;
    message: string | null;
    transaction_url: string | null;
    response_code: string | null;
  };
}

export interface SimToken {
  id: string;
  status: 'initiated' | 'active';
  brand: string;
  funding: string;
  country: string;
  month: string;
  year: string;
  name: string;
  last_four: string;
  created_at: string;
  updated_at: string;
  /** never returned by the API: the behaviour of the card behind the token */
  card: TestCard;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  type: string;
  payment_id: string;
  body: string;
  attempts: number;
  status: number | null;
  error: string | null;
  at: string;
}

interface PaymentMeta {
  behaviour: CardBehaviour;
  card: TestCard | null;
  givenId: string | null;
}

/** In-memory state of one simulator: tokens, payments, webhook deliveries. */
export class PaymentSimulatorState {
  config: PaymentSimulatorConfig;
  readonly tokens = new Map<string, SimToken>();
  readonly payments = new Map<string, SimPayment>();
  readonly meta = new Map<string, PaymentMeta>();
  readonly deliveries: WebhookDelivery[] = [];
  private readonly pending = new Set<Promise<void>>();
  baseUrl = 'http://payment-simulator.local';

  constructor(
    config: Partial<PaymentSimulatorConfig> = {},
    readonly now: () => Date = () => new Date(),
    private readonly logger: (line: string) => void = () => {},
  ) {
    this.config = defaultConfig(config);
  }

  log(line: string): void {
    this.logger(line);
  }

  iso(): string {
    return this.now().toISOString();
  }

  reset(): void {
    this.tokens.clear();
    this.payments.clear();
    this.meta.clear();
    this.deliveries.length = 0;
  }

  tokenize(input: {
    number: string;
    name?: string;
    month?: string | number;
    year?: string | number;
  }): SimToken {
    const card = cardByNumber(input.number);
    if (!card) throw new Error('unknown test card');
    const at = this.iso();
    const t: SimToken = {
      id: `token_${randomBytes(12).toString('hex')}`,
      status: 'active',
      brand: card.company,
      funding: 'debit',
      country: 'SA',
      month: String(input.month ?? '12'),
      year: String(input.year ?? '2030'),
      name: input.name ?? 'TEST CARD',
      last_four: card.number.slice(-4),
      created_at: at,
      updated_at: at,
      card,
    };
    this.tokens.set(t.id, t);
    return t;
  }

  createPayment(input: {
    amount: number;
    currency: string;
    description: string | null;
    callbackUrl: string | null;
    metadata: Record<string, string> | null;
    givenId: string | null;
    source: {
      type: 'creditcard' | 'applepay' | 'stcpay';
      card: TestCard | null;
      behaviour: CardBehaviour;
      token: string | null;
    };
  }): SimPayment {
    const at = this.iso();
    const id = input.givenId ?? randomUUID();
    const challenge = input.source.behaviour === '3ds_success' || input.source.behaviour === '3ds_declined';
    const declined = input.source.behaviour === 'declined';
    const card = input.source.card;
    const p: SimPayment = {
      id,
      status: challenge ? 'initiated' : declined ? 'failed' : 'paid',
      amount: input.amount,
      fee: Math.round(input.amount * 0.0175),
      currency: input.currency,
      refunded: 0,
      refunded_at: null,
      captured: 0,
      captured_at: null,
      voided_at: null,
      description: input.description,
      invoice_id: null,
      ip: null,
      callback_url: input.callbackUrl,
      created_at: at,
      updated_at: at,
      metadata: input.metadata,
      source: {
        type: input.source.type,
        company: card?.company ?? (input.source.type === 'applepay' ? 'visa' : null),
        name: card ? 'TEST CARD' : null,
        number: card ? maskedNumber(card.number) : null,
        gateway_id: `moyasar_sim_${randomBytes(6).toString('hex')}`,
        reference_number: String(100000 + Math.floor(Math.random() * 899999)),
        token: input.source.token,
        message: challenge ? null : (card?.message ?? (declined ? 'DECLINED' : 'APPROVED')),
        transaction_url: challenge ? `${this.baseUrl}/sim/3ds/${id}` : null,
        response_code: challenge ? null : (card?.responseCode ?? (declined ? '05' : '00')),
      },
    };
    this.payments.set(id, p);
    this.meta.set(id, { behaviour: input.source.behaviour, card, givenId: input.givenId });
    this.log(`payment ${id} ${p.status} ${p.amount} ${p.currency}`);
    return p;
  }

  /** The 3-D Secure page answered: the payment ends paid or failed by its card (or by `outcome`). */
  complete3ds(id: string, outcome?: 'success' | 'fail'): SimPayment {
    const p = this.mustGet(id);
    if (p.status !== 'initiated') throw new Error(`payment ${id} is ${p.status}`);
    const meta = this.meta.get(id);
    const ok = outcome ? outcome === 'success' : meta?.behaviour !== '3ds_declined';
    p.status = ok ? 'paid' : 'failed';
    p.source.message = ok ? 'APPROVED' : (meta?.card?.message ?? '3-D Secure transaction attempt failed');
    p.source.response_code = ok ? '00' : (meta?.card?.responseCode ?? '05');
    p.source.transaction_url = null;
    p.updated_at = this.iso();
    this.log(`payment ${id} 3ds → ${p.status}`);
    return p;
  }

  refund(id: string, amount: number | undefined): SimPayment {
    const p = this.mustGet(id);
    if (p.status !== 'paid' && p.status !== 'captured') throw new RefundRefused(`payment is ${p.status}`);
    const left = p.amount - p.refunded;
    const value = amount ?? left;
    if (!Number.isInteger(value) || value <= 0 || value > left)
      throw new RefundRefused('amount exceeds refundable');
    p.refunded += value;
    p.refunded_at = this.iso();
    // a partial refund leaves the payment paid with `refunded` set; the full amount makes it refunded
    if (p.refunded === p.amount) p.status = 'refunded';
    p.updated_at = this.iso();
    this.log(`payment ${id} refunded ${value} (total ${p.refunded})`);
    return p;
  }

  mustGet(id: string): SimPayment {
    const p = this.payments.get(id);
    if (!p) throw new NotFound();
    return p;
  }

  /** Tracks a webhook delivery so that tests can wait for every event in flight. */
  track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export class NotFound extends Error {}
export class RefundRefused extends Error {}
