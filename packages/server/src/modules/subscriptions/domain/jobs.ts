import { sha256Hex } from '../../../core/crypto/crypto.js';

/** The subscription timers (canon §7.2 V2 rows; V2-031, DEC-532, DEC-533). */
export const SUBSCRIPTION_RENEW_JOB = 'job.subscription_renew';
export const SUBSCRIPTION_GRACE_EXPIRE_JOB = 'job.subscription_grace_expire';
export const SUBSCRIPTION_RENEWAL_NOTICE_JOB = 'job.subscription_renewal_notice';
export const PENDING_PAYMENT_EXPIRE_JOB = 'job.pending_payment_expire';
/** V2-036 (DEC-594): the customer's freeze of a counted-day term starts and ends at Riyadh midnight. */
export const SUBSCRIPTION_FREEZE_START_JOB = 'job.subscription_freeze_start';
export const SUBSCRIPTION_FREEZE_END_JOB = 'job.subscription_freeze_end';

/** An RFC 4122 v4-shaped uuid made of a sha256 digest (the gateway's given_id, DEC-521's shape). */
export function uuidOfDigest(input: string): string {
  const h = sha256Hex(input);
  const v = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The given_id of a renewal charge (DEC-533): one per subscription, period and attempt — a worker that runs the same
 * attempt twice (a crash after the gateway call, a retried job) sends the same given_id and the gateway never charges
 * twice; a later attempt of the grace is another payment.
 */
export function renewalGivenId(subscriptionId: string, seq: number, attempt: number): string {
  return uuidOfDigest(`point-subscription-renew:v1:${subscriptionId}:${seq}:${attempt}`);
}

/** The given_id of a customer's checkout (subscribe or pay): the account and the command's Idempotency-Key. */
export function checkoutGivenId(
  kind: 'subscribe' | 'pay',
  accountId: string,
  idempotencyKey: string,
): string {
  return uuidOfDigest(`point-subscription-${kind}:v1:${accountId}:${idempotencyKey}`);
}
