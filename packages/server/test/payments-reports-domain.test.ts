import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors/app-error.js';
import {
  assertPaymentMatches,
  cashDifferenceDescription,
  formatRiyadh,
  formatSar,
  formatSarAr,
  normalizePosReference,
  paymentStatusBlocker,
  posReferenceIssues,
  storedPosReference,
} from '../src/modules/payments-reports/domain/payment-rules.js';
import { BOM, csvCell, toCsv } from '../src/modules/payments-reports/infra/csv.js';
import { ReportCursorCodec } from '../src/modules/payments-reports/infra/cursor.js';
import { maskPhonesInText } from '../src/modules/payments-reports/application/views.js';

/** PNT-080 … PNT-089 pure rules: 13 §5.2 / §5.6, 13 §2.3 / §13 formats, CSV safety, report cursors. */

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? { code: e.code, details: e.details } : { code: 'not-an-app-error' };
  }
  return null;
};

describe('pos_reference (13 §5.6)', () => {
  it('normalizes spaces, dashes (also Unicode ones) and case; Arabic-Indic digits become Latin; empty is none', () => {
    expect(normalizePosReference(' ap-48 21 ')).toBe('AP4821');
    expect(normalizePosReference('ap–482\u00A01')).toBe('AP4821');
    expect(normalizePosReference('٤٨٢١')).toBe('4821');
    expect(normalizePosReference(' - ')).toBeNull();
    expect(normalizePosReference(null)).toBeNull();
    expect(normalizePosReference(undefined)).toBeNull();
  });

  it('issues: not_applicable with cash, looks_like_card_number (13+ digits), invalid_format, prefixed field', () => {
    const pos = (ref: string) => ({ method: 'pos' as const, amount_halalas: 2000, pos_reference: ref });
    expect(posReferenceIssues(pos('AP4821'))).toEqual([]);
    expect(posReferenceIssues({ method: 'pos', amount_halalas: 2000 })).toEqual([]);
    expect(posReferenceIssues({ method: 'cash', amount_halalas: 2000, pos_reference: 'X1' })).toEqual([
      { field: 'pos_reference', issue: 'not_applicable' },
    ]);
    expect(posReferenceIssues(pos('4111 1111 1111 1111'))).toEqual([
      { field: 'pos_reference', issue: 'looks_like_card_number' },
    ]);
    expect(posReferenceIssues(pos('1234567890123'))).toEqual([
      { field: 'pos_reference', issue: 'looks_like_card_number' },
    ]);
    expect(posReferenceIssues(pos('123456789012'))).toEqual([]); // 12 digits: not a PAN
    expect(posReferenceIssues(pos('AB#12'), 'payment.')).toEqual([
      { field: 'payment.pos_reference', issue: 'invalid_format' },
    ]);
    expect(posReferenceIssues(pos('A'.repeat(25)), 'replacement.')).toEqual([
      { field: 'replacement.pos_reference', issue: 'invalid_format' },
    ]);
  });

  it('cash never stores a reference; pos stores the normalized one', () => {
    expect(storedPosReference({ method: 'cash', amount_halalas: 1, pos_reference: 'x' })).toBeNull();
    expect(storedPosReference({ method: 'pos', amount_halalas: 1, pos_reference: 'ap 1' })).toBe('AP1');
  });
});

describe('collection checks (13 §5.2, §15)', () => {
  const ev = { allowed_payment_methods: ['cash'] as const };
  it('method before amount, with the 08 details', () => {
    expect(
      codeOf(() => assertPaymentMatches({ method: 'pos', amount_halalas: 1 }, ev, { fee_halalas: 2000 })),
    ).toEqual({
      code: 'PAYMENT_METHOD_NOT_ALLOWED',
      details: { allowed_methods: ['cash'] },
    });
    expect(
      codeOf(() => assertPaymentMatches({ method: 'cash', amount_halalas: 1500 }, ev, { fee_halalas: 2000 })),
    ).toEqual({
      code: 'PAYMENT_AMOUNT_MISMATCH',
      details: { expected_halalas: 2000, received_halalas: 1500 },
    });
    expect(
      codeOf(() => assertPaymentMatches({ method: 'cash', amount_halalas: 2000 }, ev, { fee_halalas: 2000 })),
    ).toBeNull();
  });

  it('payment_status → the blocker of a collection', () => {
    expect(paymentStatusBlocker('due')).toBeNull();
    expect(paymentStatusBlocker('collected')).toBe('collected');
    expect(paymentStatusBlocker('not_required')).toBe('payment_not_required');
    expect(paymentStatusBlocker('waived')).toBe('payment_waived');
  });
});

