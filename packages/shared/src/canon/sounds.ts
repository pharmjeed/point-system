/**
 * Staff UI sounds (canon §13). Source files live in `brand/sounds/` and are copied to
 * `apps/web/public/sounds/`. `task.claimed` stops any sound of the card immediately and plays none.
 */
import { z } from 'zod';

export const SOUND_IDS = ['offer', 'broadcast', 'reminder', 'next_due', 'escalation', 'test'] as const;
export type SoundId = (typeof SOUND_IDS)[number];
export const SoundIdSchema = z.enum(SOUND_IDS);

export interface SoundDef {
  id: SoundId;
  /** File name, e.g. `point-offer.mp3`. */
  file: string;
  /** Path of the source asset in the repository. */
  source: string;
  /** When it plays (canon §13 «متى»). */
  when_ar: string;
}

const sound = (id: SoundId, file: string, when_ar: string): SoundDef => ({
  id,
  file,
  source: `brand/sounds/${file}`,
  when_ar,
});

export const SOUNDS: Readonly<Record<SoundId, SoundDef>> = {
  offer: sound('offer', 'point-offer.mp3', 'عرض فردي'),
  broadcast: sound('broadcast', 'point-broadcast.mp3', 'بث لجميع سائقي الموقع'),
  reminder: sound('reminder', 'point-reminder.mp3', 'تذكير عرض/بث'),
  next_due: sound('next_due', 'point-next-due.mp3', 'ترقية المهمة التالية بعد إنهاء الحالية'),
  escalation: sound('escalation', 'point-escalation.mp3', 'تصعيد للمشرف'),
  test: sound('test', 'point-test.mp3', 'زر «تفعيل واختبار الصوت»'),
};

/** Public URL of a sound in the web app (`apps/web/public/sounds/`). */
export function soundUrl(id: SoundId): string {
  return `/sounds/${SOUNDS[id].file}`;
}
