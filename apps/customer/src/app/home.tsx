/**
 * C-06 الرئيسية: the big «بطاقة الدخول» button (its target C-11 is a stub until V2-013), the visit in progress
 * above everything when there is one (C-12 comes with V2-015), my subscriptions (C-14, V2-032: placeholder) and
 * the nearby locations from `GET /v1/customer/home`, each opening C-08, with «كل المواقع» (C-07), «سياراتي» (C-15)
 * and «الإعدادات» (C-19, where sign-out and C-20 live) since V2-012/V2-017.
 */
import type { CustomerHome } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorText } from '../features/errorText';
import { greeting, homeSections, locationRow, visitCard, type HomeSection } from '../features/home';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, layout, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Logo } from '../ui/Logo';

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

  if (!session.me) return null;

  const section = (s: HomeSection) => {
    if (!home) return null;
    switch (s) {
      case 'visit': {
        const card = visitCard(home, t, locale);
        return card ? (
          <Card key={s} accent>
            <AppText variant="small" tone="muted">
              {t.home.currentVisit}
            </AppText>
            <AppText variant="cardTitle">{card.status}</AppText>
            <AppText>{card.venue}</AppText>
            {card.plate ? <AppText style={styles.mono}>{card.plate}</AppText> : null}
          </Card>
        ) : null;
      }
      case 'pass':
        return (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityLabel={t.home.pass}
            accessibilityHint={t.home.passHint}
            onPress={() => router.push('/pass')}
            style={({ pressed }) => [styles.pass, pressed && { backgroundColor: color.primaryPressed }]}
            testID="home-pass"
          >
            <AppText variant="display" tone="inverse" center>
              {t.home.pass}
            </AppText>
            <AppText tone="inverse" center>
              {t.home.passHint}
            </AppText>
          </Pressable>
        );
      case 'subscriptions':
        return (
          <View key={s} style={styles.section}>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.home.subscriptions}
            </AppText>
            {home.subscriptions.length === 0 ? (
              <Card>
                <AppText tone="muted">{t.home.noSubscriptions}</AppText>
              </Card>
            ) : (
              home.subscriptions.map((sub) => (
                <Card key={sub.subscription_id}>
                  <AppText variant="bodyStrong">
                    {locale === 'en' && sub.venue_name_en ? sub.venue_name_en : sub.venue_name_ar}
                  </AppText>
                  <AppText tone="muted">{t.subscriptionStatus[sub.status]}</AppText>
                </Card>
              ))
            )}
          </View>
        );
      case 'nearby':
        return (
          <View key={s} style={styles.section}>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.home.nearby}
            </AppText>
            {home.nearby_locations.length === 0 ? (
              <Card>
                <AppText tone="muted">{t.home.noNearby}</AppText>
              </Card>
            ) : (
              home.nearby_locations.map((loc) => {
                const row = locationRow(loc, t, locale);
                return (
                  <Pressable
                    key={row.id}
                    accessibilityRole="button"
                    accessibilityLabel={row.title}
                    accessibilityHint={t.locations.details}
                    onPress={() =>
                      router.push({ pathname: '/location/[venueId]', params: { venueId: row.id } })
                    }
                    style={({ pressed }) => [styles.locationCard, pressed && styles.pressed]}
                  >
                    <AppText variant="bodyStrong">{row.title}</AppText>
                    <AppText variant="small" tone="muted">
                      {row.operator}
                    </AppText>
                    {row.facts.length ? <AppText variant="small">{row.facts.join(' · ')}</AppText> : null}
                    {row.price ? (
                      <AppText variant="small" tone="primary">
                        {row.price}
                      </AppText>
                    ) : null}
                  </Pressable>
                );
              })
            )}
            <Button
              label={t.home.allLocations}
              variant="secondary"
              size="md"
              onPress={() => router.push('/locations')}
              testID="home-locations"
            />
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topbar}>
        <Logo variant="mark" height={28} label={brand} />
        <AppText style={styles.brand}>{brand}</AppText>
        <View style={styles.flex} />
        <View>
          <Button
            label={t.home.settings}
            variant="ghost"
            size="md"
            onPress={() => router.push('/settings')}
            testID="home-settings"
          />
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading && home !== null} onRefresh={load} />}
      >
        <View style={styles.content}>
          <DevBanner />
          <AppText variant="title" accessibilityRole="header">
            {home ? greeting(home, t) : f(t.home.greetingNoName)}
          </AppText>
          {failure ? <Banner tone="danger">{`${t.home.loadFailed} ${failure}`}</Banner> : null}
          {!home && loading ? (
            <ActivityIndicator color={color.primary} accessibilityLabel={t.common.loading} />
          ) : null}
          {home ? homeSections(home).map(section) : null}
          {home ? (
            <Button
              label={home.vehicles_count === 0 ? t.home.addVehicle : t.home.myVehicles}
              variant="secondary"
              size="md"
              onPress={() =>
                home.vehicles_count === 0
                  ? router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })
                  : router.push('/vehicles')
              }
              testID="home-vehicles"
            />
          ) : null}
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
  scroll: { padding: space[4], alignItems: 'center' },
  content: { width: '100%', maxWidth: layout.shellMaxW, gap: space[3] },
  section: { gap: space[2] },
  pass: {
    minHeight: 120,
    borderRadius: radius.lg,
    backgroundColor: color.primary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
    gap: space[1],
  },
  mono: { fontFamily: font.mono },
  locationCard: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[2],
  },
  pressed: { backgroundColor: color.primarySubtle },
});
