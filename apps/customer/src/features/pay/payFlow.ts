/**
 * Paying a visit from C-12 (V2-022, docs/v2/01 R4, DEC-521), pure orchestration with injected effects so it is
 * unit-tested without React Native:
 *
 * 1. `POST /v1/customer/visits/{ticketId}/pay` with one Idempotency-Key for this attempt (a retry after a lost
 *    answer reuses it: the server never creates a second payment for it);
 * 2. `paid` / `failed` at once, or `initiated` with the gateway's 3-D Secure page: opened in an in-app browser
 *    (`expo-web-browser` auth session) that closes when it reaches `callback_url`;
 * 3. the return itself proves nothing (DEC-512): the app polls `GET /v1/customer/payments/{id}` until the server —
 *    told by the gateway's webhook — says `paid` or `failed`, or gives up and shows «قيد التأكيد».
 */
import type {
  CustomerPaymentSource,
  CustomerOnlinePayment,
  CustomerSubscriptionCheckout,
  CustomerSubscriptionPayment,
} from '@point/shared/customer';
import { ApiError } from '../../api/errors';
import type { CustomerApi } from '../../api/client';

type AnyPayment = CustomerOnlinePayment | CustomerSubscriptionPayment;

export type PayOutcome =
  | { kind: 'paid'; payment: AnyPayment }
  | { kind: 'failed'; payment: AnyPayment | null; code: string | null; subscriptionId?: string | null }
  | { kind: 'pending'; payment: AnyPayment }
  /** V2-032: the subscription renews with a saved card only (Apple Pay, a card not kept) */
  | { kind: 'card_required' }
  /** V2-032: the account subscribes at this venue already */
  | { kind: 'exists'; subscriptionId: string | null }
  | { kind: 'already_paid' }
  | { kind: 'in_progress'; retryAfterS: number | null }
  | { kind: 'consent'; currentVersion: string | null }
  | { kind: 'not_payable'; reason: string | null }
  | { kind: 'error'; error: unknown };

