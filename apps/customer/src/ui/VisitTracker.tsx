/**
 * The stage tracker and the timeline of C-12 (V2-UX, DEC-570).
 *
 * `StageTracker`: the six stages of the visit (received → parked → requested → bringing → ready → handed over) on one
 * line, done ones ticked, the current one breathing, the line between them filling as the car moves (animated from
 * the last position; none under reduce motion). One element for screen readers: «مراحل الزيارة» with each stage's
 * state.
 *
 * `StepTimeline`: the steps reached so far with their Riyadh times (`visitView().steps`, unchanged), drawn as the
 * design system's `Timeline` — an icon disc per step joined by a rail.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { StageState, TrackerStage } from '../features/ux';
import type { VisitStepRow } from '../features/visit';
import { useI18n } from '../i18n/I18nProvider';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { Pulse } from './Animated';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { ease, motion, useReducedMotion } from './motion';

const STAGE_ICON: Record<TrackerStage, IconName> = {
  received: 'car-front',
  parked: 'square-parking',
  requested: 'bell-ring',
  on_the_way: 'navigation',
  ready: 'circle-check',
  delivered: 'check-check',
};

const DOT = 36;

export function StageTracker({
  stages,
  progress,
}: {
  stages: readonly { stage: TrackerStage; state: StageState }[];
  progress: number;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const fill = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    if (reduced) {
      fill.setValue(progress);
      return;
    }
    const run = Animated.timing(fill, {
      toValue: progress,
      duration: motion.slow * 2,
      easing: ease.standard,
      // a width: layout, not a transform
      useNativeDriver: false,
    });
    run.start();
    return () => run.stop();
  }, [fill, progress, reduced]);
  const current = stages.findIndex((s) => s.state === 'current');
  const summary = stages.map((s) => `${t.visit.stages[s.stage]}: ${t.visit.stageState[s.state]}`).join('، ');
  // the rail runs from the centre of the first column to the centre of the last
  const inset = `${50 / stages.length}%` as const;
  return (
    <View
      style={styles.tracker}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${t.visit.tracker}: ${summary}`}
      accessibilityValue={{ min: 0, max: stages.length - 1, now: Math.max(current, 0) }}
    >
      <View style={[styles.rail, { left: inset, right: inset }]}>
        <Animated.View
          style={[
            styles.railFill,
            { width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
          ]}
        />
      </View>
      {stages.map((s) => {
        const done = s.state === 'done';
        const now = s.state === 'current';
        const disc = (
          <View style={[styles.dot, done && styles.dotDone, now && styles.dotNow]}>
            <Icon
              name={done ? 'check' : STAGE_ICON[s.stage]}
              size={18}
              tint={done || now ? color.onPrimary : color.textDisabled}
              strokeWidth={done ? 3 : 2}
            />
          </View>
        );
        return (
          <View key={s.stage} style={styles.col}>
            {now ? (
              <Pulse size={DOT} tint={color.primary}>
                {disc}
              </Pulse>
            ) : (
              disc
            )}
            <AppText
              variant="caption"
              center
              numberOfLines={2}
              style={[styles.label, now && styles.labelNow, s.state === 'todo' && styles.labelTodo]}
            >
              {t.visit.stages[s.stage]}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

export function StepTimeline({ steps }: { steps: readonly VisitStepRow[] }) {
  return (
    <View style={styles.timeline}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const done = s.state === 'done';
        const now = s.state === 'current';
        return (
          <View key={s.step} style={styles.stepRow} accessibilityRole="text">
            <View style={styles.stepRail}>
              <View style={[styles.stepDot, done && styles.stepDotDone, now && styles.stepDotNow]}>
                {done ? (
                  <Icon name="check" size={14} tint={color.onPrimary} strokeWidth={3} />
                ) : now ? (
                  <View style={styles.stepInner} />
                ) : null}
              </View>
              {last ? null : <View style={[styles.stepLine, done && styles.stepLineDone]} />}
            </View>
            <View style={styles.stepBody}>
              <AppText
                style={styles.flex}
                variant={now ? 'bodyStrong' : 'body'}
                tone={s.state === 'todo' ? 'muted' : 'default'}
              >
                {s.label}
              </AppText>
              {s.time ? <AppText style={styles.time}>{s.time}</AppText> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tracker: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space[2] },
  rail: {
    position: 'absolute',
    top: space[2] + DOT / 2 - 2,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.surface2,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  railFill: { height: 4, borderRadius: radius.full, backgroundColor: color.primary },
  col: { flex: 1, alignItems: 'center', gap: space[1] + space[0.5] },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    borderWidth: 2,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: { backgroundColor: color.success, borderColor: color.success },
  dotNow: { backgroundColor: color.primary, borderColor: color.primary },
  label: { color: color.textMuted },
  labelNow: { color: color.primaryText, fontFamily: font.bold },
  labelTodo: { color: color.textMuted },
  timeline: { gap: 0 },
  stepRow: { flexDirection: 'row', gap: space[3], minHeight: 44 },
  stepRail: { width: 24, alignItems: 'center' },
  stepDot: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotDone: { backgroundColor: color.success, borderColor: color.success },
  stepDotNow: { borderColor: color.primary },
  stepInner: { width: 10, height: 10, borderRadius: radius.full, backgroundColor: color.primary },
  stepLine: { flex: 1, width: 2, backgroundColor: color.border, marginVertical: space[0.5] },
  stepLineDone: { backgroundColor: color.success },
  stepBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[2],
    paddingBottom: space[3],
  },
  time: { fontFamily: font.mono, ...fontSize.sm, color: color.textMuted },
});
