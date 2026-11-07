import { useQuery } from '@tanstack/react-query';
import { getPlatformMe } from '@/api/platform';
import { queryKeys } from '@/api/queryClient';

/** `GET /v1/platform/me` — the platform account and its session (V2-002). 401 = signed out of the platform. */
export function usePlatformMe() {
  return useQuery({
    queryKey: queryKeys.platformMe,
    queryFn: ({ signal }) => getPlatformMe(signal),
    retry: false,
    staleTime: 60_000,
  });
}
