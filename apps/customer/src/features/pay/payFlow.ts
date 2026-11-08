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
import type { CustomerPaymentSource, CustomerVisitPayment } from '@point/shared/customer';
import { ApiError } from '../../api/errors';
import type { CustomerApi } from '../../api/client';

export type PayOutcome =
  | { kind: 'paid'; payment: CustomerVisitPayment }
  | { kind: 'failed'; payment: CustomerVisitPayment | null; code: string | null }
  | { kind: 'pending'; payment: CustomerVisitPayment }
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
  let payment: CustomerVisitPayment;
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

function paymentOutcome(payment: CustomerVisitPayment): PayOutcome {
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
      };
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
