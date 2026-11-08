/**
 * C-17 «الفواتير» view models (V2-040; docs/v2/04 §4, DEC-548). Pure: the screens render what these return. Every
 * figure comes from `GET /v1/customer/invoices[/{invoiceId}]`: POINT is the seller of the visits paid in the app,
 * the VAT is shown apart, a refund appears as a credit note against its invoice; nothing is computed here.
 */
import type { CustomerInvoiceDetail, CustomerInvoiceSummary } from '@point/shared/customer';
import { isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatDate, formatMoney, formatTime } from '../i18n/format';

const localName = (ar: string | null, en: string | null, locale: AppLocale) =>
  locale === 'en' && en ? en : (ar ?? en ?? '');

export interface InvoiceRow {
  id: string;
  title: string;
  subtitle: string;
  amount: string;
  status: string;
  credit: boolean;
}

export function statusLabel(s: CustomerInvoiceSummary['status'], t: Dictionary): string {
  return t.invoices.status[s];
}

/** A row of the list: the kind and number, the place and time, the amount (a credit note's is negative). */
export function invoiceRow(i: CustomerInvoiceSummary, t: Dictionary, locale: AppLocale): InvoiceRow {
  const credit = i.kind === 'credit_note';
  const place = localName(i.venue_name_ar, i.venue_name_en, locale);
  return {
    id: i.id,
    title: `${credit ? t.invoices.creditNote : t.invoices.simplified} ${isolate(i.number)}`,
    subtitle: [place, `${formatDate(i.issued_at)} ${formatTime(i.issued_at)}`].filter(Boolean).join(' · '),
    amount: formatMoney(credit ? -i.total_halalas : i.total_halalas, t),
    status: statusLabel(i.status, t),
    credit,
  };
}

export interface InvoiceDetailView {
  heading: string;
  number: string;
  issued: string;
  status: string;
  original: string | null;
  reason: string | null;
  seller: { name: string; vatNumber: string; crNumber: string; address: string };
  lines: { description: string; net: string; vat: string; total: string }[];
  subtotal: string;
  vat: string;
  vatLabel: string;
  total: string;
  qr: string;
  pdfUrl: string | null;
}

export function invoiceDetail(d: CustomerInvoiceDetail, t: Dictionary, locale: AppLocale): InvoiceDetailView {
  const credit = d.kind === 'credit_note';
  return {
    heading: credit ? t.invoices.creditNote : t.invoices.simplified,
    number: isolate(d.number),
    issued: `${formatDate(d.issued_at)} ${formatTime(d.issued_at)}`,
    status: statusLabel(d.status, t),
    original: d.original_number ? isolate(d.original_number) : null,
    reason: d.credit_reason,
    seller: {
      name: localName(d.seller.legal_name_ar, d.seller.legal_name_en, locale),
      vatNumber: isolate(d.seller.vat_number),
      crNumber: isolate(d.seller.cr_number),
      address: d.seller.address_ar,
    },
    lines: d.lines.map((l) => ({
      description: locale === 'en' ? l.description_en : l.description_ar,
      net: formatMoney(l.net_halalas, t),
      vat: formatMoney(l.vat_halalas, t),
      total: formatMoney(l.total_halalas, t),
    })),
    subtotal: formatMoney(d.subtotal_halalas, t),
    vat: formatMoney(d.vat_halalas, t),
    vatLabel: t.invoices.vatRate.replace('{rate}', isolate(`${d.vat_rate_bp / 100}%`)),
    total: formatMoney(d.total_halalas, t),
    qr: d.qr,
    pdfUrl: d.pdf_url,
  };
}
