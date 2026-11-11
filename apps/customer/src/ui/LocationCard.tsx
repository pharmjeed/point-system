/**
 * A location in a list (C-06 «أقرب المواقع», C-07) — V2-UX (DEC-577): the name and operator beside a building badge,
 * then chips (open now / closed, the distance, «يقبل الاشتراك», «مشترك» when the account subscribes there) and the
 * «from» price with a chevron at the end. The whole card opens C-08; «فتح في الخرائط» (C-07) stays its own button
 * under it. Texts are `locationRow`'s (features/home.ts), unchanged.
 */
import type { CustomerLocationSummary } from '@point/shared/customer';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LocationRow } from '../features/home';
import { isolate } from '../i18n';
import { formatDistance } from '../i18n/format';
import { useI18n } from '../i18n/I18nProvider';
import { color, font, fontSize, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { IconBadge } from './Controls';
import { Icon, type IconName } from './Icon';
import { Touchable } from './Touchable';

function Chip({
  label,
  icon,
  tone,
}: {
  label: string;
  icon?: IconName;
  tone: 'success' | 'danger' | 'info' | 'neutral' | 'primary';
}) {
  const palette = {
    success: { bg: color.successSubtle, fg: color.successText },
    danger: { bg: color.dangerSubtle, fg: color.dangerText },
    info: { bg: color.infoSubtle, fg: color.infoText },
    neutral: { bg: color.surface2, fg: color.textMuted },
    primary: { bg: color.primary, fg: color.onPrimary },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg }]}>
      {icon ? <Icon name={icon} size={14} tint={palette.fg} /> : null}
      <AppText style={[styles.chipText, { color: palette.fg }]}>{label}</AppText>
    </View>
  );
}

export function LocationCard({
  loc,
  row,
  subscribed,
  onPress,
  accessibilityLabel,
  footer,
}: {
  loc: CustomerLocationSummary;
  row: LocationRow;
  subscribed?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  /** under the card, outside its tap target (C-07 «فتح في الخرائط») */
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.card}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={t.locations.details}
        onPress={onPress}
        style={({ pressed }) => [styles.press, pressed && { backgroundColor: color.primarySubtle }]}
      >
        <View style={styles.head}>
          <IconBadge name="building" size={44} />
          <View style={styles.flex}>
            <AppText variant="bodyStrong" numberOfLines={2}>
              {row.title}
            </AppText>
            <AppText variant="small" tone="muted" numberOfLines={1}>
              {row.operator}
            </AppText>
          </View>
        </View>
        <View style={styles.chips}>
          {subscribed ? (
            <Chip label={t.locations.subscribedBadge} icon="badge-percent" tone="primary" />
          ) : null}
          {loc.open_now !== null ? (
            <Chip
              label={loc.open_now ? t.home.openNow : t.home.closedNow}
              icon="clock"
              tone={loc.open_now ? 'success' : 'danger'}
            />
          ) : null}
          {loc.distance_m !== null ? (
            <Chip label={isolate(formatDistance(loc.distance_m, t))} icon="map-pin" tone="neutral" />
          ) : null}
          {loc.subscriptions_enabled && !subscribed ? (
            <Chip label={t.home.subscriptionsAvailable} icon="calendar-check" tone="info" />
          ) : null}
        </View>
        <View style={styles.foot}>
          {row.price ? (
            <AppText variant="smallStrong" tone="primary" style={styles.flex}>
              {row.price}
            </AppText>
          ) : (
            <View style={styles.flex} />
          )}
          <Icon name="go" size={20} tint={color.textMuted} />
        </View>
      </Touchable>
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    overflow: 'hidden',
    boxShadow: shadow.sm,
  },
  press: { padding: space[4], gap: space[3] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.full,
  },
  chipText: { ...fontSize.xs, fontFamily: font.semibold },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
});
