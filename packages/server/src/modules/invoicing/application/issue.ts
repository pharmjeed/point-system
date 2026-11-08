import { randomUUID } from 'node:crypto';
import {
  INVOICE_TYPE_CODES,
  vatOfInclusive,
  type InvoiceKind,
  type InvoiceSeries,
  type ZatcaStatus,
} from '@point/shared';
import type { InvoiceLine, InvoiceSeller } from '@point/shared/customer';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { platformAudit, type PlatformAuditEntry } from '../../../core/audit/platform-audit.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import {
  platformOrgId,
  type OnlinePaymentRow,
  type PaymentDocumentsHook,
  type SucceededRefund,
} from '../../payments-online/index.js';
import {
  documentHash,
  invoiceNumber,
  isoSecond,
  sar,
  subtypeOf,
  type EInvoiceDocument,
  type InvoiceBuyer,
} from '../domain/document.js';
import { EINVOICE_SUBMIT_JOB } from '../domain/jobs.js';
import { zatcaQr } from '../domain/qr.js';
import { currentInvoicingRuntime } from '../runtime.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;
const RIYADH_MS = 3 * 3_600_000;
export const riyadhDay = (at: Date) => new Date(at.getTime() + RIYADH_MS).toISOString().slice(0, 10);

export interface InvoiceRow {
  id: string;
  series: InvoiceSeries;
  kind: InvoiceKind;
  type_code: 388 | 381;
  number: string;
  icv: number;
  zatca_uuid: string;
  previous_hash: string;
  invoice_hash: string;
  issued_at: Date;
  supply_date: string;
  period_start: string | null;
  period_end: string | null;
  account_id: string | null;
  org_id: string | null;
  online_payment_id: string | null;
  refund_id: string | null;
  settlement_statement_id: string | null;
  original_invoice_id: string | null;
  credit_reason: string | null;
  currency: 'SAR';
  vat_rate_bp: number;
  subtotal_halalas: number;
  vat_halalas: number;
  total_halalas: number;
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  qr_payload: string;
  provider: string;
  zatca_status: ZatcaStatus;
  provider_reference: string | null;
  provider_hash: string | null;
  provider_qr: string | null;
  provider_codes: { code: string; category: string; field?: string }[];
  submitted_at: Date | null;
  status_at: Date | null;
  pdf_storage_key: string | null;
  pdf_rendered_at: Date | null;
  created_at: Date;
  original_number: string | null;
  original_uuid: string | null;
  original_issued_at: Date | null;
}

/** Every column of an invoice (amounts as numbers) with its original's reference for a credit note. */
export const INVOICE_SELECT = `
  SELECT i.id, i.series, i.kind, i.type_code, i.number, i.icv::float8 AS icv, i.zatca_uuid, i.previous_hash,
         i.invoice_hash, i.issued_at, i.supply_date::text AS supply_date, i.period_start::text AS period_start,
         i.period_end::text AS period_end, i.account_id, i.org_id, i.online_payment_id, i.refund_id,
         i.settlement_statement_id, i.original_invoice_id, i.credit_reason, i.currency, i.vat_rate_bp,
         i.subtotal_halalas::float8 AS subtotal_halalas, i.vat_halalas::float8 AS vat_halalas,
         i.total_halalas::float8 AS total_halalas, i.seller, i.buyer, i.lines, i.qr_payload, i.provider,
         i.zatca_status, i.provider_reference, i.provider_hash, i.provider_qr, i.provider_codes, i.submitted_at,
         i.status_at, i.pdf_storage_key, i.pdf_rendered_at, i.created_at,
         o.number AS original_number, o.zatca_uuid AS original_uuid, o.issued_at AS original_issued_at
    FROM invoices i LEFT JOIN invoices o ON o.id = i.original_invoice_id`;

