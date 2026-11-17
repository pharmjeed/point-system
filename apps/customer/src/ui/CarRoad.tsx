/**
 * The road of the C-06 hero (V2-UX option B «البطاقة الحية», DEC-580): three stops — متوقفة · في الطريق · جاهزة —
 * on a thin white line across the blue, the part already driven filled in white, and a white round car that slides
 * to the current stop (`homeStop`, src/features/home.ts) when the visit moves on: 800 ms on the emphasized curve,
 * none under reduce motion (drawn at its stop at once). It starts at the start edge of the line (the right in Arabic).
 * One element for screen readers: «مسار سيارتك: سيارتك الآن: في الطريق».
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { HOME_STOPS } from '../features/home';
import { fmt } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { color, font, fontSize, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { fromStart, isRTL } from './direction';
import { Icon } from './Icon';
import { ease, useReducedMotion } from './motion';

const CAR = 36;
const DOT = 12;
const LINE = 3;
/** the line runs between the centres of the first and the last stop */
const LINE_INSET = CAR / 2;

export function CarRoad({ stop }: { stop: number }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const rtl = isRTL();
  const [width, setWidth] = useState(0);
  const target = stop / (HOME_STOPS.length - 1);
  const progress = useRef(new Animated.Value(target)).current;

  useEffect(() => {
    if (reduced) {
      progress.setValue(target);
      return;
    }
    const run = Animated.timing(progress, {
      toValue: target,
      duration: 800,
      easing: ease.emphasized,
      // a width and a translation from one value: the JS driver (react-native-web has no other)
      useNativeDriver: false,
    });
    run.start();
    return () => run.stop();
  }, [progress, target, reduced]);

  const span = Math.max(0, width - CAR);
  const carX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, rtl ? -span : span] });
  const fillW = progress.interpolate({ inputRange: [0, 1], outputRange: [0, span] });
  const stopName = t.home.stops[HOME_STOPS[stop] ?? 'parked'];

  return (
    <View
      style={styles.road}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${t.home.road}: ${fmt(t.home.stopNow, { stop: stopName })}`}
      accessibilityValue={{ min: 0, max: HOME_STOPS.length - 1, now: stop }}
    >
      <View style={styles.track} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <View style={styles.line} />
        <Animated.View style={[styles.fill, fromStart(LINE_INSET), { width: fillW }]} />
        {width > 0
          ? HOME_STOPS.map((s, i) => (
              <View
                key={s}
                style={[
                  styles.dot,
                  fromStart(CAR / 2 - DOT / 2 + (span * i) / (HOME_STOPS.length - 1)),
                  i <= stop && styles.dotDone,
                ]}
              />
            ))
          : null}
        <Animated.View style={[styles.car, fromStart(0), { transform: [{ translateX: carX }] }]}>
          <Icon name="car" size={20} tint={color.primary} />
        </Animated.View>
      </View>
      <View style={styles.labels}>
        {HOME_STOPS.map((s, i) => (
          <AppText key={s} style={[styles.label, i === stop && styles.labelNow]}>
            {t.home.stops[s]}
          </AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  road: { marginTop: space[5], gap: space[1] },
  track: { height: CAR, justifyContent: 'center' },
  line: {
    position: 'absolute',
    left: LINE_INSET,
    right: LINE_INSET,
    height: LINE,
    borderRadius: radius.full,
    backgroundColor: color.onPrimary,
    opacity: 0.3,
  },
  fill: { position: 'absolute', height: LINE, borderRadius: radius.full, backgroundColor: color.onPrimary },
  dot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: color.onPrimary,
    backgroundColor: color.primary,
  },
  dotDone: { backgroundColor: color.onPrimary },
  car: {
    position: 'absolute',
    width: CAR,
    height: CAR,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.md,
  },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { ...fontSize.xs, fontFamily: font.medium, color: color.onPrimary, opacity: 0.85 },
  labelNow: { fontFamily: font.bold, opacity: 1 },
});
