import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getHome } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome } from '@/api/types';
import { createRegistry, mergeSnapshot, type LiveRegistry } from '@/realtime/driverHome';
import { beginSnapshot, completeSnapshot, useSyncStore } from '@/realtime/syncStore';

/**
 * `GET /v1/me/home`, the driver's full sync source (02 §1.7), kept current by the realtime events (PNT-065):
 * one React Query entry for D-03 … D-14, merged with what the events applied (`mergeSnapshot`: an older
 * version never overwrites a newer one). Every successful read is a «sync» for the stale flag of the sync
 * protocol when it started after the last trigger. The fallback refetch is 15 s while the socket is connected
 * (15 §11.1) and 5 s without it (the PNT-035 polling).
 */
export const HOME_POLL_MS = 5000;
export const HOME_FALLBACK_MS = 15_000;

/** What the events applied to this driver's snapshot (versions, closed rounds, candidates). */
export const homeRegistry: LiveRegistry = createRegistry();
/** Client time the snapshot now in the cache was requested: an older one never replaces it. */
let appliedRequestedAt = 0;

/** Sign-out / session end / another user: forget everything the events taught. */
export function resetHomeRegistry(): void {
  homeRegistry.tasks.clear();
  homeRegistry.tickets.clear();
  homeRegistry.closedOffers.clear();
  homeRegistry.offers.clear();
  homeRegistry.driverStateAt = 0;
  appliedRequestedAt = 0;
}

/**
 * Reads the snapshot and merges it into the cache. A snapshot requested before the one already applied is
 * dropped (a slow poll answering after a resync). Clears `stale` when it started after the last trigger.
 */
export async function loadHomeSnapshot(qc: QueryClient, signal?: AbortSignal): Promise<DriverHome> {
  const generation = beginSnapshot();
  const requestedAt = Date.now();
  const snapshot = await getHome(signal);
  const cached = qc.getQueryData<DriverHome>(queryKeys.home);
  if (cached && requestedAt < appliedRequestedAt) return cached;
  appliedRequestedAt = requestedAt;
  const merged = mergeSnapshot(cached, snapshot, homeRegistry, requestedAt);
  completeSnapshot(generation, snapshot.server_time);
  return merged;
}

/** Applies an event to the cached snapshot (no-op before the first snapshot). */
export function updateHome(qc: QueryClient, apply: (home: DriverHome) => DriverHome): DriverHome | undefined {
  return qc.setQueryData<DriverHome>(queryKeys.home, (home) => (home ? apply(home) : home));
}

export function useDriverHome(options: { poll?: boolean; enabled?: boolean } = {}) {
  const { poll = true, enabled = true } = options;
  const qc = useQueryClient();
  const socket = useSyncStore((s) => s.socket);
  return useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => loadHomeSnapshot(qc, signal),
    refetchInterval: poll ? (socket === 'connected' ? HOME_FALLBACK_MS : HOME_POLL_MS) : false,
    staleTime: 2000,
    enabled,
  });
}

/** The last home snapshot without fetching (TopBar state on any driver screen). */
export function useCachedHome(): DriverHome | undefined {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.home,
    queryFn: ({ signal }) => loadHomeSnapshot(qc, signal),
    enabled: false,
  });
  return data;
}

/** After a command: re-read the home (and `me`, whose driver state the TopBar falls back to). */
export function useRefreshHome() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.me });
}
