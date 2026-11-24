/**
 * The interactive picture of C-01 (owner's option 4): a blue panel with the brand mark, one scene per promise of
 * the welcome cards (park → request from the phone → subscribe and save) and a car driving along a road.
 *
 * - Each scene enters with its own motion: the car slides in under a dropping pin, the phone rises with a pulse,
 *   the saving badge pops. The main glyph then floats gently and the small car keeps driving.
 * - Tapping the picture shows the next scene (a selection haptic); the screen also advances it on a timer and from
 *   the three cards below it (welcome.tsx owns the scene index).
 * - Under reduce motion nothing moves: each scene is drawn in its final state and the car stays parked.
 *
 * Everything here is decoration of text the screen already says (the caption and the cards): the picture is one
 * button for screen readers, labelled with the current promise, and its glyphs are hidden.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Rect, Stop } from 'react-native-svg';
import { color, radius, space } from '../theme/tokens';
import { Pulse } from './Animated';
import { fromEnd, fromStart, isRTL } from './direction';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';
import { Touchable } from './Touchable';

export const WELCOME_SCENES = 3;

/** The main glyph of each scene, in the order of `t.welcome.cards`. */
const SCENE_ICONS: readonly IconName[] = ['car-front', 'smartphone', 'badge-percent'];

const HEIGHT = 290;
const ROAD = 64;
const GLYPH = 112;
const CAR = 34;
const WHITE = color.onPrimary;

/** Hidden from screen readers (the picture is one labelled button) and marked as decoration for the e2e checks. */
const DECORATION = {
  accessible: false,
  importantForAccessibility: 'no-hide-descendants',
  'aria-hidden': true,
} as const;

