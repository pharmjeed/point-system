/**
 * C-16 زياراتي (V2-015): the account's visits across locations, newest first (`GET /v1/customer/visits`, keyset pages
 * with «عرض المزيد»): the day and time, the location, the state or the duration, the amount, rated or not. A row
 * opens C-12 (its live state, photos while kept, the rating).
 */
import type { CustomerVisitSummary } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { errorText } from '../features/errorText';
import { visitRow } from '../features/visit';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, shadow, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, IconBadge } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { Screen } from '../ui/Screen';
import { SkeletonList } from '../ui/Skeleton';
import { Touchable } from '../ui/Touchable';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function Visits() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerVisitSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const page = await session.api.visits(cursor ? { cursor } : {});
        setItems((prev) => {
          const base = cursor ? (prev ?? []) : [];
          const seen = new Set(base.map((v) => v.ticket_id));
          return [...base, ...page.items.filter((v) => !seen.has(v.ticket_id))];
        });
        setNext(page.nextCursor);
        setFailure(null);
      } catch (e) {
        setFailure(`${t.visits.loadFailed} ${errorText(e, t, locale)}`);
      } finally {
        setLoading(false);
      }
    },
    [session.api, t, locale],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <ScreenHeader title={t.visits.title} backLabel={t.visits.back} onBack={() => router.back()} />
      <DevBanner />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      {!items && loading ? <SkeletonList label={t.common.loading} count={4} avatar /> : null}
      {items && items.length === 0 ? <EmptyState icon="history" text={t.visits.empty} /> : null}
      {items?.map((v) => {
        const row = visitRow(v, t, locale);
        return (
          <Touchable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`${row.title} ${row.subtitle}`}
            onPress={() => router.push({ pathname: '/visit/[ticketId]', params: { ticketId: row.id } })}
            style={({ pressed }) => [styles.row, row.open && styles.rowOpen, pressed && styles.pressed]}
          >
            <IconBadge
              name={row.open ? 'car-front' : 'check-check'}
              tint={row.open ? color.primaryText : color.textMuted}
              bg={row.open ? color.primarySubtle : color.surface2}
            />
            <View style={styles.flex}>
              <AppText variant="bodyStrong">{row.title}</AppText>
              <AppText variant="small" tone="muted">
                {row.subtitle}
              </AppText>
              {row.facts.length ? <AppText variant="small">{row.facts.join(' · ')}</AppText> : null}
            </View>
            <Icon name="go" size={20} tint={color.textMuted} />
          </Touchable>
        );
      })}
      {next ? (
        <Button
          label={t.visits.loadMore}
          variant="secondary"
          size="md"
          loading={loading}
          loadingLabel={t.common.loading}
          onPress={() => void load(next)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[3],
    boxShadow: shadow.sm,
  },
  rowOpen: { borderColor: color.primary, borderWidth: 2 },
  pressed: { backgroundColor: color.primarySubtle },
});
