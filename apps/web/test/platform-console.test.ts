import { describe, expect, it } from 'vitest';
import type { PlatformMe } from '@/api/platform';
import type { PlatformPaymentDetail } from '@/api/platformConsole';
import {
  isPlatformArea,
  paths,
  platformAlertsPath,
  platformCustomerPath,
  platformPaymentPath,
  platformReconciliationPath,
} from '@/app/paths';
import {
  canRefund,
  customerCommands,
  paymentFilters,
  paymentTimeline,
  phoneQuery,
  refundAmount,
  BLANK_PAYMENT_FILTERS,
} from '@/features/platform/consoleModel';
import { platformNav } from '@/features/platform/platformModel';
import * as arStaff from '@/i18n/ar.staff';

const withRole = (role: PlatformMe['user']['role'], permissions: string[]): PlatformMe => ({
  user: {
    id: 'u',
    full_name: 'حساب',
    phone_masked: '05•••••001',
    role,
    status: 'active',
    mfa_enabled: true,
    must_change_secret: false,
  },
  permissions: ['platform.self', 'platform.overview_read', ...permissions],
  session: { expires_at: '2026-11-08T12:00:00Z', mfa_verified: true, restricted: false, pending: [] },
  brand: { staff_name_ar: 'S', staff_name_en: 'S' },
});
const SUPPORT = withRole('platform_support', ['platform.customer_read', 'platform.customer_manage']);
const FINANCE = withRole('platform_finance', [
  'platform.customer_read',
  'platform.customer_manage',
  'platform.payment_read',
  'platform.refund_issue',
]);
const ADMIN = withRole('platform_admin', ['platform.operator_read', 'platform.venue_review']);

