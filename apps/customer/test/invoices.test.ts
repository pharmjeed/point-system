/**
 * V2-040 C-17: the invoice list and detail view models, and the fake backend issuing a simplified tax invoice for a
 * visit paid in the app (the server's rule, DEC-543): POINT as the seller, the VAT apart, the ZATCA QR.
 */
import {
  CustomerInvoiceDetailSchema,
  CustomerInvoiceListSchema,
  type CustomerInvoiceDetail,
} from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { fakeTokenize } from '../src/api/fake/tokens';
import { invoiceDetail, invoiceRow } from '../src/features/invoices';
import { payVisit } from '../src/features/pay/payFlow';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { setup, signIn } from './helpers';

const DEMO_PHONE = '+966500000099';
const DEMO_TICKET = '3c9d6e2a-7b1f-4c8d-9e0a-1b2c3d4e5f60';
const ISOLATE = /[\u{2066}-\u{2069}]/gu;

const detail: CustomerInvoiceDetail = {
  id: '0193b6f2-5c1e-7a40-9d2f-6b8e1c0a4f11',
  number: 'PS-00000012',
  kind: 'credit_note',
  issued_at: '2026-11-08T13:00:00.000Z',
  total_halalas: 1001,
  vat_halalas: 131,
  currency: 'SAR',
  status: 'reported',
  venue_name_ar: 'قاعة ريماس',
  venue_name_en: 'Rimas Hall',
  original_number: 'PS-00000007',
  type_code: 381,
  uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
  subtotal_halalas: 870,
  vat_rate_bp: 1500,
  seller: {
    legal_name_ar: 'شركة تجريبية',
    legal_name_en: 'Sample Co.',
    vat_number: '399999999900003',
    cr_number: '0000000000',
    address_ar: 'الرياض',
  },
  lines: [
    {
      description_ar: 'استرداد — خدمة صف السيارات',
      description_en: 'Refund — Valet parking',
      quantity: 1,
      unit_price_halalas: 870,
      net_halalas: 870,
      vat_rate_bp: 1500,
      vat_halalas: 131,
      total_halalas: 1001,
    },
  ],
  credit_reason: 'طلب العميل',
  online_payment_id: null,
  qr: 'AQE=',
  pdf_url: null,
  pdf_url_expires_at: null,
};

describe('C-17 view models', () => {
  it('a credit note row: its number, the place and Riyadh time, a negative amount and the ZATCA status', () => {
    const row = invoiceRow(detail, ar, 'ar');
    expect(row.title.replace(ISOLATE, '')).toBe('إشعار دائن PS-00000012');
    expect(row.subtitle).toBe('قاعة ريماس · 2026-11-08 16:00');
    expect(row.amount).toMatch(/^-10\.01 /);
    expect(row.status).toBe(ar.invoices.status.reported);
    expect(invoiceRow(detail, en, 'en').subtitle).toBe('Rimas Hall · 2026-11-08 16:00');
  });

  it('the detail: seller numbers, lines, totals with the VAT apart and its rate', () => {
    const v = invoiceDetail(detail, ar, 'ar');
    expect(v.heading).toBe(ar.invoices.creditNote);
    expect(v.original?.replace(ISOLATE, '')).toBe('PS-00000007');
    expect(v.reason).toBe('طلب العميل');
    expect(v.seller.vatNumber.replace(ISOLATE, '')).toBe('399999999900003');
    expect(v.subtotal).toMatch(/^8\.70 /);
    expect(v.vat).toMatch(/^1\.31 /);
    expect(v.total).toMatch(/^10\.01 /);
    expect(v.vatLabel.replace(ISOLATE, '')).toBe('ضريبة القيمة المضافة 15%');
    expect(v.pdfUrl).toBeNull();
  });
});

describe('C-17 on the fake backend', () => {
  it('a visit paid in the app gets its simplified invoice; another account does not see it', async () => {
    const ctx = setup({ demoVisitPhones: [DEMO_PHONE] });
    await signIn(ctx, DEMO_PHONE);
    expect(await ctx.api.invoices()).toEqual([]);
    const out = await payVisit(
      {
        api: ctx.api,
        openAuthSession: async () => ctx.clock.advance(1000),
        sleep: async (ms) => ctx.clock.advance(ms),
        now: ctx.clock.now,
      },
      {
        ticketId: DEMO_TICKET,
        source: {
          type: 'token',
          token: fakeTokenize({
            number: '4111111111111111',
            month: 12,
            year: 2030,
            cvc: '123',
            name: 'SARA',
          }),
        },
        idempotencyKey: 'k-1',
      },
    );
    expect(out.kind).toBe('paid');
    const list = await ctx.api.invoices();
    expect(CustomerInvoiceListSchema.parse({ items: list }).items).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: 'PS-00000001',
      kind: 'customer_simplified',
      total_halalas: 2000,
    });
    const doc = CustomerInvoiceDetailSchema.parse(await ctx.api.invoice(list[0]!.id));
    expect(doc).toMatchObject({ type_code: 388, vat_halalas: 261, subtotal_halalas: 1739 });
    expect(doc.lines[0]!.net_halalas + doc.lines[0]!.vat_halalas).toBe(doc.total_halalas);

    const other = setup();
    await signIn(other, '+966512340000');
    expect(await other.api.invoices()).toEqual([]);
    await expect(ctx.api.invoice('0193b6f2-5c1e-7a40-9d2f-000000000000')).rejects.toBeInstanceOf(ApiError);
  });
});
