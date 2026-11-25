/**
 * The head of the sign-in steps C-02 … C-05 (V2-UX, DEC-576): the step's icon in a soft disc, the screen title (the
 * one header) and its hint, and four progress dots of journey R1 (decorative: the title says where the customer is).
 */
import { StyleSheet, View } from 'react-native';
import { color, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { IconBadge } from './Controls';
import type { IconName } from './Icon';

const R1_STEPS = 4;

export function StepHeader({
  icon,
  title,
  hint,
  step,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  /** 1 … 4: phone, code, name, car */
  step?: number;
}) {
  return (
    <View style={styles.wrap}>
      {step ? <StepDots step={step} /> : null}
      <IconBadge name={icon} size={64} />
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      {hint ? <AppText tone="muted">{hint}</AppText> : null}
    </View>
  );
}

/** The four progress dots of journey R1 alone (C-04 draws its own head, DEC-637). Decorative. */
export function StepDots({ step }: { step: number }) {
  return (
    <View style={styles.dots} accessible={false} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: R1_STEPS }, (_, i) => (
        <View key={i} style={[styles.dot, i < step && styles.dotOn, i === step - 1 && styles.dotNow]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[3], paddingTop: space[2], paddingBottom: space[2] },
  dots: { flexDirection: 'row', gap: space[1] + space[0.5] },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: color.border },
  dotOn: { backgroundColor: color.primary },
  dotNow: { width: 24 },
});
