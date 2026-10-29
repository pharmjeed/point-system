import { QueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError } from './errors';

/**
 * Server state (05 §5): React Query. Reads retry transient failures; 4xx answers are final.
 * Mutations never auto-retry here — commands go through CommandSession (same Idempotency-Key).
 */
export function shouldRetryRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) return error.status >= 500 || error.code === 'RATE_LIMITED';
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryRead,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 15_000,
      },
      mutations: { retry: false },
    },
  });
}

export const queryKeys = {
  me: ['me'] as const,
  /** Under `me`: invalidating the session also re-reads the driver's home (02 §1.7). */
  home: ['me', 'home'] as const,
  ticket: (ticketId: string) => ['tickets', ticketId] as const,
  /** D-12 lists (`GET /v1/tickets`, infinite pages): patched in place by `ticket.updated`. */
  vehicles: ['vehicles'] as const,
  vehicleSearch: (q: string, statuses: string) => ['vehicles', q, statuses] as const,
  mediaUrl: (mediaId: string) => ['media', mediaId, 'url'] as const,
  venues: ['venues'] as const,
  venue: (venueId: string) => ['venues', venueId] as const,
  venueSettings: (venueId: string) => ['venues', venueId, 'settings'] as const,
  pools: (venueId: string) => ['venues', venueId, 'pools'] as const,
  zones: (venueId: string) => ['venues', venueId, 'zones'] as const,
  spots: (venueId: string) => ['venues', venueId, 'spots'] as const,
  keyBoards: (venueId: string) => ['venues', venueId, 'key-boards'] as const,
  events: (venueId: string) => ['venues', venueId, 'events'] as const,
  shifts: (venueId: string) => ['venues', venueId, 'shifts'] as const,
  drivers: ['drivers'] as const,
  driverList: (venueId: string | null) => ['drivers', 'list', venueId ?? 'all'] as const,
  driver: (driverId: string) => ['drivers', 'one', driverId] as const,
  driverAssignments: (driverId: string) => ['drivers', 'one', driverId, 'assignments'] as const,
};
