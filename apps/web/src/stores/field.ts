import { create } from 'zustand';
import type { TaskCard } from '@/api/types';

/**
 * Driver-side conveniences kept in memory for the current app session only (no persist middleware): the
 * last event chosen for an intake (02 D-04 «الافتراضي آخر حفل اختاره السائق»), the D-03 audio check, the
 * promoted next task to announce and the live notices of 14 §5.1 shown over every driver screen. Nothing
 * here is written to browser storage.
 */
export type AudioCheck = 'untested' | 'ok' | 'notHeard' | 'blocked';

export interface Promotion {
  card: TaskCard;
  /** «بدأت مهمتك التالية: #{n}» (D-04, D-08) or «مهمتك التالية بدأت الآن: #{n}» (D-11). */
  title: string;
  /** Client time to show it at (02 D-11: «بعد ثانيتين» of «تم تسليم #125»); now when absent. */
  showAt?: number;
}

/**
 * A banner of 14 §5.1 raised by a server event (02 D-10, 14 §3.1–§3.2): the retrieval canceled («أُلغي طلب
 * الإحضار — تذكرة n», no sound), the task withdrawn or reassigned away («سحب المشرف المهمة…», `reminder`),
 * the repark the supervisor's cancel created (DEC-30: «أعد سيارة تذكرة n…» → D-08, `next_due`), the early
 * request during parking (02 D-08's sentence, `reminder`). Shown until dismissed or until its cause is gone.
 */
export type NoticeKind = 'canceled' | 'withdrawn' | 'repark' | 'early';

export interface DriverNotice {
  /** `${kind}:${taskId}`: one notice per cause. */
  key: string;
  kind: NoticeKind;
  taskId: string;
  ticketId: string;
  ticketNumber: number;
}

const MAX_NOTICES = 3;

interface FieldState {
  lastEventId: string | null;
  setLastEventId: (id: string) => void;
  audio: AudioCheck;
  audioTestedAt: string | null;
  setAudio: (audio: AudioCheck) => void;
  /** Task ids whose promotion dialog was shown (02 D-04). */
  announced: string[];
  markAnnounced: (taskId: string) => void;
  /** The promotion to announce (the frame's dialog, on every driver screen). */
  promotion: Promotion | null;
  setPromotion: (promotion: Promotion | null) => void;
  /**
   * Until this client time D-08 / D-11 complete the current task themselves and announce the promotion their
   * reply returns (02 D-08, D-11 «بعد ثانيتين»); the frame does not announce it on its own meanwhile.
   */
  completingUntil: number;
  setCompleting: (until: number) => void;
  notices: DriverNotice[];
  addNotice: (notice: Omit<DriverNotice, 'key'>) => void;
  dismissNotice: (key: string) => void;
  /** Drops the notices whose cause is gone (`keep` false). */
  pruneNotices: (keep: (notice: DriverNotice) => boolean) => void;
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
  completingUntil: 0,
  setCompleting: (completingUntil) => set({ completingUntil }),
  notices: [],
  addNotice: (notice) =>
    set((s) => {
      const key = `${notice.kind}:${notice.taskId}`;
      const rest = s.notices.filter((n) => n.key !== key);
      return { notices: [...rest, { ...notice, key }].slice(-MAX_NOTICES) };
    }),
  dismissNotice: (key) => set((s) => ({ notices: s.notices.filter((n) => n.key !== key) })),
  pruneNotices: (keep) =>
    set((s) => {
      const notices = s.notices.filter(keep);
      return notices.length === s.notices.length ? s : { notices };
    }),
  reset: () =>
    set({
      lastEventId: null,
      audio: 'untested',
      audioTestedAt: null,
      announced: [],
      promotion: null,
      completingUntil: 0,
      notices: [],
    }),
}));
