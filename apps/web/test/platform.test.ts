import { describe, expect, it } from 'vitest';
import { platformPendingStep, type PlatformMe } from '@/api/platform';
import { areaOf, isPlatformArea, paths } from '@/app/paths';
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
