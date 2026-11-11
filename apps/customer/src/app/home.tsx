/**
 * C-06 الرئيسية: the big «بطاقة الدخول» button (C-11), the visit in progress above everything when there is one —
 * it opens C-12 and follows the customer socket (V2-015) — my subscriptions (each opening C-14, V2-032) and
 * the nearby locations from `GET /v1/customer/home`, each opening C-08, with «كل المواقع» (C-07), «سياراتي» (C-15)
 * and «الإعدادات» (C-19, where sign-out and C-20 live) since V2-012/V2-017, and «زياراتي» (C-16, V2-015).
 *
 * V2-UX (DEC-576): a greeting with the time of day; the visit in progress as a navy card with its live status chip
 * and plate; the entry pass as the one big blue action; a row of quick actions with icons (cars, visits,
 * subscriptions, invoices — C-15, C-16, C-14, C-17); subscription cards with their renewal date; location cards;
 * skeletons while the first read is on its way. Same sections and order (`homeSections`).
 */
import type { CustomerHome } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorText } from '../features/errorText';
import { greeting, homeSections, locationRow, visitCard, type HomeSection } from '../features/home';
import { dayPart, homeSubscriptionLine } from '../features/ux';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, layout, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from '../ui/Animated';
import { AppText } from '../ui/AppText';
import { Banner, IconBadge, SectionTitle } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { EmptyState } from '../ui/EmptyState';
import { Icon, type IconName } from '../ui/Icon';
import { LocationCard } from '../ui/LocationCard';
import { Logo } from '../ui/Logo';
import { PlateBadge } from '../ui/PlateBadge';
import { IconButton } from '../ui/ScreenHeader';
import { SkeletonList } from '../ui/Skeleton';
import { StatusChip } from '../ui/StatusChip';
import { Touchable } from '../ui/Touchable';

function QuickAction({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      containerStyle={styles.quickBox}
      style={({ pressed }) => [styles.quick, pressed && { backgroundColor: color.primarySubtle }]}
    >
      <IconBadge name={icon} size={44} />
      <AppText variant="caption" center numberOfLines={2} style={styles.quickLabel}>
        {label}
      </AppText>
    </Touchable>
  );
}

