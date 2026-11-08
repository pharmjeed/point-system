/**
 * C-08 صفحة الموقع (V2-012): photos (short-lived presigned links of the private bucket, read again on every visit
 * of the screen, DEC-494), the operator line «تشغيل: …» (V2-D01), open now, the week's hours, the address with
 * «فتح في الخرائط», and the prices — per visit, and the subscription prices as «قريبًا» until phase V4 sells plans
 * (DEC-506). No «اشترك» button until then: nothing in the app leads to a screen that does not exist.
 */
import type { CustomerLocationDetail } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { errorText } from '../../features/errorText';
import { hoursLines, locationDetailView } from '../../features/locations';
import { fmt } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { color, radius, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card } from '../../ui/Controls';
import { openInMaps } from '../../ui/openLinks';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';

export default function LocationDetail() {
  const { venueId } = useLocalSearchParams<{ venueId: string }>();
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [loc, setLoc] = useState<CustomerLocationDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const detail = await session.api.location(venueId);
          if (!cancelled) {
            setLoc(detail);
            setFailure(null);
          }
        } catch (e) {
          if (cancelled) return;
          setLoc(null);
          setFailure(isApiError(e, 'VENUE_NOT_LISTED') ? t.locations.notListed : errorText(e, t, locale));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [session.api, venueId, t, locale]),
  );

  const view = loc ? locationDetailView(loc, t, locale) : null;

  const maps = async () => {
    if (!loc || !view) return;
    setNotice(null);
    const ok = await openInMaps({ lat: loc.lat, lng: loc.lng, name: view.title, address: view.address });
    if (!ok) setNotice(t.locations.openInMapsFailed);
  };

  return (
    <Screen>
      <ScreenHeader
        title={view?.title ?? t.locations.title}
        backLabel={t.common.back}
        onBack={() => router.back()}
      />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      {!loc && !failure ? (
        <ActivityIndicator color={color.primary} accessibilityLabel={t.common.loading} />
      ) : null}
      {loc && view ? (
        <>
          {loc.photo_urls.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.photos}
            >
              {loc.photo_urls.map((uri, i) => (
                <Image
                  key={uri}
                  source={{ uri }}
                  style={styles.photo}
                  accessible
                  accessibilityLabel={fmt(t.locations.photo, { n: i + 1, count: loc.photo_urls.length })}
                />
              ))}
            </ScrollView>
          ) : null}
          <AppText tone="muted">{view.operator}</AppText>
          {view.openNow ? (
            <AppText variant="bodyStrong" tone={loc.open_now ? 'success' : 'danger'}>
              {view.openNow}
            </AppText>
          ) : null}

          <Card>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.locations.address}
            </AppText>
            {view.address ? <AppText>{view.address}</AppText> : null}
            {loc.lat !== null || view.address ? (
              <Button
                label={t.locations.openInMaps}
                variant="secondary"
                size="md"
                onPress={() => void maps()}
              />
            ) : null}
          </Card>

          <Card>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.locations.hours}
            </AppText>
            {hoursLines(loc.opening_hours, t, Date.now()).map((h) => (
              <View key={h.day} style={styles.hoursRow}>
                <AppText variant={h.today ? 'bodyStrong' : 'body'} style={styles.flex}>
                  {h.today ? `${h.label} (${t.locations.today})` : h.label}
                </AppText>
                <AppText variant={h.today ? 'bodyStrong' : 'body'}>{h.text}</AppText>
              </View>
            ))}
          </Card>

          <Card>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.locations.prices}
            </AppText>
            {view.prices.map((p) => (
              <View key={p.label} style={styles.hoursRow}>
                <AppText style={styles.flex}>{p.label}</AppText>
                <AppText variant="bodyStrong" tone={p.soon ? 'muted' : 'default'}>
                  {p.value}
                </AppText>
              </View>
            ))}
            <AppText variant="small" tone="muted">
              {view.subscriptionsSoon ? t.locations.soonNote : t.locations.vatNote}
            </AppText>
          </Card>
          {notice ? <Banner tone="warning">{notice}</Banner> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  photos: { gap: space[2] },
  photo: { width: 280, height: 180, borderRadius: radius.lg, backgroundColor: color.surface2 },
  hoursRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 32 },
});
