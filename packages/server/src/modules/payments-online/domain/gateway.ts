import type { PaymentGatewayName } from '@point/shared';

/**
 * The payment gateway as the platform sees it (docs/v2/04 §3, V2-020; DEC-510, DEC-511). One adapter per gateway
 * (Moyasar today) and the simulator behind the same adapter in dev/tests/CI. The card itself never reaches the
 * server (SAQ-A, V2-D08): the customer's device tokenizes it with the gateway's publishable key, the server only
 * sends tokens.
 */
export interface PaymentGateway {
  readonly name: PaymentGatewayName;
  /** a one-off payment with a token (a card tokenized on the device, or an Apple Pay token) */
  createPayment(input: CreatePaymentInput): Promise<GatewayResult<CreatedPayment>>;
  /** a payment with a saved card's token (the renewals of V4); the gateway decides on 3-D Secure */
  chargeSavedMethod(input: ChargeSavedMethodInput): Promise<GatewayResult<CreatedPayment>>;
  /** refunds `amountHalalas` (the rest of the payment when left out); answers the payment after it */
  refund(gatewayPaymentId: string, amountHalalas?: number): Promise<GatewayResult<GatewayPayment>>;
  fetchPayment(gatewayPaymentId: string): Promise<GatewayResult<GatewayPayment>>;
  /** one page of the payments created in [from, to] (reconciliation) */
  listPayments(input: { from: Date; to: Date; page: number }): Promise<GatewayResult<GatewayPaymentPage>>;
  /** checks a webhook delivery's authenticity on the raw body; parses it only once that holds */
  verifyWebhook(raw: Buffer): Promise<WebhookVerification>;
}

export type GatewaySource =
  /** a card tokenized on the customer's device (`token_…`) */
  | { type: 'token'; token: string }
  /** the Apple Pay payment token handed over by the device */
  | { type: 'applepay'; token: string };

export interface CreatePaymentInput {
  /** our idempotency key at the gateway (`given_id`): a retried creation never charges twice */
  givenId: string;
  amountHalalas: number;
  description: string;
  /** where the gateway sends the customer after 3-D Secure; reaching it changes nothing (DEC-512) */
  callbackUrl: string;
  source: GatewaySource;
  /** ids only (online_payment_id, ticket_id …), never a phone or a plate */
  metadata: Record<string, string>;
}

export interface ChargeSavedMethodInput extends Omit<CreatePaymentInput, 'source'> {
  token: string;
}

export interface CreatedPayment {
  payment: GatewayPayment;
  /** the 3-D Secure page to open when the gateway asks for it (`initiated` with a transaction URL) */
  actionUrl: string | null;
}

/** The fields of the gateway's payment that the platform reads (normalized, no card number). */
export interface GatewayPayment {
  id: string;
  /** the gateway's own status (Moyasar: initiated, paid, failed, authorized, captured, refunded, voided, verified) */
  status: string;
  amount: number;
  currency: string;
  /** cumulative refunded amount in halalas */
  refunded: number;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, string>;
  source: {
    type: string | null;
    company: string | null;
    last4: string | null;
    /** a short machine code: the response code, or the message as a key */
    failureCode: string | null;
    transactionUrl: string | null;
    /** a saved-card token returned by the gateway (save_card) */
    token: string | null;
  };
}

export interface GatewayPaymentPage {
  payments: GatewayPayment[];
  nextPage: number | null;
}

export type GatewayFailureKind = 'http' | 'timeout' | 'network' | 'refused';

export type GatewayResult<T> =
  | { ok: true; status: number; value: T }
  | {
      ok: false;
      kind: GatewayFailureKind;
      status: number | null;
      /** the gateway's error type (invalid_request_error, authentication_error …) */
      type: string | null;
      message: string;
    };

export interface GatewayWebhookEvent {
  id: string;
  type: string;
  createdAt: string | null;
  live: boolean | null;
  paymentId: string | null;
  /** the parsed body minus the shared secret, card fields reduced to brand/last4 (sanitizeWebhookBody) */
  sanitized: Record<string, unknown>;
}

export type WebhookVerification =
  | { ok: true; event: GatewayWebhookEvent }
  | { ok: false; reason: 'not_json' | 'no_secret' | 'secret_mismatch' | 'not_configured' | 'malformed' };

/** True when the failure may pass on a retry (network, timeout, 5xx, 429). */
export function retryableFailure(r: Extract<GatewayResult<unknown>, { ok: false }>): boolean {
  if (r.kind === 'timeout' || r.kind === 'network') return true;
  if (r.kind === 'refused') return false;
  return r.status === 429 || (r.status !== null && r.status >= 500);
}
