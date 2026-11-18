import { describe, expect, it } from 'vitest';
import { operatorNotice } from '@/features/common/operatorNotice';
import { operatorBanner } from '@/i18n/ar';

/** V2-005 (DEC-486): the operator banner over the staff and driver shells follows `/v1/me`. */
describe('operator banner (V2-005)', () => {
  const org = (operator_status: 'invited' | 'trial' | 'active' | 'suspended' | 'terminated') => ({
    organization: { id: 'o', name_ar: 'م', operator_status },
  });

  it('shows for a suspended or terminated operator only', () => {
    expect(operatorNotice(org('suspended'))).toBe('suspended');
    expect(operatorNotice(org('terminated'))).toBe('terminated');
    expect(operatorNotice(org('active'))).toBeNull();
    expect(operatorNotice(org('trial'))).toBeNull();
    expect(operatorNotice(org('invited'))).toBeNull();
    expect(operatorNotice({})).toBeNull(); // an older server without the field
  });

  it('has a text for both, without a brand name', () => {
    expect(Object.keys(operatorBanner).sort()).toEqual(['suspended', 'terminated']);
    const all = JSON.stringify(operatorBanner);
    expect(all).not.toContain('بوينت');
    expect(all).not.toContain('مصاف');
  });
});
