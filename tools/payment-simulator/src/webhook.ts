import { randomUUID } from 'node:crypto';
import type { PaymentSimulatorState, SimPayment, WebhookDelivery } from './state.js';

/** Moyasar's payment events (the `type` of a webhook body). */
export const PAYMENT_EVENT_TYPES = [
  'payment_paid',
  'payment_failed',
  'payment_refunded',
  'payment_voided',
  'payment_authorized',
  'payment_captured',
  'payment_abandoned',
  'payment_verified',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/** The event a status change produces (none for `initiated`). */
export function eventFor(p: SimPayment, refundedNow = false): PaymentEventType | null {
  if (refundedNow) return 'payment_refunded';
  switch (p.status) {
    case 'paid':
      return 'payment_paid';
    case 'failed':
      return 'payment_failed';
    case 'refunded':
      return 'payment_refunded';
    case 'voided':
      return 'payment_voided';
    case 'authorized':
      return 'payment_authorized';
    case 'captured':
      return 'payment_captured';
    default:
      return null;
  }
}

/**
 * The webhook body as Moyasar sends it: `{ id, type, created_at, secret_token, account_name, live, data }`, where
 * `secret_token` is the shared secret configured for the endpoint and `data` the payment at that moment.
 */
export function webhookBody(
  state: PaymentSimulatorState,
  type: string,
  p: SimPayment,
  opts: { eventId?: string; secret?: string } = {},
): string {
  return JSON.stringify({
    id: opts.eventId ?? randomUUID(),
    type,
    created_at: state.iso(),
    secret_token: opts.secret ?? state.config.webhookSecret,
    account_name: state.config.accountName,
    live: false,
    data: structuredClone(p),
  });
}

/** POSTs a body to the configured endpoint, retrying a non-2xx answer `webhookRetries` times. */
export async function deliver(state: PaymentSimulatorState, body: string): Promise<WebhookDelivery> {
  const parsed = JSON.parse(body) as { id: string; type: string; data: { id: string } };
  const d: WebhookDelivery = {
    id: randomUUID(),
    event_id: parsed.id,
    type: parsed.type,
    payment_id: parsed.data.id,
    body,
    attempts: 0,
    status: null,
    error: null,
    at: state.iso(),
  };
  state.deliveries.push(d);
  const url = state.config.webhookUrl;
  if (!url) {
    d.error = 'no webhook url';
    return d;
  }
  for (let i = 0; i <= state.config.webhookRetries; i++) {
    d.attempts++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Moyasar-Simulator' },
        body,
        signal: AbortSignal.timeout(state.config.webhookTimeoutMs),
      });
      d.status = res.status;
      d.error = null;
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) break;
    } catch (e) {
      d.error = (e as Error).message;
    }
  }
  state.log(`webhook ${d.type} ${d.payment_id} → ${d.status ?? d.error}`);
  return d;
}

/** Sends the event of a change in the background (like the gateway), unless auto webhooks are off. */
export function emitChange(state: PaymentSimulatorState, p: SimPayment, refundedNow = false): void {
  if (!state.config.autoWebhooks) return;
  const type = eventFor(p, refundedNow);
  if (!type) return;
  const body = webhookBody(state, type, p);
  state.track(deliver(state, body).then(() => undefined));
}