export interface PayDeps {
  api: Pick<CustomerApi, 'payVisit' | 'payment'>;
  /** opens the 3-D Secure page; resolves when the browser reached the return URL or was closed */
  openAuthSession: (url: string, returnUrl: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface PayRequest {
  ticketId: string;
  source: CustomerPaymentSource;
  saveCard?: boolean;
  cardOnFileVersion?: string;
  idempotencyKey: string;
}

const LIVE = new Set(['initiated', 'authorized']);

export async function payVisit(
  deps: PayDeps,
  req: PayRequest,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<PayOutcome> {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let payment: CustomerOnlinePayment;
  try {
    payment = await deps.api.payVisit(
      req.ticketId,
      {
        source: req.source,
        ...(req.saveCard ? { save_card: true, card_on_file_version: req.cardOnFileVersion } : {}),
      },
      req.idempotencyKey,
    );
  } catch (e) {
    return outcomeOfError(e);
  }
  if (payment.status === 'initiated' && payment.transaction_url) {
    try {
      await deps.openAuthSession(payment.transaction_url, payment.callback_url);
    } catch {
      // a browser that could not open: the server still decides; poll anyway
    }
  }
  const started = deps.now();
  while (LIVE.has(payment.status)) {
    if (deps.now() - started >= timeoutMs) return { kind: 'pending', payment };
    await deps.sleep(pollMs);
    try {
      payment = await deps.api.payment(payment.payment_id);
    } catch {
      // offline for a moment: keep the last known state and try again
    }
  }
  return paymentOutcome(payment);
}

/** Polls an earlier payment (the app was closed during 3-D Secure, or «قيد التأكيد» was shown). */
export async function checkPayment(deps: Pick<PayDeps, 'api'>, paymentId: string): Promise<PayOutcome> {
  try {
    return paymentOutcome(await deps.api.payment(paymentId));
  } catch (e) {
    return { kind: 'error', error: e };
  }
}

function paymentOutcome(payment: AnyPayment): PayOutcome {
  if (payment.status === 'failed') return { kind: 'failed', payment, code: payment.failure_code };
  if (LIVE.has(payment.status)) return { kind: 'pending', payment };
  return { kind: 'paid', payment };
}

function outcomeOfError(e: unknown): PayOutcome {
  if (!(e instanceof ApiError)) return { kind: 'error', error: e };
  const d = e.details as Record<string, unknown>;
  switch (e.code) {
    case 'PAYMENT_FAILED':
      return {
        kind: 'failed',
        payment: null,
        code: typeof d.failure_code === 'string' ? d.failure_code : null,
        subscriptionId: typeof d.subscription_id === 'string' ? d.subscription_id : null,
      };
    case 'SUBSCRIPTION_CARD_REQUIRED':
      return { kind: 'card_required' };
    case 'SUBSCRIPTION_ALREADY_EXISTS':
      return {
        kind: 'exists',
        subscriptionId: typeof d.subscription_id === 'string' ? d.subscription_id : null,
      };
    case 'SUBSCRIPTION_PLAN_UNAVAILABLE':
    case 'SUBSCRIPTION_NOT_ACTIVE':
      return { kind: 'not_payable', reason: e.code };
    case 'PAYMENT_ALREADY_RECORDED':
      return { kind: 'already_paid' };
    case 'PAYMENT_IN_PROGRESS':
      return {
        kind: 'in_progress',
        retryAfterS: typeof d.retry_after_s === 'number' ? d.retry_after_s : null,
      };
    case 'CUSTOMER_CONSENT_REQUIRED':
    case 'CUSTOMER_CONSENT_VERSION_STALE':
      return {
        kind: 'consent',
        currentVersion: typeof d.current_version === 'string' ? d.current_version : null,
      };
    case 'VISIT_NOT_PAYABLE':
      return { kind: 'not_payable', reason: typeof d.reason === 'string' ? d.reason : null };
    default:
      return { kind: 'error', error: e };
  }
}

/** V2-032 (C-09 → C-10, C-14 «ادفع»): what starts a subscription checkout — subscribe, or pay a waiting one. */
export interface SubscriptionCheckoutRequest {
  start: (
    body: { source: CustomerPaymentSource; save_card?: boolean; card_on_file_version?: string },
    idempotencyKey: string,
  ) => Promise<CustomerSubscriptionCheckout>;
  source: CustomerPaymentSource;
  saveCard?: boolean;
  cardOnFileVersion?: string;
  idempotencyKey: string;
}

export interface SubscriptionPayDeps extends Omit<PayDeps, 'api'> {
  api: Pick<CustomerApi, 'subscription'>;
}

/**
 * A subscription checkout (V2-032, DEC-534), the visit's flow with the subscription's own read: the start command
 * (one Idempotency-Key per attempt), the 3-D Secure page when asked, then `GET /v1/customer/subscriptions/{id}` polled
 * until its latest payment is `paid` or `failed` — the return from the page changes nothing (DEC-512).
 */
export async function checkoutSubscription(
  deps: SubscriptionPayDeps,
  req: SubscriptionCheckoutRequest,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<PayOutcome & { subscriptionId?: string | null }> {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let checkout: CustomerSubscriptionCheckout;
  try {
    checkout = await req.start(
      {
        source: req.source,
        ...(req.saveCard ? { save_card: true, card_on_file_version: req.cardOnFileVersion } : {}),
      },
      req.idempotencyKey,
    );
  } catch (e) {
    return outcomeOfError(e);
  }
  let payment: CustomerSubscriptionPayment = checkout.payment;
  const subscriptionId = checkout.subscription.subscription_id;
  if (payment.status === 'initiated' && payment.transaction_url) {
    try {
      await deps.openAuthSession(payment.transaction_url, payment.callback_url);
    } catch {
      // the server still decides; poll anyway
    }
  }
  const started = deps.now();
  while (LIVE.has(payment.status)) {
    if (deps.now() - started >= timeoutMs) return { kind: 'pending', payment, subscriptionId };
    await deps.sleep(pollMs);
    try {
      const sub = await deps.api.subscription(subscriptionId);
      if (sub.latest_payment && sub.latest_payment.payment_id === payment.payment_id)
        payment = sub.latest_payment;
    } catch {
      // offline for a moment: keep the last known state
    }
  }
  return { ...paymentOutcome(payment), subscriptionId };
}
