/**
 * V2 phase V5 — invoices and operator settlement (docs/v2/04 §4–§5, docs/v2/03 §5; V2-040 … V2-042, DEC-540 …
 * DEC-549): POINT's tax invoices (ZATCA phase 2 through an e-invoicing provider not chosen yet, DEC-460), the
 * monthly settlement statements with each operator and the system-subscription (SaaS) invoices to the operators.
 * The values here are the literal values of migration 0017_invoices_settlement.sql.
 */
import { z } from 'zod';

/** `invoice_series.series`: one gapless chain (ICV + PIH) per e-invoicing unit (DEC-541). */
export const INVOICE_SERIES = ['simplified', 'standard'] as const;
export type InvoiceSeries = (typeof INVOICE_SERIES)[number];
export const InvoiceSeriesSchema = z.enum(INVOICE_SERIES);

/** The number prefix of each series (`invoice_series.prefix`): `PS-00000001`, `PB-00000001`. */
export const INVOICE_SERIES_PREFIX: Record<InvoiceSeries, string> = { simplified: 'PS', standard: 'PB' };

/**
 * `invoices.kind`: the customer's simplified tax invoice (B2C, reported), the operator's tax invoice for the system
 * subscription (B2B, cleared) and the credit note of either (its series is its original's).
 */
export const INVOICE_KINDS = ['customer_simplified', 'operator_standard', 'credit_note'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const InvoiceKindSchema = z.enum(INVOICE_KINDS);

/** UNTDID 1001 document type codes used by ZATCA: 388 tax invoice, 381 credit note (KSA type code, BT-3). */
export const INVOICE_TYPE_CODES = { invoice: 388, credit_note: 381 } as const;

/**
 * The ZATCA invoice transaction subtype (`InvoiceTypeCode/@name`, KSA-2): `01…` standard (clearance), `02…`
 * simplified (reporting); the five flags after it (third party, nominal, exports, summary, self-billed) are all 0.
 */
export const INVOICE_TRANSACTION_SUBTYPE: Record<InvoiceSeries, string> = {
  standard: '0100000',
  simplified: '0200000',
};

/** `invoices.zatca_status`: pending (not answered yet) → reported (simplified) | cleared (standard) | rejected. */
export const ZATCA_STATUSES = ['pending', 'reported', 'cleared', 'rejected'] as const;
export type ZatcaStatus = (typeof ZATCA_STATUSES)[number];
export const ZatcaStatusSchema = z.enum(ZATCA_STATUSES);

/** `EINVOICE_MODE` (DEC-540): the simulator (no network) everywhere but production; `live` in production only. */
export const EINVOICE_MODES = ['simulator', 'live'] as const;
export type EinvoiceMode = (typeof EINVOICE_MODES)[number];

/**
 * The first Previous Invoice Hash of a chain (ZATCA's base value, as in its SDK samples): base64 of the hexadecimal
 * SHA-256 of the string "0".
 */
export const FIRST_PREVIOUS_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/** `settlement_statements.status` (docs/v2/04 §5). */
export const SETTLEMENT_STATUSES = ['draft', 'issued', 'disputed', 'paid', 'void'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const SettlementStatusSchema = z.enum(SETTLEMENT_STATUSES);

/** The commands of a statement: `from` → `to` (trg_settlement_statements_guard enforces the same graph). */
export const SETTLEMENT_TRANSITIONS = {
  issue: { from: ['draft'], to: 'issued' },
  dispute: { from: ['issued'], to: 'disputed' },
  resolve_dispute: { from: ['disputed'], to: 'issued' },
  record_payment: { from: ['issued'], to: 'paid' },
  void: { from: ['draft', 'issued', 'disputed'], to: 'void' },
} as const satisfies Record<string, { from: readonly SettlementStatus[]; to: SettlementStatus }>;
export type SettlementCommand = keyof typeof SETTLEMENT_TRANSITIONS;

/** The statuses in which a statement takes a manual adjustment line. */
export const SETTLEMENT_ADJUSTABLE_STATUSES = [
  'draft',
  'disputed',
] as const satisfies readonly SettlementStatus[];

/** The statuses the operator sees in O-05 (a draft is the platform's work in progress). */
export const SETTLEMENT_OPERATOR_VISIBLE_STATUSES = [
  'issued',
  'disputed',
  'paid',
  'void',
] as const satisfies readonly SettlementStatus[];

/**
 * `settlement_lines.kind` with the sign of its amount on the net (positive: POINT pays the operator), docs/v2/04 §5
 * as built (DEC-545): subscriber visits × payout; app payments − POINT's commission − refunds + the commission given
 * back with each refund; the SaaS fee and its VAT; manual adjustments in either direction.
 */
export const SETTLEMENT_LINE_KINDS = [
  'subscriber_visit',
  'app_payment',
  'app_commission',
  'app_refund',
  'app_refund_commission',
  'saas_fee',
  'saas_vat',
  'adjustment',
] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];
export const SettlementLineKindSchema = z.enum(SETTLEMENT_LINE_KINDS);

export const SETTLEMENT_LINE_SIGN: Record<SettlementLineKind, 1 | -1 | 0> = {
  subscriber_visit: 1,
  app_payment: 1,
  app_commission: -1,
  app_refund: -1,
  app_refund_commission: 1,
  saas_fee: -1,
  saas_vat: -1,
  adjustment: 0,
};

/** The tables of migration 0017_invoices_settlement.sql (outside canon §6, which lists the V1 tables). */
export const INVOICING_TABLE_NAMES = [
  'invoice_series',
  'settlement_statements',
  'settlement_lines',
  'invoices',
  'invoice_provider_events',
] as const;

/** The reason or note of a settlement command: 3 characters at least once trimmed (REASON_REQUIRED), 500 at most. */
export const SETTLEMENT_REASON_MAX = 500;

/** Half-up rounding of `num / den` for non-negative integers (DEC-545: every line is rounded on its own). */
export function roundHalfUpDiv(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 0 || den <= 0)
    throw new RangeError('non-negative integer division');
  return Math.floor((2 * num + den) / (2 * den));
}

