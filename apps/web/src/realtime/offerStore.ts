import { create } from 'zustand';

/**
 * Per offer round, in memory: whether its reminder came (`offer.reminder`, or `reminder_at` passed — D-09
 * colours the ring and plays `reminder` once), when the event that brought it was published (for
 * `client.offer_seen.receive_latency_ms`, 15 §9.4), and which rounds were already announced by a sound.
 *
 * `refusal` is the text of a press the server refused with «sync first» (OLDER_REQUEST_PENDING,
 * NEXT_TASK_ALREADY_RESERVED, DRIVER_NOT_AVAILABLE): 02 D-09 asks to sync and show the older request with
 * that text, so it belongs to the head card whatever card the resync puts there, until the next press or
 * until no card is shown.
 */
interface OfferLiveState {
  reminded: Record<string, true>;
  /** offer id → `occurred_at` of the `task.offered` / `task.broadcast` frame */
  arrivedAt: Record<string, string>;
  refusal: string | null;
  /** The round whose D-09 card is rendered now (D-04, or the Sheet open over another screen). */
  onScreen: string | null;
  markReminded: (offerId: string) => void;
  noteArrival: (offerId: string, occurredAt: string) => void;
  setRefusal: (text: string | null) => void;
  setOnScreen: (offerId: string | null) => void;
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
  refusal: null,
  onScreen: null,
  markReminded: (offerId) =>
    set((s) => (s.reminded[offerId] ? s : { reminded: cap({ ...s.reminded, [offerId]: true as const }) })),
  noteArrival: (offerId, occurredAt) =>
    set((s) => (s.arrivedAt[offerId] ? s : { arrivedAt: cap({ ...s.arrivedAt, [offerId]: occurredAt }) })),
  setRefusal: (refusal) => set((s) => (s.refusal === refusal ? s : { refusal })),
  setOnScreen: (onScreen) => set((s) => (s.onScreen === onScreen ? s : { onScreen })),
  reset: () => set({ reminded: {}, arrivedAt: {}, refusal: null, onScreen: null }),
}));