describe('formats (13 §2.3, §13)', () => {
  it('halalas → SAR with Latin digits and two decimals', () => {
    expect(formatSar(2000)).toBe('20.00');
    expect(formatSar(5)).toBe('0.05');
    expect(formatSar(0)).toBe('0.00');
    expect(formatSar(-2050)).toBe('-20.50');
    expect(formatSarAr(48000)).toBe('480.00 ر.س');
    expect(cashDifferenceDescription(2000, 1500)).toContain('-5.00');
  });

  it('times in Asia/Riyadh as YYYY-MM-DD HH:mm (midnight crossing, no DST)', () => {
    expect(formatRiyadh('2026-10-27T16:05:59Z')).toBe('2026-10-27 19:05');
    expect(formatRiyadh(new Date('2026-10-27T21:30:00Z'))).toBe('2026-10-28 00:30');
    expect(formatRiyadh(null)).toBe('');
    expect(formatRiyadh('garbage')).toBe('');
  });

  it('phone-like runs in free text are masked; short numbers stay', () => {
    expect(maskPhonesInText('اتصل 0551234567 الآن')).not.toContain('0551234567');
    expect(maskPhonesInText('+966 55 123 4567')).not.toMatch(/123 4567/);
    expect(maskPhonesInText('تذكرة 1234')).toBe('تذكرة 1234');
  });
});

describe('CSV (13 §13; formula injection)', () => {
  it('quotes RFC 4180 cells, guards formulas in text cells only, BOM + CRLF', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(' padded ')).toBe('" padded "');
    expect(csvCell('=SUM(A1)', true)).toBe("'=SUM(A1)");
    expect(csvCell('+966', true)).toBe("'+966");
    expect(csvCell('-20.00')).toBe('-20.00'); // an amount column is not text
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    const out = toCsv(
      [
        { name: 'n', value: (r: { n: number; s: string }) => r.n },
        { name: 's', value: (r: { n: number; s: string }) => r.s, text: true },
      ],
      [
        { n: 1, s: '@cmd' },
        { n: 2, s: 'ok' },
      ],
    );
    expect(out).toBe(`${BOM}n,s\r\n1,'@cmd\r\n2,ok\r\n`);
  });
});

describe('report cursors (07 §1.7)', () => {
  const codec = new ReportCursorCodec('test-secret-test-secret-test-secret');
  it('round-trips within the same list scope only; tampering is PAGINATION_CURSOR_INVALID', () => {
    const c = codec.encode('drivers|a', ['D-0001', 'u1', 'v1']);
    expect(codec.decode(c, 'drivers|a', 3)).toEqual(['D-0001', 'u1', 'v1']);
    const bad = (x: string, scope = 'drivers|a', arity = 3) =>
      codeOf(() => codec.decode(x, scope, arity))?.code;
    expect(bad(c, 'drivers|b')).toBe('PAGINATION_CURSOR_INVALID');
    expect(bad(c, 'drivers|a', 2)).toBe('PAGINATION_CURSOR_INVALID');
    expect(bad(`${c}x`)).toBe('PAGINATION_CURSOR_INVALID');
    expect(bad('nodot')).toBe('PAGINATION_CURSOR_INVALID');
    const mac = c.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ s: 'drivers|a', v: ['Z', 'u', 'v'] })).toString('base64url');
    expect(bad(`${forged}.${mac}`)).toBe('PAGINATION_CURSOR_INVALID');
    // another key (another SESSION_SECRET) does not accept it either
    const other = new ReportCursorCodec('another-secret-another-secret-xx');
    expect(codeOf(() => other.decode(c, 'drivers|a', 3))?.code).toBe('PAGINATION_CURSOR_INVALID');
  });
});

/** 04 §4.3: payments-reports imports tickets-custody, venues-events, media and core only, through their index. */
describe('module boundaries — payments-reports', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const root = join(import.meta.dirname, '../src/modules/payments-reports');
  const imports = files(root).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => ({ file: f, spec: m[1]! })),
  );

  it('never imports dispatch, whatsapp, notifications, incidents or the use-cases', () => {
    expect(
      imports.filter((i) =>
        /modules\/(dispatch|whatsapp|notifications|incidents)|\/(dispatch|whatsapp|notifications)\/|use-cases/.test(
          i.spec,
        ),
      ),
    ).toEqual([]);
  });

  it('reaches other modules only through their public index', () => {
    // files sit one folder below the module root: `../../<module>/…` is another module, `../../../` is core
    const sibling = imports.filter((i) => i.spec.startsWith('../../') && !i.spec.startsWith('../../../'));
    expect(sibling.length).toBeGreaterThan(0);
    expect(
      sibling.filter((i) => !/^\.\.\/\.\.\/(tickets-custody|venues-events|media)\/index\.js$/.test(i.spec)),
    ).toEqual([]);
  });
});
