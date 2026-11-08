/**
 * V2 online payments (docs/v2/04 §3, docs/v2/03 §4; V2-020 / V2-021, DEC-510 … DEC-514): the payment gateway of the
 * platform (Moyasar, V2-D08 as set by DEC-460), the statuses of `online_payments` and `refunds`, the raw webhook
 * deliveries, the daily reconciliation and the platform finance alerts. Kept apart from the V1 cash/POS payments
 * (`payments`, canon §5.7): an online payment is collected by POINT (V2-D03), never by an operator's driver.
 */
import { z } from 'zod';

/** `online_payments.gateway` and every gateway table (`ck_*_gateway`). One gateway today (DEC-460). */
export const PAYMENT_GATEWAYS = ['moyasar'] as const;
export type PaymentGatewayName = (typeof PAYMENT_GATEWAYS)[number];
export const PaymentGatewayNameSchema = z.enum(PAYMENT_GATEWAYS);

/** `online_payments.purpose` (docs/v2/03 §4). */
export const ONLINE_PAYMENT_PURPOSES = ['visit', 'subscription'] as const;
export type OnlinePaymentPurpose = (typeof ONLINE_PAYMENT_PURPOSES)[number];
export const OnlinePaymentPurposeSchema = z.enum(ONLINE_PAYMENT_PURPOSES);

/**
 * `online_payments.status`: initiated → authorized → paid | failed, then partially_refunded / refunded. The order of
 * this list is the order of the machine (a later status never goes back to an earlier one, DEC-512).
 */
export const ONLINE_PAYMENT_STATUSES = [
  'initiated',
  'authorized',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
] as const;
export type OnlinePaymentStatus = (typeof ONLINE_PAYMENT_STATUSES)[number];
export const OnlinePaymentStatusSchema = z.enum(ONLINE_PAYMENT_STATUSES);

/** The statuses in which the customer's money is held by POINT (one per ticket: `uq_online_payments_ticket_paid`). */
export const ONLINE_PAYMENT_PAID_STATUSES = [
  'paid',
  'partially_refunded',
] as const satisfies readonly OnlinePaymentStatus[];

/** The statuses a refund can be issued from (`platform.refund_issue`, DEC-513). */
export const ONLINE_PAYMENT_REFUNDABLE_STATUSES = ONLINE_PAYMENT_PAID_STATUSES;

/** `refunds.status`: requested (committed, not yet at the gateway) → succeeded | failed. */
/** `refunds.kind` (0014, DEC-523): issued by a platform user (P-06/P-08), or by the platform itself. */
export const REFUND_KINDS = ['manual', 'system'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/** The reason of a system refund (`refunds.reason`, DEC-523). */
export const SYSTEM_REFUND_REASONS = ['double_payment', 'not_due'] as const;
export type SystemRefundReason = (typeof SYSTEM_REFUND_REASONS)[number];

export const REFUND_STATUSES = ['requested', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const RefundStatusSchema = z.enum(REFUND_STATUSES);

/** `gateway_webhook_events.outcome` once the worker processed the delivery (DEC-512). */
export const GATEWAY_WEBHOOK_OUTCOMES = [
  'applied',
  'unchanged',
  'unknown_payment',
  'conflict',
  'not_at_gateway',
  'ignored',
] as const;
export type GatewayWebhookOutcome = (typeof GATEWAY_WEBHOOK_OUTCOMES)[number];

/** `payment_reconciliation_runs.status` (DEC-514). */
export const RECONCILIATION_STATUSES = ['running', 'matched', 'mismatched', 'failed'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** What a reconciliation found for one payment (`payment_reconciliation_runs.mismatches[].kind`). */
export const RECONCILIATION_MISMATCH_KINDS = [
  'unknown_at_point',
  'missing_at_gateway',
  'status',
  'amount',
  'refunded',
] as const;
export type ReconciliationMismatchKind = (typeof RECONCILIATION_MISMATCH_KINDS)[number];

/**
 * Platform finance alerts (`platform_alerts.type`, P-01/P-08; DEC-514). The V1 `alerts` table is the operator
 * supervisors' (a venue is mandatory, 14 §8): the platform's money never raises one of those.
 */
export const PLATFORM_ALERT_TYPES = [
  'payment_unknown',
  'payment_mismatch',
  'payment_refund_failed',
  'payment_reconcile_failed',
  // V2-022 (DEC-523): an online visit payment that succeeded for a ticket already paid, refunded by the platform
  'payment_double',
] as const;
export type PlatformAlertType = (typeof PLATFORM_ALERT_TYPES)[number];
export const PlatformAlertTypeSchema = z.enum(PLATFORM_ALERT_TYPES);

export const PLATFORM_ALERT_SEVERITY: Record<PlatformAlertType, 'info' | 'warning' | 'critical'> = {
  payment_unknown: 'critical',
  payment_mismatch: 'critical',
  payment_refund_failed: 'warning',
  payment_reconcile_failed: 'warning',
  payment_double: 'warning',
};

/** The tables of migration 0012_online_payments.sql (outside canon §6, which lists the V1 tables). */
export const ONLINE_PAYMENT_TABLE_NAMES = [
  'customer_payment_methods',
  'online_payments',
  'refunds',
  'gateway_webhook_events',
  'payment_reconciliation_runs',
  'platform_alerts',
] as const;

/** VAT of Saudi Arabia (docs/v2/04 §4): prices shown to the customer include it. */
export const VAT_RATE_BASIS_POINTS = 1500;

/**
 * The VAT inside a VAT-inclusive amount in halalas: `total − round(total / 1.15)` (04 §4: «الأسعار … شاملة ضريبة
 * القيمة المضافة 15%، وتُفصَل في الفاتورة»), in integer arithmetic.
 */
export function vatOfInclusive(totalHalalas: number, rateBp = VAT_RATE_BASIS_POINTS): number {
  if (!Number.isSafeInteger(totalHalalas) || totalHalalas < 0) throw new RangeError('amount in halalas');
  const net = Math.round((totalHalalas * 10_000) / (10_000 + rateBp));
  return totalHalalas - net;
}

/** `POST /v1/platform/payments/{paymentId}/refunds` (DEC-513): a full refund when the amount is left out. */
export const RefundIssueBodySchema = z
  .object({
    amount_halalas: z.number().int().positive().max(100_000_000).optional(),
    /** 3 characters at least once trimmed, else REASON_REQUIRED (the service checks it, like 09 §6) */
    reason: z.string().max(500).nullable().optional(),
  })
  .strict();
export type RefundIssueBody = z.infer<typeof RefundIssueBodySchema>;
