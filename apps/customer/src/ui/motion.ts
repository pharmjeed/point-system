/**
 * Motion of the customer app (V2-UX, DEC-572): the durations and curves of 03 §2.7 (`brand/tokens` `motion`) on
 * React Native's `Animated`, and the reduce-motion setting of the device (iOS «تقليل الحركة», Android «إزالة
 * الرسوم المتحركة», the browser's `prefers-reduced-motion` on the web export). With it on, every animation of the
 * app is skipped and the final state is drawn at once (03 §2.7); nothing the customer needs is carried by motion.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Easing, Platform } from 'react-native';
import { motion } from '../theme/tokens';

/** react-native-web has no native driver (it warns); iOS and Android animate transforms and opacity natively. */
export const nativeDriver = Platform.OS !== 'web';

export const ease = {
  standard: Easing.bezier(...motion.standard),
  emphasized: Easing.bezier(...motion.emphasized),
  exit: Easing.bezier(...motion.exit),
} as const;

export { motion };

let cached: boolean | null = null;

/** The device's reduce-motion setting, followed live (`false` until the first answer). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(cached ?? false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        cached = on;
        if (alive) setReduced(on);
      })
      .catch(() => undefined);
    let sub: { remove: () => void } | undefined;
    try {
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on: boolean) => {
        cached = on;
        setReduced(on);
      });
    } catch {
      // a platform without the event keeps the first answer
    }
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return reduced;
}
