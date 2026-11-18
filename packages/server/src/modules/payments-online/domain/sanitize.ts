/**
 * What may be kept of a gateway payload (DEC-512, docs/v2/04 §6): never the webhook's shared secret, never a card
 * number — masked or not — nor the cardholder's name, never a saved-card token (it can charge the card with our secret
 * key). The card is reduced to its brand and last four digits, and any run of 13 or more digits left anywhere (the
 * length of a card number) is replaced, so that what is stored or logged cannot hold a card number
 * (`ck_gateway_webhook_events_no_pan` checks the same rule in the database).
 */
export const PAN_LIKE = /[0-9]{13,}/;
const PAN_RUNS = /[0-9]{13,}/g;
const REMOVED = '[REMOVED]';

/** Keys of a payment `source` that are dropped (the rest is kept). */
const SOURCE_DROPPED = new Set(['number', 'name', 'token', 'cvc', 'month', 'year', 'dpan', 'cryptogram']);
/** Top-level keys of a webhook body that are dropped. */
const BODY_DROPPED = new Set(['secret_token']);

export function last4Of(number: unknown): string | null {
  if (typeof number !== 'string') return null;
  const d = number.replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return value.replace(PAN_RUNS, REMOVED);
  if (typeof value === 'number') return PAN_LIKE.test(String(value)) ? REMOVED : value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return value;
}

/** A payment object of the gateway as it may be stored: source without card fields, plus `last4`. */
export function sanitizePayment(payment: unknown): Record<string, unknown> {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return {};
  const p = { ...(payment as Record<string, unknown>) };
  const source = p.source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const s = source as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (!SOURCE_DROPPED.has(k)) kept[k] = v;
    kept.last4 = last4Of(s.number);
    kept.has_token = typeof s.token === 'string' && s.token.length > 0;
    p.source = kept;
  }
  return scrub(p) as Record<string, unknown>;
}

/** A webhook body as it may be stored: no secret_token, its payment sanitized. */
export function sanitizeWebhookBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (BODY_DROPPED.has(k)) continue;
    out[k] = k === 'data' ? sanitizePayment(v) : scrub(v);
  }
  return out;
}
