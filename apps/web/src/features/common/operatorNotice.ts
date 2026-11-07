import type { Me } from '@/api/types';

/** The staff app's operator banner (V2-005, DEC-486): only for a suspended or terminated operator. */
export function operatorNotice(me: Pick<Me, 'organization'>): 'suspended' | 'terminated' | null {
  const s = me.organization?.operator_status;
  return s === 'suspended' || s === 'terminated' ? s : null;
}
