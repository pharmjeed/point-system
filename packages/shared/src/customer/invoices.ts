/**
 * C-17 «الفواتير» (V2-040; docs/v2/01, docs/v2/04 §4; DEC-542, DEC-548): the customer's simplified tax invoices —
 * one for every online payment that was paid — and the credit notes of their refunds. Issued by POINT (the seller,
 * V2-D03, V2-D13), immutable, with the ZATCA QR (base64 TLV) and a PDF behind a short-lived private link.
 */
import { z } from 'zod';
import { ZatcaStatusSchema } from '../canon/invoicing.js';

const iso = z.iso.datetime({ offset: true });

/** One line of an invoice: amounts in halalas, VAT apart (per line, half-up — DEC-545). */
export const InvoiceLineSchema = z.object({
  description_ar: z.string(),
  description_en: z.string(),
  quantity: z.number().int().min(1),
  unit_price_halalas: z.number().int(),
  net_halalas: z.number().int(),
  vat_rate_bp: z.number().int(),
  vat_halalas: z.number().int(),
  total_halalas: z.number().int(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

/** The seller block printed on every invoice: POINT's legal data from the configuration (placeholders until set). */
export const InvoiceSellerSchema = z.object({
  legal_name_ar: z.string(),
  legal_name_en: z.string(),
  vat_number: z.string(),
  cr_number: z.string(),
  address_ar: z.string(),
});
export type InvoiceSeller = z.infer<typeof InvoiceSellerSchema>;

export const CUSTOMER_INVOICE_KINDS = ['customer_simplified', 'credit_note'] as const;

export const CustomerInvoiceSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  kind: z.enum(CUSTOMER_INVOICE_KINDS),
  issued_at: iso,
  total_halalas: z.number().int(),
  vat_halalas: z.number().int(),
  currency: z.literal('SAR'),
  /** what ZATCA (through the provider) said: pending until reported */
  status: ZatcaStatusSchema,
  venue_name_ar: z.string().nullable(),
  venue_name_en: z.string().nullable(),
  /** a credit note's original invoice number */
  original_number: z.string().nullable(),
});
export type CustomerInvoiceSummary = z.infer<typeof CustomerInvoiceSummarySchema>;

/** `GET /v1/customer/invoices`: the newest 100 documents of the account, newest first. */
export const CustomerInvoiceListSchema = z.object({ items: z.array(CustomerInvoiceSummarySchema) });
export type CustomerInvoiceList = z.infer<typeof CustomerInvoiceListSchema>;

/** `GET /v1/customer/invoices/{invoiceId}`: the document, its QR and its PDF link once rendered. */
export const CustomerInvoiceDetailSchema = CustomerInvoiceSummarySchema.extend({
  type_code: z.union([z.literal(388), z.literal(381)]),
  uuid: z.uuid(),
  subtotal_halalas: z.number().int(),
  vat_rate_bp: z.number().int(),
  seller: InvoiceSellerSchema,
  lines: z.array(InvoiceLineSchema),
  credit_reason: z.string().nullable(),
  online_payment_id: z.uuid().nullable(),
  /** base64 TLV of the ZATCA QR (the provider's stamped one once it answered) */
  qr: z.string(),
  /** a private link of a few minutes to the PDF, null while it is being rendered */
  pdf_url: z.string().nullable(),
  pdf_url_expires_at: iso.nullable(),
});
export type CustomerInvoiceDetail = z.infer<typeof CustomerInvoiceDetailSchema>;