/** The basis-point share of an amount in halalas, half-up (commission, VAT on a net amount). */
export function shareOfBp(amountHalalas: number, bp: number): number {
  return roundHalfUpDiv(amountHalalas * bp, 10_000);
}

const isoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');
/** A settlement month, `YYYY-MM`. */
export const SettlementPeriodSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const cursor = z.string().min(1).max(512).optional();
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const version = z.number().int().min(1);
const reason = z.string().max(SETTLEMENT_REASON_MAX).nullish();

/** `GET /v1/platform/settlements` (P-09). */
export const PlatformSettlementsQuerySchema = z.strictObject({
  status: SettlementStatusSchema.optional(),
  org_id: z.uuid().optional(),
  period: SettlementPeriodSchema.optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformSettlementsQuery = z.infer<typeof PlatformSettlementsQuerySchema>;

/**
 * `POST /v1/platform/settlements/generate`: computes (or recomputes) the draft of a closed month for one operator or
 * for every operator — the same work as `job.settlement_monthly`.
 */
export const SettlementGenerateBodySchema = z.strictObject({
  period: SettlementPeriodSchema,
  org_id: z.uuid().optional(),
});
export type SettlementGenerateBody = z.infer<typeof SettlementGenerateBodySchema>;

/** `POST …/{statementId}/adjustments`: a signed amount (positive: POINT pays the operator) and its reason. */
export const SettlementAdjustmentBodySchema = z.strictObject({
  expected_version: version,
  amount_halalas: z
    .number()
    .int()
    .min(-10_000_000_000)
    .max(10_000_000_000)
    .refine((n) => n !== 0, 'not zero'),
  reason,
});
export type SettlementAdjustmentBody = z.infer<typeof SettlementAdjustmentBodySchema>;

/** `POST …/{statementId}/issue`. */
export const SettlementIssueBodySchema = z.strictObject({ expected_version: version });
export type SettlementIssueBody = z.infer<typeof SettlementIssueBodySchema>;

/** `POST …/{statementId}/record-payment`: the bank transfer's reference and its day (Riyadh). */
export const SettlementPaymentBodySchema = z.strictObject({
  expected_version: version,
  reference: z.string().max(120).nullish(),
  paid_on: isoDate,
});
export type SettlementPaymentBody = z.infer<typeof SettlementPaymentBodySchema>;

/** `POST …/{statementId}/resolve-dispute` and `…/void`: a note or reason (REASON_REQUIRED). */
export const SettlementReasonBodySchema = z.strictObject({ expected_version: version, reason });
export type SettlementReasonBody = z.infer<typeof SettlementReasonBodySchema>;

/** `POST /v1/settlement-statements/{statementId}/dispute` (O-05, the operator's owner or admin). */
export const SettlementDisputeBodySchema = SettlementReasonBodySchema;
export type SettlementDisputeBody = SettlementReasonBody;

/** `GET /v1/settlement-statements` (O-05). */
export const OperatorSettlementsQuerySchema = z.strictObject({
  status: z.enum(SETTLEMENT_OPERATOR_VISIBLE_STATUSES).optional(),
  cursor,
  limit: limit(50, 24),
});
export type OperatorSettlementsQuery = z.infer<typeof OperatorSettlementsQuerySchema>;

/** `GET /v1/platform/invoices` (P-10): `from`/`to` are Riyadh days on `issued_at`. */
export const PlatformInvoicesQuerySchema = z.strictObject({
  kind: InvoiceKindSchema.optional(),
  series: InvoiceSeriesSchema.optional(),
  status: ZatcaStatusSchema.optional(),
  org_id: z.uuid().optional(),
  account_id: z.uuid().optional(),
  number: z
    .string()
    .regex(/^[A-Z]{2,4}-[0-9]{1,12}$/)
    .optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor,
  limit: limit(100, 50),
});
export type PlatformInvoicesQuery = z.infer<typeof PlatformInvoicesQuerySchema>;
