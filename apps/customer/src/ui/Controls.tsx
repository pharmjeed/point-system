/**
 * Small controls of 03 §3.9 / §3.10 / §3.14 for the customer app: `Checkbox`, `ChoiceChips`, `Banner`, `Card`.
 * Touch targets ≥ 44 (03 §5); state is never shown by colour alone (a tick, a border, text).
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { color, font, fontSize, layout, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

export function Checkbox({
  label,
  checked,
  onChange,
  detail,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  detail?: ReactNode;
}) {
  return (
    <View style={styles.checkRow}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={label}
        onPress={() => onChange(!checked)}
        hitSlop={8}
        style={styles.checkPress}
      >
        <View style={[styles.box, checked && styles.boxOn]}>
          {checked ? <AppText style={styles.tick}>✓</AppText> : null}
        </View>
        <View style={styles.flex}>
          <AppText>{label}</AppText>
        </View>
      </Pressable>
      {detail}
    </View>
  );
}

export function ChoiceChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (next: T | null) => void;
}) {
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <AppText variant="label">{label}</AppText>
      <View style={styles.chips}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(selected ? null : o.value)}
              style={[styles.chip, selected && styles.chipOn]}
            >
              <AppText variant="small" style={selected ? styles.chipTextOn : undefined}>
                {selected ? `✓ ${o.label}` : o.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'danger' | 'success' | 'warning';
  children: ReactNode;
}) {
  const palette = {
    info: { bg: color.infoSubtle, fg: color.infoText },
    danger: { bg: color.dangerSubtle, fg: color.dangerText },
    success: { bg: color.successSubtle, fg: color.successText },
    warning: { bg: color.warningSubtle, fg: color.warningText },
  }[tone];
  return (
    <View
      style={[styles.banner, { backgroundColor: palette.bg }]}
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
    >
      <AppText variant="small" style={{ color: palette.fg }}>
        {children}
      </AppText>
    </View>
  );
}

export function Card({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <View style={[styles.card, accent && styles.cardAccent]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  checkRow: { gap: space[1] },
  checkPress: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: layout.touchMin },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.xs,
    borderWidth: 2,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
  },
  boxOn: { backgroundColor: color.primary, borderColor: color.primary },
  tick: { color: color.onPrimary, fontFamily: font.bold, ...fontSize.sm },
  group: { gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    minHeight: layout.touchMin,
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: color.primarySubtle, borderColor: color.primary, borderWidth: 2 },
  chipTextOn: { color: color.primaryText, fontFamily: font.semibold },
  banner: { borderRadius: radius.md, padding: space[3] },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[2],
  },
  cardAccent: { borderColor: color.primary, borderWidth: 2 },
});
