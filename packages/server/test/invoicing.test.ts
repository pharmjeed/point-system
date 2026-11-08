import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { FIRST_PREVIOUS_INVOICE_HASH, roundHalfUpDiv, shareOfBp, vatOfInclusive } from '@point/shared';
import { describe, expect, it } from 'vitest';
import {
  bidiRuns,
  computeLines,
  decodeTlv,
  documentHash,
  encodeTlv,
  inclusiveLine,
  invoiceNumber,
  isoSecond,
  monthBounds,
  previousMonth,
  renderInvoicePdf,
  saasShares,
  sar,
  SimulatorEInvoicingProvider,
  totalsOf,
  UnconfiguredLiveProvider,
  zatcaQr,
  type ContractTerms,
  type EInvoiceDocument,
} from '../src/index.js';

/**
 * V2-040 / V2-041 (DEC-541 … DEC-545): the pure parts of invoicing and settlement — the ZATCA QR (TLV), the chain's
 * first hash and document hash, the simulator's validations, the half-up rounding per line, the settlement formula
 * and the bidirectional layout of the PDF.
 */

const seller = {
  legal_name_ar: 'شركة تجريبية للخدمات',
  legal_name_en: 'Sample Services Co.',
  vat_number: '399999999900003',
  cr_number: '0000000000',
  address_ar: 'الرياض، عنوان تجريبي',
};

function sampleDoc(over: Partial<EInvoiceDocument> = {}): EInvoiceDocument {
  const line = inclusiveLine(2300, 1500, {
    ar: 'خدمة صف السيارات — قاعة ريماس',
    en: 'Valet parking — Rimas',
  });
  const base = {
    id: '00000000-0000-0000-0000-000000000001',
    number: invoiceNumber('PS', 12),
    uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
    icv: 12,
    series: 'simplified' as const,
    kind: 'customer_simplified' as const,
    typeCode: 388 as const,
    subtype: '0200000',
    issuedAt: '2026-11-08T13:00:00Z',
    supplyDate: '2026-11-08',
    periodStart: null,
    periodEnd: null,
    previousHash: FIRST_PREVIOUS_INVOICE_HASH,
    currency: 'SAR' as const,
    vatRateBp: 1500,
    subtotalHalalas: line.net_halalas,
    vatHalalas: line.vat_halalas,
    totalHalalas: line.total_halalas,
    seller,
    buyer: { kind: 'consumer' as const, venue_name_ar: 'قاعة ريماس', operator_name_ar: 'مشغل تجريبي' },
    lines: [line],
    original: null,
    creditReason: null,
    ...over,
  };
  const qr = zatcaQr({
    sellerName: base.seller.legal_name_ar,
    vatNumber: base.seller.vat_number,
    timestamp: base.issuedAt,
    totalWithVat: sar(base.totalHalalas),
    vatTotal: sar(base.vatHalalas),
  });
  return { ...base, invoiceHash: documentHash(base), qr, ...over };
}

describe('ZATCA QR (tags 1–5, base64 TLV)', () => {
  it('encodes tag, UTF-8 byte length and value, and decodes back', () => {
    const qr = zatcaQr({
      sellerName: 'شركة',
      vatNumber: '399999999900003',
      timestamp: '2026-11-08T13:00:00Z',
      totalWithVat: '23.00',
      vatTotal: '3.00',
    });
    const raw = Buffer.from(qr, 'base64');
    expect(raw[0]).toBe(1);
    expect(raw[1]).toBe(Buffer.byteLength('شركة', 'utf8')); // 8 bytes: Arabic is two bytes per letter
    expect([...decodeTlv(qr).entries()]).toEqual([
      [1, 'شركة'],
      [2, '399999999900003'],
      [3, '2026-11-08T13:00:00Z'],
      [4, '23.00'],
      [5, '3.00'],
    ]);
  });

  it('refuses a value longer than one length byte', () => {
    expect(() => encodeTlv([[1, 'x'.repeat(256)]])).toThrow(RangeError);
  });
});

describe('the invoice chain', () => {
  it('starts from the ZATCA base PIH: base64 of the hex SHA-256 of "0"', () => {
    const hex = createHash('sha256').update('0').digest('hex');
    expect(Buffer.from(hex, 'utf8').toString('base64')).toBe(FIRST_PREVIOUS_INVOICE_HASH);
  });

  it('numbers are gapless counters of a series, the time is ISO 8601 to the second', () => {
    expect(invoiceNumber('PS', 1)).toBe('PS-00000001');
    expect(invoiceNumber('PB', 123456789)).toBe('PB-123456789');
    expect(isoSecond(new Date('2026-11-08T13:00:00.987Z'))).toBe('2026-11-08T13:00:00Z');
  });

  it('the hash covers the content, the counter and the previous hash', () => {
    const d = sampleDoc();
    expect(documentHash(d)).toBe(d.invoiceHash);
    expect(documentHash({ ...d, icv: 13 })).not.toBe(d.invoiceHash);
    expect(documentHash({ ...d, previousHash: 'x'.repeat(44) })).not.toBe(d.invoiceHash);
    expect(documentHash({ ...d, totalHalalas: d.totalHalalas + 1 })).not.toBe(d.invoiceHash);
  });
});

