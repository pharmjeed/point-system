/**
 * Haptic feedback on the customer's key actions (V2-UX, DEC-574): a light tap on a primary action, a selection tick
 * on a choice, a success pattern when the server confirms (car requested, paid, subscribed) and an error one on a
 * refusal. Feedback only, never the only signal (the screen always says it). The staff rule of 03 §2.8 (vibration
 * with offers only) is the drivers' PWA. On the web export it does nothing (haptics.web.ts).
 */
import * as Haptics from 'expo-haptics';

const safe = (run: () => Promise<void>) => {
  run().catch(() => undefined);
};

export const haptic = {
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  select: () => safe(() => Haptics.selectionAsync()),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
