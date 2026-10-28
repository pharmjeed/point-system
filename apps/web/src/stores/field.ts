import { create } from 'zustand';
import type { TaskCard } from '@/api/types';

/**
 * Driver-side conveniences kept in memory for the current app session only (no persist middleware): the
 * last event chosen for an intake (02 D-04 «الافتراضي آخر حفل اختاره السائق»), the D-03 audio check, and
 * the promoted next task to announce on D-04. Nothing here is written to browser storage.
 */
export type AudioCheck = 'untested' | 'ok' | 'notHeard' | 'blocked';

export interface Promotion {
  card: TaskCard;
  /** «بدأت مهمتك التالية: #{n}» (D-04, D-08) or «مهمتك التالية بدأت الآن: #{n}» (D-11). */
  title: string;
}

interface FieldState {
  lastEventId: string | null;
  setLastEventId: (id: string) => void;
  audio: AudioCheck;
  audioTestedAt: string | null;
  setAudio: (audio: AudioCheck) => void;
  /** Task ids whose promotion dialog was shown (02 D-04). */
  announced: string[];
  markAnnounced: (taskId: string) => void;
  /** A promotion returned by D-08 / D-11, shown by D-04 after the navigation. */
  promotion: Promotion | null;
  setPromotion: (promotion: Promotion | null) => void;
  reset: () => void;
}

export const useFieldStore = create<FieldState>()((set) => ({
  lastEventId: null,
  setLastEventId: (lastEventId) => set({ lastEventId }),
  audio: 'untested',
  audioTestedAt: null,
  setAudio: (audio) => set({ audio, audioTestedAt: new Date().toISOString() }),
  announced: [],
  markAnnounced: (taskId) => set((s) => ({ announced: [...s.announced.slice(-20), taskId] })),
  promotion: null,
  setPromotion: (promotion) =>
    set((s) =>
      promotion
        ? { promotion, announced: [...s.announced.slice(-20), promotion.card.task.id] }
        : { promotion: null },
    ),
  reset: () =>
    set({ lastEventId: null, audio: 'untested', audioTestedAt: null, announced: [], promotion: null }),
}));
