/**
 * `Skeleton` of 03 §3.14 for the customer app (V2-UX, DEC-575): grey blocks in the shape of the content that is
 * loading, gently fading (opacity only — nothing moves across the screen), instead of a lone spinner. Still under
 * reduce motion. Screen readers hear the loading label once (the group is one element).
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type DimensionValue } from 'react-native';
import { color, radius, shadow, space } from '../theme/tokens';
import { nativeDriver, useReducedMotion } from './motion';

function useBreath() {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.45, duration: 700, useNativeDriver: nativeDriver }),
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: nativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, reduced]);
  return v;
}

export function SkeletonLine({
  width = '100%',
  height = 14,
  round,
}: {
  width?: DimensionValue;
  height?: number;
  round?: boolean;
}) {
  return <View style={[styles.block, { width, height, borderRadius: round ? radius.full : radius.sm }]} />;
}

/** A card-shaped placeholder: a title line and `lines` shorter lines (and an optional round avatar). */
export function SkeletonCard({
  lines = 2,
  avatar,
  tall,
}: {
  lines?: number;
  avatar?: boolean;
  tall?: boolean;
}) {
  return (
    <View style={[styles.card, tall && styles.tall]}>
      <View style={styles.row}>
        {avatar ? <SkeletonLine width={44} height={44} round /> : null}
        <View style={styles.flex}>
          <SkeletonLine width="60%" height={18} />
          {Array.from({ length: lines }, (_, i) => (
            <SkeletonLine key={i} width={i % 2 ? '45%' : '80%'} />
          ))}
        </View>
      </View>
    </View>
  );
}

/** Several placeholders as one loading region, labelled for screen readers. */
export function SkeletonList({
  label,
  count = 3,
  lines,
  avatar,
  hero,
}: {
  label: string;
  count?: number;
  lines?: number;
  avatar?: boolean;
  /** a first, taller block (a hero card) */
  hero?: boolean;
}) {
  const opacity = useBreath();
  return (
    <Animated.View
      style={[styles.list, { opacity }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
    >
      {hero ? <SkeletonCard tall lines={3} /> : null}
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} lines={lines ?? 2} avatar={avatar} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: color.surface2 },
  list: { gap: space[3] },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    boxShadow: shadow.sm,
  },
  tall: { minHeight: 180 },
  row: { flexDirection: 'row', gap: space[3], alignItems: 'center' },
  flex: { flex: 1, gap: space[2] },
});
