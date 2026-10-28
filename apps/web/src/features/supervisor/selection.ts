import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { EventStatus } from '@/api/types';
import { fetchVenueEvents, fetchVenues, staffKeys } from './staffApi';

/**
 * The venue / event the supervisor is looking at (02 §1.3: «قاعة ريماس ▾ │ حفل آل فلان ▾»). In memory only
 * (zustand without persistence): it survives navigation between the staff screens, not a reload — the
 * selector then starts from the first venue of the scope (02 S-01 «S-02 للموقع الأول في النطاق»).
 */
export const ALL_OPEN = 'all-open';

interface SelectionState {
  venueId: string | null;
  /** An event id, or ALL_OPEN for «كل الحفلات المفتوحة». */
  eventId: string | null;
  setVenue: (venueId: string | null) => void;
  setEvent: (eventId: string | null) => void;
}

export const useSelectionStore = create<SelectionState>()((set) => ({
  venueId: null,
  eventId: null,
  setVenue: (venueId) => set({ venueId, eventId: null }),
  setEvent: (eventId) => set({ eventId }),
}));

export const LIVE_EVENT_STATUSES: readonly EventStatus[] = ['open', 'closing'];

export function useVenues(enabled = true) {
  return useQuery({
    queryKey: staffKeys.venues(),
    queryFn: ({ signal }) => fetchVenues(signal),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useVenueEvents(
  venueId: string | null,
  statuses: readonly EventStatus[] = LIVE_EVENT_STATUSES,
) {
  return useQuery({
    queryKey: staffKeys.venueEvents(venueId ?? '-', statuses),
    queryFn: ({ signal }) => fetchVenueEvents(venueId as string, statuses, signal),
    enabled: !!venueId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Resolves the selection against what the server returns: the first venue of the scope by default; the only
 * open event, or «كل الحفلات المفتوحة» when there are several (02 §1.3).
 */
export function useOpsSelection(enabled = true) {
  const venues = useVenues(enabled);
  const { venueId, eventId, setVenue, setEvent } = useSelectionStore();
  const venueList = venues.data?.items ?? [];
  const effectiveVenueId =
    venueId && venueList.some((v) => v.id === venueId) ? venueId : (venueList[0]?.id ?? null);
  const events = useVenueEvents(effectiveVenueId);
  const eventList = events.data?.items ?? [];
  const effectiveEventId =
    eventId === ALL_OPEN && eventList.length > 1
      ? ALL_OPEN
      : eventId && eventList.some((e) => e.id === eventId)
        ? eventId
        : eventList.length > 1
          ? ALL_OPEN
          : (eventList[0]?.id ?? null);

  useEffect(() => {
    if (effectiveVenueId && effectiveVenueId !== venueId)
      useSelectionStore.setState({ venueId: effectiveVenueId });
  }, [effectiveVenueId, venueId]);

  const eventIds =
    effectiveEventId === ALL_OPEN ? eventList.map((e) => e.id) : effectiveEventId ? [effectiveEventId] : [];
  return {
    venues,
    events,
    venueList,
    eventList,
    venueId: effectiveVenueId,
    eventId: effectiveEventId,
    eventIds,
    venue: venueList.find((v) => v.id === effectiveVenueId) ?? null,
    setVenue,
    setEvent,
  };
}
