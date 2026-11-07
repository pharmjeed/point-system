import { describe, expect, it } from 'vitest';
import { platformPendingStep, type PlatformMe } from '@/api/platform';
import { areaOf, isPlatformArea, paths, platformOperatorPath } from '@/app/paths';
import {
  BLANK_OPERATOR,
  bpToPercent,
  commandNeedsReason,
  operatorCommands,
  percentToBp,
  platformCan,
  platformNav,
  sarToHalalas,
  validateContractForm,
  validateOperatorForm,
} from '@/features/platform/platformModel';
import * as arStaff from '@/i18n/ar.staff';

const me = (pending: PlatformMe['session']['pending']): PlatformMe => ({
  user: {
    id: 'u',
    full_name: 'مالك المنصة',
    phone_masked: '05•••••001',
    role: 'platform_owner',
    status: 'active',
    mfa_enabled: !pending.includes('mfa_setup'),
    must_change_secret: pending.includes('secret_change'),
  },
  permissions: pending.length ? ['platform.self'] : ['platform.self', 'platform.overview_read'],
  session: {
    expires_at: '2026-11-07T12:00:00Z',
    mfa_verified: !pending.includes('mfa_setup'),
    restricted: pending.length > 0,
    pending,
  },
  brand: { staff_name_ar: 'S', staff_name_en: 'S' },
});

/** V2-002: the platform console's own area, session steps and copy. */
describe('platform console (V2-002)', () => {
  it('the first sign-in goes password → TOTP set-up → console', () => {
    expect(platformPendingStep(me(['secret_change', 'mfa_setup']))).toBe('password');
    expect(platformPendingStep(me(['mfa_setup']))).toBe('mfa-setup');
    expect(platformPendingStep(me([]))).toBeNull();
  });

  it('/platform is its own area (staff theme), apart from the staff session handling', () => {
    expect(isPlatformArea(paths.platform)).toBe(true);
    expect(isPlatformArea(paths.platformLogin)).toBe(true);
    expect(isPlatformArea(paths.staffLogin)).toBe(false);
    expect(isPlatformArea('/platformx')).toBe(false);
    expect(areaOf(paths.platform)).toBe('staff');
  });

  it('every platform role has an Arabic label and no brand is written in the copy', () => {
    expect(Object.keys(arStaff.p01.role).sort()).toEqual(
      ['platform_admin', 'platform_finance', 'platform_owner', 'platform_support'].sort(),
    );
    const all = JSON.stringify(arStaff.p01);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
  });
});

const withRole = (role: PlatformMe['user']['role'], permissions: string[]): PlatformMe => ({
  ...me([]),
  user: { ...me([]).user, role },
  permissions: ['platform.self', ...permissions],
});
const OWNER = withRole('platform_owner', [
  'platform.overview_read',
  'platform.operator_read',
  'platform.operator_manage',
]);
const FINANCE = withRole('platform_finance', ['platform.overview_read']);

