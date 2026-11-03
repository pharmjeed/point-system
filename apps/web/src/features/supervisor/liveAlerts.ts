import { useQuery } from '@tanstack/react-query';
import type { Me } from '@/api/types';
import { can } from './permissions';
import { fetchAlerts, LIVE_REFETCH_MS, staffKeys, type AlertFilters } from './staffApi';

export const LIVE_ALERT_FILTERS: AlertFilters = { status: ['open', 'acknowledged'] };

/**
 * Live alerts of the scope (every venue), refreshed with the board (15 §11.1). One query key for the staff
 * TopBar's «التنبيهات (n)» (02 §1.3) and the «التشغيل» area (S-02, S-04), so they share one read.
 */
export function useLiveAlerts(me: Me) {
  return useQuery({
    queryKey: staffKeys.alerts(LIVE_ALERT_FILTERS),
    queryFn: ({ signal }) => fetchAlerts(LIVE_ALERT_FILTERS, signal),
    enabled: can(me, 'alert.read'),
    refetchInterval: LIVE_REFETCH_MS,
  });
}
