import { create } from 'zustand';

/**
 * Per offer round, in memory: whether its reminder came (`offer.reminder`, or `reminder_at` passed — D-09
 * colours the ring and plays `reminder` once), when the event that brought it was published (for
 * `client.offer_seen.receive_latency_ms`, 15 §9.4), and which rounds were already announced by a sound.
 */
interface OfferLiveState {
  reminded: Record<string, true>;
  /** offer id → `occurred_at` of the `task.offered` / `task.broadcast` frame */
  arrivedAt: Record<string, string>;
  markReminded: (offerId: string) => void;
  noteArrival: (offerId: string, occurredAt: string) => void;
  reset: () => void;
}

const cap = <T>(record: Record<string, T>, max = 100): Record<string, T> => {
  const keys = Object.keys(record);
  if (keys.length <= max) return record;
  return Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, record[k] as T]));
};

export const useOfferLive = create<OfferLiveState>()((set) => ({
  reminded: {},
  arrivedAt: {},
  markReminded: (offerId) =>
    set((s) => (s.reminded[offerId] ? s : { reminded: cap({ ...s.reminded, [offerId]: true as const }) })),
  noteArrival: (offerId, occurredAt) =>
    set((s) => (s.arrivedAt[offerId] ? s : { arrivedAt: cap({ ...s.arrivedAt, [offerId]: occurredAt }) })),
  reset: () => set({ reminded: {}, arrivedAt: {} }),
}));
