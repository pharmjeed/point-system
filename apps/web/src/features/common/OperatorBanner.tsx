import type { Me } from '@/api/types';
import { Banner } from '@/components';
import { operatorNotice } from './operatorNotice';
import { operatorBanner } from '@/i18n/ar';

/**
 * V2-005 (DEC-486): over every staff and driver screen while the platform has suspended or terminated the
 * operator (`/v1/me` → `organization.operator_status`; the app re-reads `me` on `sync.required`). Information only:
 * the server refuses new events, shifts, duties and intakes with OPERATOR_SUSPENDED whatever this shows.
 */
export function OperatorBanner({ me }: { me: Me }) {
  const notice = operatorNotice(me);
  if (!notice) return null;
  return <Banner kind={notice === 'terminated' ? 'error' : 'warning'} message={operatorBanner[notice]} />;
}