/** V2-003 P-01 … P-03: what each platform role is offered, the lifecycle commands, the forms, the copy. */
describe('platform console screens (V2-003)', () => {
  it('P-02 / P-03 are offered with platform.operator_read only (finance and support see P-01)', () => {
    expect(platformNav(OWNER)).toEqual(['overview', 'operators']);
    expect(platformNav(FINANCE)).toEqual(['overview']);
    expect(platformCan(FINANCE, 'platform.operator_manage')).toBe(false);
    expect(platformOperatorPath('a/b')).toBe('/platform/operators/a%2Fb');
    expect(isPlatformArea(paths.platformOperators)).toBe(true);
  });

  it('the lifecycle commands follow 02 §4 and the permission; terminated offers none', () => {
    expect(operatorCommands(OWNER, 'trial')).toEqual(['activate', 'suspend']);
    expect(operatorCommands(OWNER, 'active')).toEqual(['suspend']);
    expect(operatorCommands(OWNER, 'suspended')).toEqual(['reactivate', 'terminate']);
    expect(operatorCommands(OWNER, 'terminated')).toEqual([]);
    expect(operatorCommands(FINANCE, 'active')).toEqual([]);
    expect(commandNeedsReason('suspend') && commandNeedsReason('terminate')).toBe(true);
    expect(commandNeedsReason('reactivate') || commandNeedsReason('activate')).toBe(false);
  });

  it('the operator form: required names, CR 10 digits, VAT 3…3, a Saudi mobile for the owner', () => {
    expect(validateOperatorForm(BLANK_OPERATOR)).toEqual({
      ok: false,
      issues: {
        name_ar: 'required',
        legal_name: 'required',
        'owner.full_name': 'required',
        'owner.phone': 'phone_invalid',
      },
    });
    const bad = validateOperatorForm({
      ...BLANK_OPERATOR,
      name_ar: 'مشغل',
      legal_name: 'شركة',
      cr_number: '123',
      vat_number: '123456789012345',
      owner_name: 'مالك',
      owner_phone: '0551230001',
    });
    expect(bad).toEqual({ ok: false, issues: { cr_number: 'cr_invalid', vat_number: 'vat_invalid' } });
    const good = validateOperatorForm({
      ...BLANK_OPERATOR,
      name_ar: ' مشغل الشمال ',
      legal_name: 'شركة الشمال',
      cr_number: '1010123456',
      vat_number: '300000000000003',
      operator_status: 'active',
      owner_name: 'مالك',
      owner_phone: '0551230001',
    });
    expect(good).toEqual({
      ok: true,
      body: {
        name_ar: 'مشغل الشمال',
        name_en: null,
        legal_name: 'شركة الشمال',
        cr_number: '1010123456',
        vat_number: '300000000000003',
        operator_status: 'active',
        owner: { full_name: 'مالك', phone: '+966551230001' },
      },
    });
  });

  it('contract amounts in riyals → halalas, percent → basis points, dates and the end after the start', () => {
    expect(sarToHalalas('500')).toBe(50000);
    expect(sarToHalalas('12.5')).toBe(1250);
    expect(sarToHalalas('٥.٢٥')).toBe(525);
    expect(sarToHalalas('1.234')).toBeNull();
    expect(sarToHalalas('-1')).toBeNull();
    expect(percentToBp('2.5')).toBe(250);
    expect(percentToBp('100.01')).toBeNull();
    expect(bpToPercent(250)).toBe('2.50%');
    const base = { saas_fee: '500', saas_cycle: 'monthly' as const, payout: '5', commission: '2.5' };
    expect(validateContractForm({ ...base, starts_on: '2026-11-01', ends_on: '' })).toEqual({
      ok: true,
      body: {
        saas_fee_halalas_per_venue: 50000,
        saas_cycle: 'monthly',
        subscriber_visit_payout_halalas: 500,
        app_payment_commission_bp: 250,
        starts_on: '2026-11-01',
        ends_on: null,
      },
    });
    expect(validateContractForm({ ...base, starts_on: '2026-11-01', ends_on: '2026-11-01' })).toMatchObject({
      issues: { ends_on: 'end_before_start' },
    });
    expect(
      validateContractForm({ ...base, payout: 'x', commission: '200', starts_on: '2026-02-30', ends_on: '' }),
    ).toMatchObject({
      issues: {
        subscriber_visit_payout_halalas: 'amount',
        app_payment_commission_bp: 'percent',
        starts_on: 'date',
      },
    });
  });

  it('the console copy covers every status, command and history action, without a brand name', () => {
    expect(Object.keys(arStaff.operatorStatus).sort()).toEqual(
      ['active', 'invited', 'suspended', 'terminated', 'trial'].sort(),
    );
    expect(Object.keys(arStaff.p03.action).sort()).toEqual([
      'activate',
      'reactivate',
      'suspend',
      'terminate',
    ]);
    expect(Object.keys(arStaff.p03.confirm).sort()).toEqual([
      'activate',
      'reactivate',
      'suspend',
      'terminate',
    ]);
    expect(Object.keys(arStaff.p03.historyAction)).toHaveLength(5);
    const all = JSON.stringify([arStaff.p01, arStaff.p02, arStaff.p03]);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
  });
});
