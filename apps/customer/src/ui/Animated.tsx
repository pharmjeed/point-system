/**
 * Small motion building blocks of the customer app (V2-UX, DEC-572), all on React Native `Animated` with the
 * durations and curves of 03 §2.7, and all still under reduce motion (the final state at once):
 *
 * - `FadeIn`: a card entering — opacity 0 → 1 and 8 px up (200 ms), staggered by `index`; `swapKey` replays it when
 *   the content changes (the C-12 hero's cross-fade between states).
 * - `Pulse`: a soft ring breathing around a decorative dot (the current stage of C-12, the live chip of C-06). It
 *   never wraps a tappable element (a moving target cannot be tapped reliably).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space } from '../theme/tokens';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';

export function FadeIn({
  children,
  index = 0,
  swapKey,
  style,
}: {
  children: ReactNode;
  index?: number;
  swapKey?: string | number | null;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const run = Animated.timing(progress, {
      toValue: 1,
      duration: motion.base,
      delay: Math.min(index, 6) * 40,
      easing: ease.emphasized,
      useNativeDriver: nativeDriver,
    });
    run.start();
    return () => run.stop();
  }, [progress, reduced, index, swapKey]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [space[2], 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export function Pulse({ size, tint, children }: { size: number; tint: string; children?: ReactNode }) {
  const reduced = useReducedMotion();
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      wave.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(wave, {
        toValue: 1,
        duration: 1600,
        easing: Easing.out(Easing.quad),
        useNativeDriver: nativeDriver,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [wave, reduced]);
  return (
    <View style={[styles.pulseBox, { width: size, height: size }]} pointerEvents="none">
      {reduced ? null : (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: radius.full,
              backgroundColor: tint,
              opacity: wave.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
              transform: [{ scale: wave.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }],
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  pulseBox: { alignItems: 'center', justifyContent: 'center' },
});