describe('VAT and rounding (DEC-545: per line, half-up)', () => {
  it('half-up division and basis-point shares', () => {
    expect(roundHalfUpDiv(5, 2)).toBe(3);
    expect(roundHalfUpDiv(4, 2)).toBe(2);
    expect(shareOfBp(1001, 1500)).toBe(150); // 150.15
    expect(shareOfBp(1003, 1500)).toBe(150); // 150.45
    expect(shareOfBp(1010, 1500)).toBe(152); // 151.5 → 152
    expect(shareOfBp(2300, 1000)).toBe(230);
  });

  it('a VAT-inclusive line splits into net + VAT exactly', () => {
    for (const total of [100, 101, 115, 2300, 2345, 99999]) {
      const l = inclusiveLine(total, 1500, { ar: 'x', en: 'x' });
      expect(l.net_halalas + l.vat_halalas).toBe(total);
      expect(l.vat_halalas).toBe(vatOfInclusive(total));
      expect(Math.abs(l.vat_halalas * 10_000 - l.net_halalas * 1500)).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('the e-invoicing simulator (DEC-540, DEC-542)', () => {
  const now = () => new Date('2026-11-08T13:05:00Z');

  it('reports a valid simplified invoice and clears nothing on the wrong channel', async () => {
    const sim = new SimulatorEInvoicingProvider({ now });
    const ok = await sim.report(sampleDoc());
    expect(ok).toMatchObject({ ok: true, status: 'reported', reference: expect.stringMatching(/^sim-/) });
    const wrong = await sim.clear(sampleDoc());
    expect(wrong).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('rejects what ZATCA would reject on POINT’s side', async () => {
    const sim = new SimulatorEInvoicingProvider({ now });
    const codes = async (d: EInvoiceDocument) => {
      const r = await sim.report(d);
      return r.ok ? [] : r.kind === 'rejected' ? r.codes.map((c) => c.code) : [r.kind];
    };
    expect(await codes(sampleDoc({ seller: { ...seller, vat_number: '123' } }))).toContain(
      'seller_vat_invalid',
    );
    expect(await codes({ ...sampleDoc(), invoiceHash: sampleDoc({ icv: 99 }).invoiceHash })).toContain(
      'hash_mismatch',
    );
    expect(await codes(sampleDoc({ subtype: '0100000' }))).toContain('subtype_mismatch');
    expect(await codes(sampleDoc({ kind: 'credit_note', typeCode: 381 }))).toEqual(
      expect.arrayContaining(['billing_reference_missing', 'credit_reason_missing']),
    );
    expect(
      await codes({
        ...sampleDoc(),
        qr: zatcaQr({ sellerName: 'x', vatNumber: 'y', timestamp: 'z', totalWithVat: '1', vatTotal: '0' }),
      }),
    ).toContain('qr_mismatch');
    const d = sampleDoc();
    expect(
      await codes({ ...d, lines: [{ ...d.lines[0]!, vat_halalas: d.lines[0]!.vat_halalas + 5 }] }),
    ).toEqual(expect.arrayContaining(['line_total_mismatch', 'line_vat_mismatch']));
    expect(await codes(sampleDoc({ issuedAt: '2026-11-09T13:00:00Z' }))).toContain('issue_time_invalid');
  });

  it('warns on a simplified document reported more than 24 hours after its issue', async () => {
    const sim = new SimulatorEInvoicingProvider({ now: () => new Date('2026-11-10T13:00:00Z') });
    const r = await sim.report(sampleDoc());
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['reported_after_24h']);
  });

  it('verifies a signed callback and refuses a wrong signature', async () => {
    const sim = new SimulatorEInvoicingProvider({ now, callbackSecrets: async () => ['cb-secret'] });
    const body = Buffer.from(
      JSON.stringify({
        invoice_uuid: sampleDoc().uuid,
        status: 'rejected',
        codes: [{ code: 'X1', category: 'error' }],
      }),
    );
    expect(await sim.verifyCallback(body, SimulatorEInvoicingProvider.sign(body, 'cb-secret'))).toEqual({
      invoiceUuid: sampleDoc().uuid,
      status: 'rejected',
      reference: null,
      codes: [{ code: 'X1', category: 'error' }],
    });
    expect(await sim.verifyCallback(body, SimulatorEInvoicingProvider.sign(body, 'other'))).toBeNull();
    expect(await sim.verifyCallback(body, undefined)).toBeNull();
  });

  it('live without an adapter refuses without any network call', async () => {
    const live = new UnconfiguredLiveProvider();
    expect(await live.report()).toMatchObject({ ok: false, kind: 'refused' });
    expect(await live.verifyCallback()).toBeNull();
  });
});

describe('the settlement formula (DEC-545)', () => {
  const contract = (o: Partial<ContractTerms>): ContractTerms => ({
    id: 'c1',
    starts_on: '2026-01-01',
    ends_on: null,
    saas_fee_halalas_per_venue: 50_000,
    saas_cycle: 'monthly',
    subscriber_visit_payout_halalas: 700,
    app_payment_commission_bp: 1000,
    ...o,
  });

  it('months and their previous month', () => {
    expect(monthBounds('2026-10')).toEqual({
      period: '2026-10',
      start: '2026-10-01',
      end: '2026-11-01',
      days: 31,
    });
    expect(monthBounds('2026-12').end).toBe('2027-01-01');
    expect(monthBounds('2028-02').days).toBe(29);
    expect(previousMonth('2026-01-01')).toBe('2025-12');
  });

  it('a venue’s SaaS share follows the contract in force each day, yearly fees in twelfths', () => {
    const m = monthBounds('2026-10');
    const a = contract({ id: 'a', ends_on: '2026-10-11' });
    const b = contract({
      id: 'b',
      starts_on: '2026-10-11',
      saas_fee_halalas_per_venue: 1_200_000,
      saas_cycle: 'yearly',
    });
    const shares = saasShares([a, b], { venue_id: 'v', from_day: '2026-01-01' }, m);
    expect(shares.map((s) => [s.contract.id, s.days, s.net])).toEqual([
      ['a', 10, roundHalfUpDiv(50_000 * 10, 31)],
      ['b', 21, roundHalfUpDiv(1_200_000 * 21, 31 * 12)],
    ]);
    // a venue created mid-month pays from its first day only
    expect(saasShares([a], { venue_id: 'v', from_day: '2026-10-05' }, m)[0]!.days).toBe(6);
  });

  it('lines add up to the statement: payout, gross − commission − refunds + commission back, − SaaS and VAT', () => {
    const m = monthBounds('2026-10');
    const lines = computeLines(
      {
        visits: [
          { ticket_id: 't1', venue_id: 'v', day: '2026-10-03' },
          { ticket_id: 't2', venue_id: 'v', day: '2026-10-04' },
        ],
        payments: [{ payment_id: 'p1', venue_id: 'v', day: '2026-10-05', amount_halalas: 2345 }],
        refunds: [
          {
            refund_id: 'r1',
            payment_id: 'p1',
            venue_id: 'v',
            day: '2026-10-06',
            paid_day: '2026-10-05',
            amount_halalas: 1001,
          },
        ],
        venues: [{ venue_id: 'v', from_day: '2026-01-01' }],
      },
      [contract({})],
      m,
      1500,
    );
    const t = totalsOf(lines);
    expect(t).toEqual({
      subscriber_visit_count: 2,
      subscriber_payout_halalas: 1400,
      app_payment_count: 1,
      app_gross_halalas: 2345,
      app_commission_halalas: 235, // 234.5 → 235
      app_refund_halalas: 1001,
      app_refund_commission_halalas: 100, // 100.1 → 100
      saas_fee_halalas: 50_000,
      saas_vat_halalas: 7_500,
      adjustments_halalas: 0,
      net_payable_halalas: 1400 + 2345 - 235 - 1001 + 100 - 50_000 - 7_500,
    });
    expect(new Set(lines.map((l) => l.line_key)).size).toBe(lines.length);
  });

  it('a day without a contract applies zero (the visit still counts)', () => {
    const lines = computeLines(
      {
        visits: [{ ticket_id: 't1', venue_id: 'v', day: '2026-10-03' }],
        payments: [{ payment_id: 'p1', venue_id: 'v', day: '2026-10-03', amount_halalas: 2300 }],
        refunds: [],
        venues: [],
      },
      [contract({ starts_on: '2026-10-10' })],
      monthBounds('2026-10'),
      1500,
    );
    expect(lines.map((l) => [l.kind, l.amount_halalas])).toEqual([
      ['subscriber_visit', 0],
      ['app_payment', 2300],
    ]);
  });
});

describe('the invoice PDF (Arabic, right to left)', () => {
  it('splits a line into directional runs (Arabic RTL, Latin and numbers LTR)', () => {
    expect(bidiRuns('المبلغ 115.00 ريال')).toEqual([
      { text: 'المبلغ ', rtl: true },
      { text: '115.00', rtl: false },
      { text: ' ريال', rtl: true },
    ]);
    expect(bidiRuns('ضريبة 15%')).toEqual([
      { text: 'ضريبة ', rtl: true },
      { text: '15%', rtl: false },
    ]);
    expect(bidiRuns('PS-00000012')).toEqual([{ text: 'PS-00000012', rtl: false }]);
  });

  it('renders a PDF with the embedded Arabic font', async () => {
    const pdf = await renderInvoicePdf(sampleDoc(), {
      simulated: true,
      qr: sampleDoc().qr,
      status: 'مُبلَّغ عنها',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/IBMPlexSansArabic/);
    if (process.env.INVOICE_PDF_OUT) writeFileSync(process.env.INVOICE_PDF_OUT, pdf);
  });
});
