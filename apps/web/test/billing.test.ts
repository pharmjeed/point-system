import { describe, expect, it } from 'vitest';
import type { PlatformMe } from '@/api/platform';
import type { SettlementStatement } from '@/api/billing';
import { paths, platformInvoicePath, platformSettlementPath } from '@/app/paths';
import {
  adjustmentHalalas,
  breakdown,
  isPeriod,
  netDirection,
  operatorCanDispute,
  previousMonth,
  statementActions,
} from '@/features/platform/billingModel';
import { platformNav } from '@/features/platform/platformModel';
import { adminSectionsFor } from '@/features/supervisor/permissions';

const me = (permissions: string[]): PlatformMe =>
  ({
    user: { id: 'u', full_name: 'x', phone_masked: 'x', role: 'platform_finance', status: 'active' },
    permissions: ['platform.self', 'platform.overview_read', ...permissions],
  }) as unknown as PlatformMe;
const FINANCE = me(['platform.payment_read', 'platform.settlement_manage', 'platform.invoice_read']);
const SUPPORT = me(['platform.customer_read']);

/** V2-040 … V2-042: P-09 / P-10 / O-05 / O-06 — destinations, the actions per status and the forms. */
describe('billing screens (V5)', () => {
  it('P-09 and P-10 are finance’s and the owner’s destinations; the routes', () => {
    expect(platformNav(FINANCE)).toEqual(['overview', 'payments', 'settlements', 'invoices']);
    expect(platformNav(SUPPORT)).toEqual(['overview', 'customers']);
    expect(platformSettlementPath('a/b')).toBe('/platform/settlements/a%2Fb');
    expect(platformInvoicePath('i')).toBe(`${paths.platformInvoices}/i`);
  });

  it('the statement actions follow docs/v2/04 §5 and platform.settlement_manage', () => {
    expect(statementActions(FINANCE, 'draft')).toEqual(['adjust', 'issue', 'void']);
    expect(statementActions(FINANCE, 'issued')).toEqual(['record-payment', 'void']);
    expect(statementActions(FINANCE, 'disputed')).toEqual(['adjust', 'resolve-dispute', 'void']);
    expect(statementActions(FINANCE, 'paid')).toEqual([]);
    expect(statementActions(FINANCE, 'void')).toEqual([]);
    expect(statementActions(SUPPORT, 'draft')).toEqual([]);
  });

  it('O-05 / O-06 for settlement.read; the dispute of an issued statement with settlement.dispute', () => {
    expect(adminSectionsFor({ permissions: ['settlement.read'] })).toEqual(['settlements', 'subscription']);
    expect(operatorCanDispute(['settlement.dispute'], 'issued')).toBe(true);
    expect(operatorCanDispute(['settlement.dispute'], 'draft')).toBe(false);
    expect(operatorCanDispute(['settlement.read'], 'issued')).toBe(false);
  });

  it('a signed adjustment in SAR, never zero; a month; who pays whom', () => {
    expect(adjustmentHalalas('-12.34')).toBe(-1234);
    expect(adjustmentHalalas('8')).toBe(800);
    expect(adjustmentHalalas('٥٫٥')).toBeNull();
    expect(adjustmentHalalas('0')).toBeNull();
    expect(adjustmentHalalas('1.234')).toBeNull();
    expect(isPeriod('2026-10') && !isPeriod('2026-13')).toBe(true);
    expect(previousMonth(new Date('2026-11-01T00:30:00Z'))).toBe('2026-10');
    expect(previousMonth(new Date('2026-01-01T00:30:00+03:00'))).toBe('2025-12');
    expect([netDirection(1), netDirection(-1), netDirection(0)]).toEqual([
      'point_pays',
      'operator_pays',
      'nothing',
    ]);
  });

  it('the breakdown rows add up to the net', () => {
    const s = {
      subscriber_visit_count: 4,
      subscriber_payout_halalas: 3000,
      app_payment_count: 2,
      app_gross_halalas: 4645,
      app_commission_halalas: 523,
      app_refund_halalas: 1001,
      app_refund_commission_halalas: 100,
      saas_fee_halalas: 110324,
      saas_vat_halalas: 16548,
      adjustments_halalas: -1234,
      net_payable_halalas: 3000 + 4645 - 523 - 1001 + 100 - 110324 - 16548 - 1234,
    } as SettlementStatement;
    expect(breakdown(s).reduce((a, r) => a + r.halalas, 0)).toBe(s.net_payable_halalas);
  });
});
