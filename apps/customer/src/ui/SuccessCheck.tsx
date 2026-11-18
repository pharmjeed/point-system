/**
 * The success mark of the customer app (V2-UX, DEC-579): a green disc that springs in with its check, and a ring
 * that spreads once behind it — after the server confirmed a payment or a subscription. Drawn at rest under reduce
 * motion. Decorative: the sentence next to it says what happened.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { color, radius } from '../theme/tokens';
import { Icon } from './Icon';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';

export function SuccessCheck({ size = 88 }: { size?: number }) {
  const reduced = useReducedMotion();
  const pop = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ring = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    Animated.parallel([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: nativeDriver }),
      Animated.timing(ring, {
        toValue: 1,
        duration: motion.slow * 2,
        easing: ease.standard,
        useNativeDriver: nativeDriver,
      }),
    ]).start();
  }, [pop, ring, reduced]);
  return (
    <View style={[styles.box, { width: size, height: size }]} pointerEvents="none">
      {reduced ? null : (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.ring,
            {
              opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }),
              transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.5] }) }],
            },
          ]}
        />
      )}
      <Animated.View
        style={[styles.disc, { width: size, height: size, opacity: pop, transform: [{ scale: pop }] }]}
      >
        <Icon name="check" size={Math.round(size * 0.5)} tint={color.onPrimary} strokeWidth={3} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  ring: { borderRadius: radius.full, backgroundColor: color.success },
  disc: {
    borderRadius: radius.full,
    backgroundColor: color.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
