import { api, apiFetch } from './client';

/**
 * V2-037 — the platform console's P-13 «الشكاوى» (docs/07_openapi.yaml tag Platform: `PlatformComplaint*`;
 * DEC-603, DEC-604): the customers' complaints with their reference numbers, the customer masked.
 */
export type ComplaintStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type ComplaintCategory =
  'service' | 'delay' | 'vehicle_damage' | 'lost_item' | 'payment' | 'subscription' | 'staff' | 'other';

export interface PlatformComplaint {
  complaint_id: string;
  reference: string;
  category: ComplaintCategory;
  status: ComplaintStatus;
  body: string;
  account_id: string;
  phone_masked: string | null;
  ticket_id: string | null;
  subscription_id: string | null;
  org_id: string | null;
  operator_name_ar: string | null;
  venue_id: string | null;
  venue_name_ar: string | null;
  resolution_note: string | null;
  allowed_next: ComplaintStatus[];
  created_at: string;
  updated_at: string;
}

export interface ComplaintFilters {
  status?: ComplaintStatus | undefined;
  q?: string | undefined;
}

const enc = encodeURIComponent;

export const complaintKeys = {
  list: (f: ComplaintFilters) => ['platform', 'complaints', f] as const,
};

export const complaintsApi = {
  list: async (f: ComplaintFilters, cursor?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, String(v));
    if (cursor) params.set('cursor', cursor);
    params.set('limit', '50');
    const r = await apiFetch<PlatformComplaint[]>('GET', `/v1/platform/complaints?${params.toString()}`, {
      signal,
    });
    return { items: r.data ?? [], nextCursor: r.meta.next_cursor ?? null };
  },
  setStatus: async (id: string, body: { status: ComplaintStatus; note: string }, key: string) =>
    (
      await api.post<PlatformComplaint>(`/v1/platform/complaints/${enc(id)}/status`, {
        body,
        idempotencyKey: key,
      })
    ).data,
};
