import { useQuery } from '@tanstack/react-query';
import { Outlet } from 'react-router';
import type { Me } from '@/api/types';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { can } from './permissions';
import { fetchAlerts, LIVE_REFETCH_MS, staffKeys, type AlertFilters } from './staffApi';

/**
 * «التشغيل» destination (02 §1.4: S-02 and its S-03, S-04, S-12). A pathless layout under the staff shell that
 * keeps the live alert list loaded while the supervisor moves between these screens.
 */

export const LIVE_ALERT_FILTERS: AlertFilters = { status: ['open', 'acknowledged'] };

/** Live alerts of the scope (every venue), refreshed with the board (15 §11.1). */
export function useLiveAlerts(me: Me) {
  return useQuery({
    queryKey: staffKeys.alerts(LIVE_ALERT_FILTERS),
    queryFn: ({ signal }) => fetchAlerts(LIVE_ALERT_FILTERS, signal),
    enabled: can(me, 'alert.read'),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function OpsArea() {
  const me = useStaffMe();
  useLiveAlerts(me);
  return <Outlet context={me} />;
}