export function WelcomeHero({
  scene,
  onPress,
  label,
  hint,
  brand,
}: {
  scene: number;
  onPress: () => void;
  /** the current promise (the picture's label for screen readers) */
  label: string;
  hint: string;
  brand: string;
}) {
  const reduced = useReducedMotion();
  const rtl = isRTL();
  const [width, setWidth] = useState(0);

  // the entrance of the current scene (0 → 1), replayed on every change
  const enter = useRef(new Animated.Value(1)).current;
  // the gentle float of the main glyph and the drive of the small car, both looping
  const float = useRef(new Animated.Value(0)).current;
  const drive = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) {
      enter.setValue(1);
      return;
    }
    enter.setValue(0);
    const run =
      scene === 2
        ? Animated.spring(enter, { toValue: 1, friction: 5, tension: 70, useNativeDriver: nativeDriver })
        : Animated.timing(enter, {
            toValue: 1,
            duration: motion.slow * 2,
            easing: ease.emphasized,
            useNativeDriver: nativeDriver,
          });
    run.start();
    return () => run.stop();
  }, [enter, scene, reduced]);

  useEffect(() => {
    if (reduced) {
      float.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: nativeDriver,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: nativeDriver,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [float, reduced]);

  useEffect(() => {
    if (reduced || width === 0) {
      drive.setValue(0.25);
      return;
    }
    drive.setValue(0);
    const loop = Animated.loop(
      Animated.timing(drive, {
        toValue: 1,
        duration: 5200,
        easing: Easing.linear,
        useNativeDriver: nativeDriver,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [drive, reduced, width]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  // per scene: where the main glyph comes from (the car from the start side, the phone from below, the badge grows)
  const fromSide = (rtl ? -1 : 1) * -72;
  const glyphMotion =
    scene === 0
      ? [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [fromSide, 0] }) }]
      : scene === 1
        ? [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }]
        : [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }];
  const bob = { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) };

  // the small car drives in the reading direction and faces it, from the start edge of the road to its end edge,
  // fading in and out there: it never leaves the picture. It is anchored at the start edge (the right one in RTL)
  // and `translateX` is physical.
  const travel = Math.max(0, width - CAR - space[3] * 2);
  const carX = drive.interpolate({ inputRange: [0, 1], outputRange: [0, rtl ? -travel : travel] });
  const carOpacity = drive.interpolate({ inputRange: [0, 0.1, 0.9, 1], outputRange: [0, 1, 1, 0] });

  return (
    <Touchable
      onPress={onPress}
      feedback="select"
      pressScale={0.98}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID="welcome-hero"
      style={styles.panel}
    >
      <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none" {...DECORATION}>
        <Svg width="100%" height="100%" viewBox={`0 0 360 ${HEIGHT}`} preserveAspectRatio="xMidYMid slice">
          <Defs>
            <LinearGradient id="welcome-sky" x1="0" y1="0" x2="0.6" y2="1">
              <Stop offset="0" stopColor={color.focus} />
              <Stop offset="0.45" stopColor={color.primary} />
              <Stop offset="1" stopColor={color.primaryPressed} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="360" height={HEIGHT} fill="url(#welcome-sky)" />
          <Circle
            cx={rtl ? 360 : 0}
            cy="0"
            r="160"
            stroke={WHITE}
            strokeOpacity={0.14}
            strokeWidth="2"
            fill="none"
          />
          <Circle
            cx={rtl ? 360 : 0}
            cy="0"
            r="95"
            stroke={WHITE}
            strokeOpacity={0.14}
            strokeWidth="2"
            fill="none"
          />
          <Rect
            x="0"
            y={HEIGHT - ROAD}
            width="360"
            height={ROAD}
            fill={color.surfaceInverse}
            fillOpacity={0.28}
          />
          <Line
            x1="24"
            y1={HEIGHT - ROAD / 2 + 6}
            x2="336"
            y2={HEIGHT - ROAD / 2 + 6}
            stroke={WHITE}
            strokeOpacity={0.35}
            strokeWidth="4"
            strokeDasharray="10 8"
          />
        </Svg>
      </View>

      <View style={[styles.markTile, fromEnd(space[4])]} pointerEvents="none">
        <Logo variant="mark" height={34} label={brand} />
      </View>

      {/* the scene: its glyph, and the pin of «park» or the pulse of «request» */}
      <View style={styles.stage} pointerEvents="none" {...DECORATION}>
        {scene === 0 ? (
          <Animated.View
            style={{
              opacity: enter,
              transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-28, 0] }) }],
            }}
          >
            <Icon name="map-pin" size={40} tint={WHITE} strokeWidth={1.8} />
          </Animated.View>
        ) : null}
        <Animated.View style={{ opacity: enter, transform: [...glyphMotion, bob] }}>
          {scene === 1 ? (
            <Pulse size={GLYPH + 24} tint={WHITE}>
              <Icon name="smartphone" size={GLYPH - 20} tint={WHITE} strokeWidth={1.4} />
            </Pulse>
          ) : (
            <Icon name={SCENE_ICONS[scene] ?? 'car-front'} size={GLYPH} tint={WHITE} strokeWidth={1.4} />
          )}
        </Animated.View>
      </View>

      <Animated.View
        pointerEvents="none"
        {...DECORATION}
        style={[
          styles.car,
          reduced
            ? fromStart(space[6])
            : [fromStart(space[3]), { opacity: carOpacity, transform: [{ translateX: carX }] }],
        ]}
      >
        <View style={rtl ? styles.mirror : null}>
          <Icon name="car" size={CAR} tint={WHITE} strokeWidth={1.8} />
        </View>
      </Animated.View>

      <View style={styles.dots} pointerEvents="none" {...DECORATION}>
        {Array.from({ length: WELCOME_SCENES }, (_, i) => (
          <View key={i} style={[styles.dot, i === scene && styles.dotOn]} />
        ))}
      </View>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: HEIGHT,
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: color.primary,
  },
  markTile: {
    position: 'absolute',
    top: space[4],
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    paddingHorizontal: space[2],
    paddingVertical: space[2],
  },
  stage: {
    position: 'absolute',
    top: space[6],
    left: 0,
    right: 0,
    bottom: ROAD - space[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  car: { position: 'absolute', bottom: ROAD / 2 - 4 },
  mirror: { transform: [{ scaleX: -1 }] },
  dots: {
    position: 'absolute',
    bottom: space[2],
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space[1] + 2,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: WHITE, opacity: 0.45 },
  dotOn: { width: 20, opacity: 1 },
});