export async function invoiceById(q: Q, id: string): Promise<InvoiceRow | null> {
  const r = await q.query<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** The provider's view of a stored invoice (the same fields it was hashed from). */
export function toDocument(r: InvoiceRow): EInvoiceDocument {
  return {
    id: r.id,
    number: r.number,
    uuid: r.zatca_uuid,
    icv: r.icv,
    series: r.series,
    kind: r.kind,
    typeCode: r.type_code,
    subtype: subtypeOf(r.series),
    issuedAt: isoSecond(new Date(r.issued_at)),
    supplyDate: r.supply_date,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    previousHash: r.previous_hash,
    invoiceHash: r.invoice_hash,
    currency: 'SAR',
    vatRateBp: r.vat_rate_bp,
    subtotalHalalas: r.subtotal_halalas,
    vatHalalas: r.vat_halalas,
    totalHalalas: r.total_halalas,
    seller: r.seller,
    buyer: r.buyer,
    lines: r.lines,
    original:
      r.original_number && r.original_uuid && r.original_issued_at
        ? {
            number: r.original_number,
            uuid: r.original_uuid,
            issuedAt: isoSecond(new Date(r.original_issued_at)),
          }
        : null,
    creditReason: r.credit_reason,
    qr: r.qr_payload,
  };
}

export interface IssueInput {
  series: InvoiceSeries;
  kind: InvoiceKind;
  accountId?: string | null;
  orgId?: string | null;
  onlinePaymentId?: string | null;
  refundId?: string | null;
  statementId?: string | null;
  original?: InvoiceRow | null;
  creditReason?: string | null;
  supplyDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  vatRateBp: number;
  /** who issues it (the system for the payments' documents, the platform user for a statement) */
  actor?: PlatformAuditEntry['actor'];
  requestId?: string | null;
}

/**
 * Issues one tax document in the caller's transaction (V2-040 / V2-042; DEC-541): takes the series row last
 * (`FOR NO KEY UPDATE`, after every row of the caller's command), the next counter and the previous hash, writes
 * the immutable invoice — the database trigger re-checks the chain and advances the series — and queues its
 * submission to the provider after COMMIT (`job.einvoice_submit`, ordered per series so the chain reaches the
 * provider in order). Audited in platform_audit_log (and the operator's audit_log for its own invoice) and in the
 * customer's customer_audit_log for theirs.
 */
export async function issueDocument(tx: Tx, input: IssueInput): Promise<InvoiceRow> {
  const rt = currentInvoicingRuntime();
  const s = await tx.one<{ prefix: string; last_icv: number; last_hash: string }>(
    `SELECT prefix, last_icv::float8 AS last_icv, last_hash FROM invoice_series WHERE series = $1 FOR NO KEY UPDATE`,
    [input.series],
  );
  const icv = s.last_icv + 1;
  const number = invoiceNumber(s.prefix, icv);
  const uuid = randomUUID();
  const issuedAt = isoSecond(tx.now);
  const lines = input.lines;
  const subtotal = lines.reduce((a, l) => a + l.net_halalas, 0);
  const vat = lines.reduce((a, l) => a + l.vat_halalas, 0);
  const total = subtotal + vat;
  const seller = rt.seller();
  const typeCode = input.kind === 'credit_note' ? INVOICE_TYPE_CODES.credit_note : INVOICE_TYPE_CODES.invoice;
  const original = input.original
    ? {
        number: input.original.number,
        uuid: input.original.zatca_uuid,
        issuedAt: isoSecond(new Date(input.original.issued_at)),
      }
    : null;
  const doc = {
    number,
    uuid,
    icv,
    series: input.series,
    kind: input.kind,
    typeCode,
    subtype: subtypeOf(input.series),
    issuedAt,
    supplyDate: input.supplyDate,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    previousHash: s.last_hash,
    currency: 'SAR' as const,
    vatRateBp: input.vatRateBp,
    subtotalHalalas: subtotal,
    vatHalalas: vat,
    totalHalalas: total,
    seller,
    buyer: input.buyer,
    lines,
    original,
    creditReason: input.creditReason ?? null,
  };
  const hash = documentHash(doc);
  const qr = zatcaQr({
    sellerName: seller.legal_name_ar,
    vatNumber: seller.vat_number,
    timestamp: issuedAt,
    totalWithVat: sar(total),
    vatTotal: sar(vat),
  });
  const id = newId();
  await tx.query(
    `INSERT INTO invoices (id, series, kind, type_code, number, icv, zatca_uuid, previous_hash, invoice_hash, issued_at,
                           supply_date, period_start, period_end, account_id, org_id, online_payment_id, refund_id,
                           settlement_statement_id, original_invoice_id, credit_reason, vat_rate_bp, subtotal_halalas,
                           vat_halalas, total_halalas, seller, buyer, lines, qr_payload, provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
             $24, $25, $26, $27, $28, $29, $30)`,
    [
      id,
      input.series,
      input.kind,
      typeCode,
      number,
      icv,
      uuid,
      s.last_hash,
      hash,
      issuedAt,
      input.supplyDate,
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.accountId ?? null,
      input.orgId ?? null,
      input.onlinePaymentId ?? null,
      input.refundId ?? null,
      input.statementId ?? null,
      input.original?.id ?? null,
      input.creditReason ?? null,
      input.vatRateBp,
      subtotal,
      vat,
      total,
      JSON.stringify(seller),
      JSON.stringify(input.buyer),
      JSON.stringify(lines),
      qr,
      rt.provider.name,
      tx.now,
    ],
  );
  const queueOrg = await platformOrgId(tx);
  if (!queueOrg) throw new AppError('SERVICE_UNAVAILABLE');
  await enqueue(tx, {
    type: EINVOICE_SUBMIT_JOB,
    orgId: queueOrg,
    aggregate: { type: 'invoice', id },
    orderingKey: `einvoice:${input.series}`,
    payload: { invoice_id: id },
  });
  const metadata = {
    number,
    kind: input.kind,
    series: input.series,
    icv,
    total_halalas: total,
    vat_halalas: vat,
    online_payment_id: input.onlinePaymentId ?? null,
    refund_id: input.refundId ?? null,
    settlement_statement_id: input.statementId ?? null,
    original_invoice_id: input.original?.id ?? null,
  };
  await platformAudit(tx, {
    actor: input.actor ?? { type: 'system', id: null, name: 'invoicing' },
    action: input.kind === 'credit_note' ? 'invoice.credit_note' : 'invoice.issue',
    entityType: 'invoice',
    entityId: id,
    orgId: input.series === 'standard' ? (input.orgId ?? null) : null,
    requestId: input.requestId ?? null,
    reason: input.creditReason ?? null,
    metadata,
  });
  if (input.accountId)
    await customerAudit(tx, {
      actor: { type: 'system', name: 'invoicing' },
      action: input.kind === 'credit_note' ? 'invoice.credit_note' : 'invoice.issue',
      entityType: 'invoice',
      entityId: id,
      accountId: input.accountId,
      metadata,
    });
  return (await invoiceById(tx, id))!;
}

/** Venue and operator names of a visit payment (printed on the customer's invoice line). */
async function visitPlace(tx: Tx, p: OnlinePaymentRow) {
  if (!p.venue_id) return null;
  return tx.maybeOne<{ venue_ar: string; venue_en: string | null; org_ar: string; org_en: string | null }>(
    `SELECT v.name_ar AS venue_ar, v.name_en AS venue_en, o.name_ar AS org_ar, o.name_en AS org_en
       FROM venues v JOIN organizations o ON o.id = v.org_id
      WHERE v.id = $1 AND v.org_id = $2`,
    [p.venue_id, p.org_id],
  );
}

/** A line of a VAT-inclusive amount: the VAT inside it (half-up, `vatOfInclusive`) and the net. */
export function inclusiveLine(
  totalHalalas: number,
  rateBp: number,
  description: { ar: string; en: string },
  vatHalalas = vatOfInclusive(totalHalalas, rateBp),
): InvoiceLine {
  return {
    description_ar: description.ar,
    description_en: description.en,
    quantity: 1,
    unit_price_halalas: totalHalalas - vatHalalas,
    net_halalas: totalHalalas - vatHalalas,
    vat_rate_bp: rateBp,
    vat_halalas: vatHalalas,
    total_halalas: totalHalalas,
  };
}

/** The simplified invoice of a payment: one per payment (`uq_invoices_payment`), returned when it exists. */
export async function ensureCustomerInvoice(tx: Tx, p: OnlinePaymentRow): Promise<InvoiceRow> {
  const existing = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM invoices WHERE online_payment_id = $1 AND kind = 'customer_simplified'`,
    [p.id],
  );
  if (existing) return (await invoiceById(tx, existing.id))!;
  const rt = currentInvoicingRuntime();
  const place = await visitPlace(tx, p);
  const description =
    p.purpose === 'visit'
      ? {
          ar: `خدمة صف السيارات — ${place?.venue_ar ?? ''}`.trim(),
          en: `Valet parking — ${place?.venue_en ?? place?.venue_ar ?? ''}`.trim(),
        }
      : { ar: 'اشتراك خدمة صف السيارات', en: 'Valet parking subscription' };
  // the payment's own VAT (computed when it was created) is the VAT the customer paid
  const line = inclusiveLine(p.amount_halalas, rt.env.VAT_RATE_BP, description, p.vat_halalas);
  return issueDocument(tx, {
    series: 'simplified',
    kind: 'customer_simplified',
    accountId: p.account_id,
    onlinePaymentId: p.id,
    supplyDate: riyadhDay(p.paid_at ? new Date(p.paid_at) : tx.now),
    buyer: {
      kind: 'consumer',
      venue_name_ar: place?.venue_ar ?? null,
      venue_name_en: place?.venue_en ?? null,
      operator_name_ar: place?.org_ar ?? null,
    },
    lines: [line],
    vatRateBp: rt.env.VAT_RATE_BP,
  });
}

/**
 * The credit note of a refund (one per refund, `uq_invoices_refund`): the refunded amount, VAT inside it. The note
 * that completes a full refund takes the rest of the invoice's VAT, so the notes of a payment always add up to its
 * invoice exactly (DEC-545).
 */
export async function issueRefundCreditNote(
  tx: Tx,
  refund: SucceededRefund,
  p: OnlinePaymentRow,
): Promise<InvoiceRow> {
  const existing = await tx.maybeOne<{ id: string }>(`SELECT id FROM invoices WHERE refund_id = $1`, [
    refund.id,
  ]);
  if (existing) return (await invoiceById(tx, existing.id))!;
  const invoice = await ensureCustomerInvoice(tx, p);
  const prior = await tx.one<{ total: number; vat: number }>(
    `SELECT COALESCE(sum(total_halalas), 0)::float8 AS total, COALESCE(sum(vat_halalas), 0)::float8 AS vat
       FROM invoices WHERE original_invoice_id = $1 AND kind = 'credit_note'`,
    [invoice.id],
  );
  const left = invoice.total_halalas - prior.total;
  const amount = Math.min(refund.amount_halalas, left);
  if (amount <= 0) return invoice; // nothing left to credit (a refund outside the invoice): finance follows the alert
  const vat =
    amount === left
      ? invoice.vat_halalas - prior.vat
      : Math.min(vatOfInclusive(amount, invoice.vat_rate_bp), invoice.vat_halalas - prior.vat);
  const line = inclusiveLine(
    amount,
    invoice.vat_rate_bp,
    {
      ar: `استرداد — ${invoice.lines[0]?.description_ar ?? ''}`.trim(),
      en: `Refund — ${invoice.lines[0]?.description_en ?? ''}`.trim(),
    },
    vat,
  );
  return issueDocument(tx, {
    series: 'simplified',
    kind: 'credit_note',
    accountId: p.account_id,
    onlinePaymentId: p.id,
    refundId: refund.id,
    original: invoice,
    creditReason: refund.kind === 'system' ? `استرداد تلقائي (${refund.reason})` : refund.reason,
    supplyDate: invoice.supply_date,
    buyer: invoice.buyer,
    lines: [line],
    vatRateBp: invoice.vat_rate_bp,
  });
}

/**
 * The full credit note of an operator's invoice (V2-042, DEC-546): a voided statement takes back its SaaS invoice,
 * line for line. One per invoice (`uq_invoices_full_credit`).
 */
export async function issueFullCreditNote(
  tx: Tx,
  invoice: InvoiceRow,
  reason: string,
  actor: PlatformAuditEntry['actor'],
  requestId: string | null,
): Promise<InvoiceRow> {
  return issueDocument(tx, {
    series: invoice.series,
    kind: 'credit_note',
    accountId: invoice.account_id,
    orgId: invoice.org_id,
    statementId: invoice.settlement_statement_id,
    original: invoice,
    creditReason: reason,
    supplyDate: invoice.supply_date,
    periodStart: invoice.period_start,
    periodEnd: invoice.period_end,
    buyer: invoice.buyer,
    lines: invoice.lines,
    vatRateBp: invoice.vat_rate_bp,
    actor,
    requestId,
  });
}

/** The hook the payments module calls (registered in index.ts at load, api and worker). */
export const paymentDocuments: PaymentDocumentsHook = {
  async afterCaptured(tx, payment) {
    await ensureCustomerInvoice(tx, payment);
  },
  async afterRefund(tx, refund, payment) {
    await issueRefundCreditNote(tx, refund, payment);
  },
};
