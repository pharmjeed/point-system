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
};
