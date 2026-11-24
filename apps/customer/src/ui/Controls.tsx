/**
 * Small controls of 03 §3.9 / §3.10 / §3.14 for the customer app: `Checkbox`, `ChoiceChips`, `Banner`, `Card`,
 * `IconBadge`, `SectionTitle`. Touch targets ≥ 48 (V2-UX, DEC-575); state is never shown by colour alone (a tick,
 * a border, text). V2-UX: cards carry the `sm` shadow with their border (03 §2.5), banners an icon and a soft
 * entrance, chips a check icon and a selection haptic.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, font, fontSize, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from './Animated';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { Touchable } from './Touchable';

const TOUCH = space[12];

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
      <Touchable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={label}
        onPress={() => onChange(!checked)}
        feedback="select"
        pressScale={1}
        hitSlop={8}
        style={styles.checkPress}
      >
        <View style={[styles.box, checked && styles.boxOn]}>
          {checked ? <AppText style={styles.tick}>✓</AppText> : null}
        </View>
        <View style={styles.flex}>
          <AppText>{label}</AppText>
        </View>
      </Touchable>
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
            <Touchable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              onPress={() => onChange(selected ? null : o.value)}
              feedback="select"
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipOn,
                pressed && !selected && { backgroundColor: color.surface2 },
              ]}
            >
              {selected ? <Icon name="check" size={16} tint={color.onPrimary} /> : null}
              <AppText variant="small" style={selected ? styles.chipTextOn : styles.chipText}>
                {o.label}
              </AppText>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * `SegmentedControl` of 03 §3.9 (V2-UX): two or three exclusive choices sharing one rounded track (the cycle of C-09,
 * list/map of C-07); radios for screen readers, an optional badge on a segment (the yearly saving).
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  hideLabel,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; badge?: string | null }>;
  value: T;
  onChange: (next: T) => void;
  hideLabel?: boolean;
}) {
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {hideLabel ? null : <AppText variant="label">{label}</AppText>}
      <View style={styles.track}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Touchable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              onPress={() => onChange(o.value)}
              feedback="select"
              pressScale={1}
              containerStyle={styles.flex}
              style={[styles.segment, selected && styles.segmentOn]}
            >
              <AppText variant="label" style={selected ? styles.segmentTextOn : styles.segmentText}>
                {o.label}
              </AppText>
              {o.badge ? (
                <View style={[styles.segmentBadge, selected && styles.segmentBadgeOn]}>
                  <AppText variant="caption" style={selected ? styles.badgeTextOn : styles.badgeText}>
                    {o.badge}
                  </AppText>
                </View>
              ) : null}
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

const BANNER_ICON: Record<'info' | 'danger' | 'success' | 'warning', IconName> = {
  info: 'info',
  danger: 'circle-alert',
  success: 'circle-check',
  warning: 'triangle-alert',
};

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
    <FadeIn swapKey={typeof children === 'string' ? children : null}>
      <View
        style={[styles.banner, { backgroundColor: palette.bg }]}
        accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
        accessibilityLiveRegion="polite"
      >
        <Icon name={BANNER_ICON[tone]} size={20} tint={palette.fg} />
        <View style={styles.flex}>
          <AppText variant="small" style={[styles.bannerText, { color: palette.fg }]}>
            {children}
          </AppText>
        </View>
      </View>
    </FadeIn>
  );
}

export function Card({
  children,
  accent,
  style,
}: {
  children: ReactNode;
  accent?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, accent && styles.cardAccent, style]}>{children}</View>;
}

/** A round tinted badge holding an icon (lists, quick actions, empty states). */
export function IconBadge({
  name,
  size = 44,
  tint = color.primaryText,
  bg = color.primarySubtle,
}: {
  name: IconName;
  size?: number;
  tint?: string;
  bg?: string;
}) {
  return (
    <View style={[styles.iconBadge, { width: size, height: size, backgroundColor: bg }]}>
      <Icon name={name} size={Math.round(size * 0.5)} tint={tint} />
    </View>
  );
}

/** A section heading of a scrolling screen, with an optional action at its end. */
export function SectionTitle({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <AppText variant="cardTitle" accessibilityRole="header" style={styles.flex}>
        {children}
      </AppText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  checkRow: { gap: space[1] },
  checkPress: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: TOUCH },
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
  tick: { color: color.onPrimary, fontFamily: font.bold, ...fontSize.sm, textAlign: 'center' },
  group: { gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    minHeight: TOUCH,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1] + space[0.5],
    boxShadow: shadow.sm,
  },
  chipOn: { backgroundColor: color.primary, borderColor: color.primary },
  chipText: { color: color.text, fontFamily: font.medium },
  chipTextOn: { color: color.onPrimary, fontFamily: font.semibold },
  banner: {
    borderRadius: radius.md,
    padding: space[3],
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[2],
  },
  bannerText: { fontFamily: font.medium },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[2],
    boxShadow: shadow.sm,
  },
  cardAccent: { borderColor: color.primary, borderWidth: 2, boxShadow: shadow.md },
  track: {
    flexDirection: 'row',
    padding: space[1],
    gap: space[1],
    borderRadius: radius.lg,
    backgroundColor: color.surface2,
  },
  segment: {
    minHeight: TOUCH,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
  },
  segmentOn: { backgroundColor: color.surface, boxShadow: shadow.sm },
  segmentText: { color: color.textMuted },
  segmentTextOn: { color: color.text },
  segmentBadge: {
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.full,
    backgroundColor: color.successSubtle,
  },
  segmentBadgeOn: { backgroundColor: color.success },
  badgeText: { color: color.successText },
  badgeTextOn: { color: color.onPrimary },
  iconBadge: { borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginTop: space[2] },
});
