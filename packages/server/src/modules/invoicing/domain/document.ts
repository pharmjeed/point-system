import { createHash } from 'node:crypto';
import { INVOICE_TRANSACTION_SUBTYPE, type InvoiceKind, type InvoiceSeries } from '@point/shared';
import type { InvoiceLine, InvoiceSeller } from '@point/shared/customer';
import { canonicalJson } from '../../../core/idempotency/request-hash.js';

/**
 * The document the e-invoicing provider receives (V2-040, DEC-541 … DEC-543): every field ZATCA phase 2 needs from
 * POINT's side, in POINT's own canonical form. Building the UBL 2.1 XML, signing it with the unit's certificate
 * (ECDSA), the XML hash and the stamped QR tags 6–9 are the provider adapter's work (DEC-542), so they are not here.
 */
export interface EInvoiceDocument {
  id: string;
  /** KSA-1 / BT-1 invoice number: `PS-00000012`, gapless per series */
  number: string;
  /** KSA-1 UUID of the document */
  uuid: string;
  /** KSA-16 invoice counter value */
  icv: number;
  series: InvoiceSeries;
  kind: InvoiceKind;
  /** BT-3: 388 tax invoice, 381 credit note */
  typeCode: 388 | 381;
  /** KSA-2: 0100000 standard, 0200000 simplified */
  subtype: string;
  /** KSA-25 / BT-2 + KSA-25 time: ISO 8601 UTC, to the second */
  issuedAt: string;
  /** KSA-5 supply date (Riyadh) */
  supplyDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** KSA-13 previous invoice hash (PIH) */
  previousHash: string;
  /** the hash of this document in POINT's chain (DEC-541) */
  invoiceHash: string;
  currency: 'SAR';
  vatRateBp: number;
  subtotalHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  /** BT-25 / KSA-10: a credit note's original invoice and reason */
  original: { number: string; uuid: string; issuedAt: string } | null;
  creditReason: string | null;
  /** base64 TLV, tags 1–5 */
  qr: string;
}

/** The buyer: the operator for the standard series (legal name, VAT, CR), nothing for a simplified invoice. */
export interface InvoiceBuyer {
  kind: 'consumer' | 'operator';
  legal_name_ar?: string | null;
  legal_name_en?: string | null;
  vat_number?: string | null;
  cr_number?: string | null;
  /** a customer's invoice: the place of the service and its operator («تشغيل: …», V2-D01) */
  venue_name_ar?: string | null;
  venue_name_en?: string | null;
  operator_name_ar?: string | null;
}

export const subtypeOf = (series: InvoiceSeries) => INVOICE_TRANSACTION_SUBTYPE[series];

/** `PS-00000012` — the number of a counter in its series (the trigger of 0017 checks the same rule). */
export function invoiceNumber(prefix: string, icv: number): string {
  return `${prefix}-${String(icv).padStart(8, '0')}`;
}

/** An instant as ISO 8601 UTC to the second, the form printed, put in the QR and hashed. */
export function isoSecond(at: Date): string {
  return `${new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * The hash of a document in POINT's chain (DEC-541): base64 of the SHA-256 of its canonical content, which includes
 * its counter and the previous document's hash — so a document can be neither edited, removed nor inserted without
 * breaking every hash after it. The provider computes ZATCA's own XML hash (`provider_hash`).
 */
export function documentHash(d: Omit<EInvoiceDocument, 'id' | 'invoiceHash' | 'qr'>): string {
  const content = {
    number: d.number,
    uuid: d.uuid,
    icv: d.icv,
    series: d.series,
    kind: d.kind,
    type_code: d.typeCode,
    subtype: d.subtype,
    issued_at: d.issuedAt,
    supply_date: d.supplyDate,
    period_start: d.periodStart,
    period_end: d.periodEnd,
    previous_hash: d.previousHash,
    currency: d.currency,
    vat_rate_bp: d.vatRateBp,
    subtotal_halalas: d.subtotalHalalas,
    vat_halalas: d.vatHalalas,
    total_halalas: d.totalHalalas,
    seller: d.seller,
    buyer: d.buyer,
    lines: d.lines,
    original: d.original,
    credit_reason: d.creditReason,
  };
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('base64');
}

/** Halalas as the decimal text of the QR and the XML (`115.00`). */
export function sar(halalas: number): string {
  const sign = halalas < 0 ? '-' : '';
  const a = Math.abs(halalas);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
