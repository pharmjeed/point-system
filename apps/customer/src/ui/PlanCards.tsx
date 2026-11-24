/**
 * «اختر باقتك» of C-08 (owner's option 1, DEC-640): one card per way to subscribe, the price **a day** large and the
 * amount paid under it; «الأوفر · وفّر n%» on the best value; the saving against paying per visit in green; a sold-out
 * plan greyed with «اكتملت المقاعد». The chosen card has a 2.5 px primary border and a filled radio (never colour
 * alone). Under the cards, the per-visit price struck through, and what «لليوم» is based on.
 */
import { StyleSheet, View } from 'react-native';
import type { PlanChoice } from '../features/pricing';
import { color, font, fontSize, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { fromStart } from './direction';
import { Touchable } from './Touchable';

export function PlanCards({
  title,
  choices,
  selected,
  onSelect,
  perDay,
  soldOut,
  withoutSub,
  basis,
}: {
  title: string;
  choices: readonly PlanChoice[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** «لليوم» */
  perDay: string;
  soldOut: string;
  /** «بدون اشتراك» and «25.00 ر.س لكل زيارة», when the place has a per-visit price */
  withoutSub: { label: string; price: string } | null;
  basis: string;
}) {
  return (
    <View style={styles.wrap}>
      <AppText variant="cardTitle" accessibilityRole="header">
        {title}
      </AppText>
      <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.cards}>
        {choices.map((c) => {
          const on = c.key === selected;
          return (
            <Touchable
              key={c.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, selected: on, disabled: c.soldOut }}
              accessibilityLabel={[c.title, `${c.perDay} ${perDay}`, c.total, c.badge, c.saves]
                .filter(Boolean)
                .join('، ')}
              disabled={c.soldOut}
              onPress={() => onSelect(c.key)}
              feedback="select"
              pressScale={0.98}
              testID={`plan-${c.cycle}-${c.planId}`}
              style={[styles.card, on && styles.cardOn, c.soldOut && styles.cardOff]}
            >
              {c.badge ? (
                <View style={[styles.badge, fromStart(space[4])]}>
                  <AppText variant="caption" style={styles.badgeText}>
                    {c.badge}
                  </AppText>
                </View>
              ) : null}
              <View style={styles.head}>
                <View style={[styles.radio, on && styles.radioOn]}>
                  {on ? <View style={styles.dot} /> : null}
                </View>
                <AppText variant="bodyStrong" style={styles.flex}>
                  {c.title}
                </AppText>
                {c.soldOut ? (
                  <AppText variant="smallStrong" tone="danger">
                    {soldOut}
                  </AppText>
                ) : null}
              </View>
              <View style={styles.inner}>
                <View style={styles.dayRow}>
                  <AppText style={styles.day}>{c.perDay}</AppText>
                  <AppText tone="muted">{perDay}</AppText>
                </View>
                <AppText variant="small" tone="muted">
                  {c.total}
                </AppText>
                {c.saves ? (
                  <View style={styles.saves}>
                    <AppText variant="smallStrong" tone="success">
                      {c.saves}
                    </AppText>
                  </View>
                ) : null}
              </View>
            </Touchable>
          );
        })}
      </View>
      {withoutSub ? (
        <View style={styles.strip}>
          <AppText variant="small" tone="muted" style={styles.flex}>
            {withoutSub.label}
          </AppText>
          <AppText variant="smallStrong" style={styles.struck}>
            {withoutSub.price}
          </AppText>
        </View>
      ) : null}
      <AppText variant="small" tone="muted">
        {basis}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[3] },
  flex: { flex: 1 },
  cards: { gap: space[4], paddingTop: space[2] },
  card: {
    padding: space[4],
    gap: space[2],
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  cardOn: {
    borderWidth: 2.5,
    borderColor: color.primary,
    backgroundColor: color.primarySubtle,
    boxShadow: shadow.md,
  },
  cardOff: { opacity: 0.55 },
  badge: {
    position: 'absolute',
    top: -12,
    paddingHorizontal: space[3],
    paddingVertical: space[0.5],
    borderRadius: radius.md,
    backgroundColor: color.success,
  },
  badgeText: { color: color.onPrimary, fontFamily: font.bold },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  radio: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.primary, backgroundColor: color.primary },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: color.onPrimary },
  inner: { gap: space[1], paddingStart: space[8] + space[0.5] },
  dayRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  day: { fontFamily: font.bold, ...fontSize['3xl'], color: color.text },
  saves: {
    alignSelf: 'flex-start',
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.sm,
    backgroundColor: color.successSubtle,
    marginTop: space[1],
  },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  struck: { textDecorationLine: 'line-through', textDecorationColor: color.danger },
});
