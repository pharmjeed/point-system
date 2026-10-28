import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getHome } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome } from '@/api/types';

/**
 * Periodic polling of `GET /v1/me/home` until the realtime channel (Socket.IO, PNT-064/065) pushes
 * `task.*` / `ticket.updated`: the driver's screens re-read their whole snapshot (02 §1.7). TanStack
 * Query stops polling while the page is hidden and re-reads on focus and reconnection.
 */
export const HOME_POLL_MS = 5000;

export function useDriverHome(options: { poll?: boolean; enabled?: boolean } = {}) {
  const { poll = true, enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => getHome(signal),
    refetchInterval: poll ? HOME_POLL_MS : false,
    staleTime: 2000,
    enabled,
  });
}

/** The last home snapshot without fetching (TopBar state on any driver screen). */
export function useCachedHome(): DriverHome | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => getHome(signal),
    enabled: false,
  });
  return data;
}

/** After a command: re-read the home (and `me`, whose driver state the TopBar falls back to). */
export function useRefreshHome() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.me });
}
