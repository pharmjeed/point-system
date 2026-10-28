import type { DriverListItem, DriverState } from '@/api/types';
import { onlyDigits } from '@/lib/digits';

/** S-05 filter chips «الكل · متاح · مشغول · استراحة · خارج الوردية · معطّل»; «مشغول» = three states (02 S-05). */
export type DriverFilter = 'all' | 'available' | 'busy' | 'on_break' | 'off_duty' | 'disabled';

export const BUSY_STATES: DriverState[] = ['intake_parking', 'retrieving', 'busy_with_next'];

export const stateOf = (d: DriverListItem): DriverState => d.live?.driver_state ?? 'off_duty';

export function matchesFilter(d: DriverListItem, filter: DriverFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'disabled') return d.user.status === 'disabled';
  if (d.user.status === 'disabled') return false;
  const state = stateOf(d);
  if (filter === 'busy') return BUSY_STATES.includes(state);
  return state === filter;
}

/** Name, employee code or phone digits (02 S-05 «ابحث بالاسم أو الرقم الوظيفي أو الجوال»). */
export function matchesSearch(d: DriverListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (d.user.full_name.toLowerCase().includes(q)) return true;
  if (d.user.employee_code.toLowerCase().includes(q)) return true;
  const digits = onlyDigits(q);
  return digits.length >= 3 && onlyDigits(d.user.phone_e164 ?? '').includes(digits);
}
