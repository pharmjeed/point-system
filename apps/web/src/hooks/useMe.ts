import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe } from '@/api/auth';
import { queryKeys } from '@/api/queryClient';
import type { Me } from '@/api/types';
import { resolveBrand, type BrandNames } from '@/lib/brand';

/** `GET /v1/me` — who is signed in, role, permissions, restrictions (07 §2.1). 401 = signed out. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => getMe(signal),
    retry: false,
    staleTime: 60_000,
  });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (me: Me | null) => {
    if (me) qc.setQueryData(queryKeys.me, me);
    else qc.removeQueries({ queryKey: queryKeys.me });
  };
}

/**
 * Brand names: org settings from `/v1/me` when signed in, else VITE_BRAND_* (canon §1).
 * Observes the cached `['me']` without fetching it.
 */
export function useBrand(): BrandNames {
  const { data } = useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => getMe(signal),
    enabled: false,
  });
  return resolveBrand(data?.brand);
}