/** V2-024: P-06 / P-08 — the destinations per role, the commands offered, the forms and the copy. */
describe('platform console P-06 / P-08 (V2-024)', () => {
  it('P-06 with platform.customer_read, P-08 with platform.payment_read (02 §2.1)', () => {
    expect(platformNav(SUPPORT)).toEqual(['overview', 'customers']);
    expect(platformNav(FINANCE)).toEqual(['overview', 'customers', 'payments']);
    expect(platformNav(ADMIN)).toEqual(['overview', 'operators', 'venues']);
    expect(platformCustomerPath('a/b')).toBe('/platform/customers/a%2Fb');
    expect(platformPaymentPath('p')).toBe('/platform/payments/p');
    expect(platformReconciliationPath()).toBe('/platform/payments/reconciliation');
    expect(platformReconciliationPath('r')).toBe('/platform/payments/reconciliation/r');
    expect(platformAlertsPath).toBe('/platform/payments/alerts');
    expect(isPlatformArea(paths.platformCustomers) && isPlatformArea(paths.platformPayments)).toBe(true);
  });

  it('the account commands follow the status and platform.customer_manage; a deleted account takes none', () => {
    expect(customerCommands(SUPPORT, 'active')).toEqual(['suspend', 'revoke_sessions']);
    expect(customerCommands(SUPPORT, 'suspended')).toEqual(['reactivate', 'revoke_sessions']);
    expect(customerCommands(SUPPORT, 'deleted')).toEqual([]);
    expect(customerCommands(withRole('platform_owner', ['platform.customer_read']), 'active')).toEqual([]);
  });

  it('the phone search is exact: any Saudi format of a full number, else refused before it is sent', () => {
    expect(phoneQuery('')).toEqual({ ok: true, phone: null });
    expect(phoneQuery('0551234567')).toEqual({ ok: true, phone: '+966551234567' });
    expect(phoneQuery('+966 55 123 4567')).toEqual({ ok: true, phone: '+966551234567' });
    expect(phoneQuery('٠٥٥١٢٣٤٥٦٧')).toEqual({ ok: true, phone: '+966551234567' });
    expect(phoneQuery('0551')).toEqual({ ok: false });
  });

  it('the refund: blank = everything left, else 0.01 … refundable riyals; offered with refund_issue only', () => {
    expect(refundAmount('', 2300)).toEqual({ ok: true, halalas: undefined });
    expect(refundAmount('12.5', 2300)).toEqual({ ok: true, halalas: 1250 });
    expect(refundAmount('23', 2300)).toEqual({ ok: true, halalas: 2300 });
    expect(refundAmount('23.01', 2300)).toEqual({ ok: false });
    expect(refundAmount('0', 2300)).toEqual({ ok: false });
    expect(refundAmount('abc', 2300)).toEqual({ ok: false });
    expect(canRefund(FINANCE, { refundable_halalas: 1 })).toBe(true);
    expect(canRefund(FINANCE, { refundable_halalas: 0 })).toBe(false);
    expect(canRefund(SUPPORT, { refundable_halalas: 100 })).toBe(false);
  });

  it('the payment filters: Riyadh days, a backwards range refused, the account kept', () => {
    expect(paymentFilters(BLANK_PAYMENT_FILTERS)).toEqual({ ok: true, filters: {} });
    expect(
      paymentFilters(
        { status: 'paid', purpose: 'visit', from: '2026-10-01', to: '2026-10-31' },
        { account_id: 'a' },
      ),
    ).toEqual({
      ok: true,
      filters: { status: 'paid', purpose: 'visit', from: '2026-10-01', to: '2026-10-31', account_id: 'a' },
    });
    expect(paymentFilters({ ...BLANK_PAYMENT_FILTERS, from: '2026-10-02', to: '2026-10-01' })).toEqual({
      ok: false,
      issue: 'range',
    });
    expect(paymentFilters({ ...BLANK_PAYMENT_FILTERS, from: '2026-02-30' })).toEqual({
      ok: false,
      issue: 'date',
    });
  });

  it('the payment timeline merges status changes, deliveries and refunds, oldest first', () => {
    const p = {
      status_history: [
        {
          action: 'online_payment.paid',
          from_status: 'initiated',
          to_status: 'paid',
          cause: null,
          failure_code: null,
          occurred_at: '2026-10-27T16:00:01Z',
        },
      ],
      webhook_events: [
        {
          id: 1,
          event_type: 'payment_paid',
          live: false,
          received_at: '2026-10-27T16:00:05Z',
          processed_at: null,
          outcome: 'unchanged',
          claimed: { status: 'paid', amount_halalas: 2300, refunded_halalas: 0 },
        },
      ],
      refunds: [
        {
          id: 'r',
          amount_halalas: 500,
          reason: 'تأخر',
          status: 'requested',
          failure_code: null,
          issued_by: { id: 'u', full_name: 'م' },
          created_at: '2026-10-27T15:00:00Z',
          sent_at: null,
          completed_at: null,
        },
      ],
    } as unknown as PlatformPaymentDetail;
    const t = paymentTimeline(p);
    expect(t.map((e) => e.kind)).toEqual(['refund', 'status', 'webhook']);
    // an unprocessed delivery has no outcome yet
    expect(t[2]).toMatchObject({ kind: 'webhook', outcome: null });
  });

  it('the copy covers every status, command, alert type and session end, without a brand name', () => {
    expect(Object.keys(arStaff.p06.action).sort()).toEqual(['reactivate', 'revoke_sessions', 'suspend']);
    expect(Object.keys(arStaff.p06.confirm).sort()).toEqual(['reactivate', 'revoke_sessions', 'suspend']);
    expect(Object.keys(arStaff.onlinePaymentStatus)).toHaveLength(6);
    // the four of V2-021 and payment_double of V2-022 (DEC-523)
    expect(Object.keys(arStaff.p08.alertsTab.type).sort()).toEqual([
      'payment_double',
      'payment_mismatch',
      'payment_reconcile_failed',
      'payment_refund_failed',
      'payment_unknown',
    ]);
    expect(Object.keys(arStaff.p08.runs.kind)).toHaveLength(5);
    expect(arStaff.p06.revokedReason.platform_revoked).toBeTruthy();
    const all = JSON.stringify([arStaff.p06, arStaff.p08, arStaff.onlinePaymentStatus, arStaff.refundStatus]);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
  });
});