export default function Home() {
  const { t, f, locale, brand } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [home, setHome] = useState<CustomerHome | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setHome(await session.api.home());
      setFailure(null);
    } catch (e) {
      setFailure(errorText(e, t, locale));
    } finally {
      setLoading(false);
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // V2-015: the visit card follows the customer socket (and every reconnection reads home again)
  useEffect(
    () =>
      session.events.subscribe({
        onVisit: () => void load(),
        onSubscription: () => void load(),
        onResync: () => void load(),
      }),
    [session.events, load],
  );

  if (!session.me) return null;

  const subscribedVenues = new Set(home?.subscriptions.map((s) => s.venue_id) ?? []);

  const section = (s: HomeSection, i: number) => {
    if (!home) return null;
    switch (s) {
      case 'visit': {
        const card = visitCard(home, t, locale);
        const v = home.current_visit;
        return card && v ? (
          <FadeIn key={s} index={i} swapKey={v.status}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`${t.home.currentVisit} ${card.status}`}
              accessibilityHint={t.home.openVisit}
              onPress={() =>
                router.push({ pathname: '/visit/[ticketId]', params: { ticketId: v.ticket_id } })
              }
              style={({ pressed }) => [styles.visitCard, pressed && styles.visitPressed]}
              testID="home-visit"
            >
              <View style={styles.visitHead}>
                <AppText variant="small" style={styles.onNavyMuted}>
                  {t.home.currentVisit}
                </AppText>
                <StatusChip status={v.status} label={card.status} live />
              </View>
              <View style={styles.visitPlace}>
                <Icon name="map-pin" size={20} tint={color.textOnInverseMuted} />
                <AppText variant="cardTitle" style={[styles.onNavy, styles.flex]}>
                  {card.venue}
                </AppText>
              </View>
              <View style={styles.visitFoot}>
                {card.plate ? <PlateBadge plate={card.plate} /> : <View />}
                <View style={styles.visitOpen}>
                  <AppText variant="smallStrong" style={styles.onNavyLink}>
                    {t.home.openVisit}
                  </AppText>
                  <Icon name="go" size={18} tint={color.primaryOnInverse} />
                </View>
              </View>
            </Touchable>
          </FadeIn>
        ) : null;
      }
      case 'pass':
        return (
          <FadeIn key={s} index={i}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t.home.pass}
              accessibilityHint={t.home.passHint}
              onPress={() => router.push('/pass')}
              feedback="tap"
              style={({ pressed }) => [styles.pass, pressed && { backgroundColor: color.primaryPressed }]}
              testID="home-pass"
            >
              <View style={styles.passIcon}>
                <Icon name="qr-code" size={36} tint={color.primary} />
              </View>
              <View style={styles.flex}>
                <AppText variant="title" tone="inverse">
                  {t.home.pass}
                </AppText>
                <AppText variant="small" tone="inverse">
                  {t.home.passHint}
                </AppText>
              </View>
              <Icon name="go" size={24} tint={color.onPrimary} />
            </Touchable>
          </FadeIn>
        );
      case 'subscriptions':
        return (
          <FadeIn key={s} index={i} style={styles.section}>
            <SectionTitle>{t.home.subscriptions}</SectionTitle>
            {home.subscriptions.length === 0 ? (
              <EmptyState icon="calendar-check" text={t.home.noSubscriptions} compact />
            ) : (
              home.subscriptions.map((sub) => {
                const title = locale === 'en' && sub.venue_name_en ? sub.venue_name_en : sub.venue_name_ar;
                const active = sub.status === 'active';
                return (
                  <Touchable
                    key={sub.subscription_id}
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    onPress={() => router.push('/subscriptions')}
                    style={({ pressed }) => [styles.listCard, pressed && styles.pressed]}
                  >
                    <IconBadge
                      name="calendar-check"
                      tint={active ? color.successText : color.warningText}
                      bg={active ? color.successSubtle : color.warningSubtle}
                    />
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong">{title}</AppText>
                      <AppText variant="small" tone="muted">
                        {`${t.subscribe[sub.billing_cycle]} · ${t.subscriptionStatus[sub.status]}`}
                      </AppText>
                      <AppText variant="small" tone={active ? 'success' : 'default'}>
                        {homeSubscriptionLine(sub, t)}
                      </AppText>
                    </View>
                    <Icon name="go" size={20} tint={color.textMuted} />
                  </Touchable>
                );
              })
            )}
          </FadeIn>
        );
      case 'nearby':
        return (
          <FadeIn key={s} index={i} style={styles.section}>
            <SectionTitle>{t.home.nearby}</SectionTitle>
            {home.nearby_locations.length === 0 ? (
              <EmptyState icon="map-pin" text={t.home.noNearby} compact />
            ) : (
              home.nearby_locations.map((loc) => {
                const row = locationRow(loc, t, locale);
                return (
                  <LocationCard
                    key={row.id}
                    loc={loc}
                    row={row}
                    subscribed={subscribedVenues.has(loc.venue_id)}
                    accessibilityLabel={row.title}
                    onPress={() =>
                      router.push({ pathname: '/location/[venueId]', params: { venueId: row.id } })
                    }
                  />
                );
              })
            )}
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t.home.allLocations}
              onPress={() => router.push('/locations')}
              testID="home-locations"
              style={({ pressed }) => [styles.allLocations, pressed && styles.pressed]}
            >
              <Icon name="map" size={20} tint={color.primaryText} />
              <AppText variant="label" tone="primary">
                {t.home.allLocations}
              </AppText>
            </Touchable>
          </FadeIn>
        );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topbar}>
        <Logo variant="mark" height={28} label={brand} />
        <AppText style={styles.brand}>{brand}</AppText>
        <View style={styles.flex} />
        <IconButton
          icon="settings"
          label={t.home.settings}
          onPress={() => router.push('/settings')}
          testID="home-settings"
          tone="plain"
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading && home !== null} onRefresh={load} />}
      >
        <View style={styles.content}>
          <DevBanner />
          <View style={styles.greeting}>
            <AppText variant="small" tone="muted">
              {t.home[dayPart(Date.now())]}
            </AppText>
            <AppText variant="title" accessibilityRole="header">
              {home ? greeting(home, t) : f(t.home.greetingNoName)}
            </AppText>
          </View>
          {failure ? <Banner tone="danger">{`${t.home.loadFailed} ${failure}`}</Banner> : null}
          {!home && loading ? <SkeletonList label={t.common.loading} hero count={2} /> : null}
          {home
            ? homeSections(home).flatMap((s, i) =>
                s === 'pass'
                  ? [
                      section(s, i),
                      <FadeIn key="quick" index={i + 1}>
                        <View
                          style={styles.quickRow}
                          accessibilityRole="toolbar"
                          accessibilityLabel={t.home.quickActions}
                        >
                          <QuickAction
                            icon={home.vehicles_count === 0 ? 'plus' : 'car'}
                            label={home.vehicles_count === 0 ? t.home.addVehicle : t.home.myVehicles}
                            onPress={() =>
                              home.vehicles_count === 0
                                ? router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })
                                : router.push('/vehicles')
                            }
                            testID="home-vehicles"
                          />
                          <QuickAction
                            icon="history"
                            label={t.home.myVisits}
                            onPress={() => router.push('/visits')}
                            testID="home-visits"
                          />
                          <QuickAction
                            icon="calendar-check"
                            label={t.home.subscriptions}
                            onPress={() => router.push('/subscriptions')}
                          />
                          <QuickAction
                            icon="receipt"
                            label={t.settings.invoices}
                            onPress={() => router.push('/invoices')}
                          />
                        </View>
                      </FadeIn>,
                    ]
                  : [section(s, i)],
              )
            : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  topbar: {
    height: layout.topbarH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    backgroundColor: color.surface,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  brand: { fontFamily: font.bold, ...fontSize.lg },
  scroll: { padding: space[4], paddingBottom: space[8], alignItems: 'center' },
  content: { width: '100%', maxWidth: layout.shellMaxW, gap: space[4] },
  greeting: { gap: 0 },
  section: { gap: space[3] },
  pass: {
    minHeight: 104,
    borderRadius: radius.xl,
    backgroundColor: color.primary,
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[4],
    gap: space[4],
    boxShadow: shadow.lg,
  },
  passIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickRow: { flexDirection: 'row', gap: space[2] },
  quickBox: { flex: 1 },
  quick: {
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[3],
    paddingHorizontal: space[1],
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
    minHeight: 96,
  },
  quickLabel: { color: color.text, ...fontSize.xs, fontFamily: font.semibold },
  listCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    boxShadow: shadow.sm,
  },
  pressed: { backgroundColor: color.primarySubtle },
  visitCard: {
    backgroundColor: color.surfaceInverse,
    borderRadius: radius.xl,
    padding: space[4],
    gap: space[2],
    boxShadow: shadow.lg,
  },
  visitPressed: { opacity: 0.92 },
  visitHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  visitPlace: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  visitFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    marginTop: space[1],
  },
  visitOpen: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  onNavy: { color: color.textOnInverse },
  onNavyMuted: { color: color.textOnInverseMuted },
  onNavyLink: { color: color.primaryOnInverse },
  allLocations: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: space[12],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
});
