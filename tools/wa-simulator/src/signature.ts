import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header Meta uses for webhook payload signatures (docs/12 F-08, §6.2). */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/** `sha256=<hex HMAC-SHA256(appSecret, rawBody)>` — computed over the exact bytes that are sent. */
export function signWebhookBody(appSecret: string, rawBody: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Constant-time check of an `X-Hub-Signature-256` header against the raw body.
 * Accepts several secrets (app-secret rotation, docs/12 §3.3).
 */
export function verifyWebhookSignature(
  appSecret: string | readonly string[],
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const hex = header.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const given = Buffer.from(hex, 'hex');
  const secrets = typeof appSecret === 'string' ? [appSecret] : appSecret;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    // Evaluate every secret so the timing does not reveal which one matched.
    if (timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}
