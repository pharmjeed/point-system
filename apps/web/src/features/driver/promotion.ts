import type { TaskCard } from '@/api/types';
import { d04 } from '@/i18n/ar';
import { useFieldStore } from '@/stores/field';

/**
 * The reserved next task became the current one (02 D-04: `task.updated` to `accepted` → `next_due` and
 * «بدأت مهمتك التالية: #n» → D-10; 10 §6.3: the current retrieval canceled before it started, reassigned,
 * moved by a custody transfer or closed by a manual reconcile). It is announced over whatever driver screen
 * is open — from the realtime event, or from a snapshot that shows it — once per task. D-08 and D-11 announce
 * the promotion their own command returned, with their title and timing (02 D-11 «بعد ثانيتين»), so the
 * frame stays quiet while they complete the current task (`completingUntil`).
 */
export function announcePromotion(card: TaskCard, now = Date.now()): boolean {
  const field = useFieldStore.getState();
  if (field.announced.includes(card.task.id) || now < field.completingUntil) return false;
  field.setPromotion({ card, title: d04.promoted });
  return true;
}

/** D-08 / D-11 send the command that completes the current task: the frame waits for their reply. */
export const COMPLETING_WINDOW_MS = 30_000;
