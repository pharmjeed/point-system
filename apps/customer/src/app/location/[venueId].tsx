/**
 * C-08 صفحة الموقع (V2-012): photos (short-lived presigned links of the private bucket, read again on every visit
 * of the screen, DEC-494), the operator line «تشغيل: …» (V2-D01), open now, the week's hours, the address with
 * «فتح في الخرائط», and the prices — per visit, and since V2-032 the monthly and yearly prices of the plans sold here
 * with «اشترك», which opens C-09 (DEC-534; it replaces DEC-506's «قريبًا»).
 *
 * Owner's option 1 (DEC-640): right under the hero, «اختر باقتك» — every way to subscribe as a card priced by the
 * working day of the place, the yearly best value marked, the saving against paying per visit, and the per-visit
 * price struck through; «اشترك سنويًا · 3,450 ر.س» opens C-09 with that plan and cycle chosen. The address and the
 * week's hours follow. A place that sells no subscription keeps the price tiles below.
 *
 * V2-UX (DEC-577): a hero header (the photos, or the building mark on a soft band) with the operator and the open-now
 * chip; the address with its map button; the week's hours with today highlighted; the prices as tiles (the yearly
 * one with its saving badge); «اشترك» in the sticky bottom sheet. Skeletons while loading.
 */
import type { CustomerLocationDetail } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { errorText } from '../../features/errorText';
import { hoursLines, locationDetailView } from '../../features/locations';
import { dayBasis, defaultChoice, planChoices } from '../../features/pricing';
import { bestYearlySaving } from '../../features/ux';
import { formatMoney } from '../../i18n/format';
import { fmt, isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, shadow, space } from '../../theme/tokens';
import { FadeIn } from '../../ui/Animated';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, IconBadge } from '../../ui/Controls';
import { Icon } from '../../ui/Icon';
import { openInMaps } from '../../ui/openLinks';
import { PlanCards } from '../../ui/PlanCards';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { SkeletonList } from '../../ui/Skeleton';

export default function LocationDetail() {
  const { venueId } = useLocalSearchParams<{ venueId: string }>();
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [loc, setLoc] = useState<CustomerLocationDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

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

  const saving = loc && loc.subscriptions_enabled ? bestYearlySaving(loc.plans) : null;
  const choices = useMemo(() => (loc ? planChoices(loc, t) : []), [loc, t]);
  const choice = choices.find((c) => c.key === picked) ?? defaultChoice(choices);
  const today = loc ? hoursLines(loc.opening_hours, t, Date.now()).find((h) => h.today) : undefined;

  return (
    <Screen
      footer={
        loc && view?.canSubscribe ? (
          <Button
            label={choice?.action ?? t.subscribe.action}
            icon="calendar-check"
            onPress={() =>
              router.push({
                pathname: '/subscribe/[venueId]',
                params: choice ? { venueId, plan: choice.planId, cycle: choice.cycle } : { venueId },
              })
            }
            testID="location-subscribe"
          />
        ) : undefined
      }
    >
      <ScreenHeader
        title={view?.title ?? t.locations.title}
        backLabel={t.common.back}
        onBack={() => router.back()}
      />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      {!loc && !failure ? <SkeletonList label={t.common.loading} hero count={2} /> : null}
      {loc && view ? (
        <>
          <FadeIn>
            <View style={styles.hero}>
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
              ) : (
                <View style={styles.heroBand}>
                  <IconBadge name="building" size={72} bg={color.surface} />
                </View>
              )}
              <View style={styles.heroBody}>
                <AppText tone="muted">{view.operator}</AppText>
                {today ? (
                  <AppText variant="small" tone="muted">
                    {fmt(t.locations.plan.todayHours, { hours: isolate(today.text) })}
                  </AppText>
                ) : null}
                {view.openNow ? (
                  <View
                    style={[
                      styles.openChip,
                      { backgroundColor: loc.open_now ? color.successSubtle : color.dangerSubtle },
                    ]}
                  >
                    <Icon name="clock" size={16} tint={loc.open_now ? color.successText : color.dangerText} />
                    <AppText variant="bodyStrong" tone={loc.open_now ? 'success' : 'danger'}>
                      {view.openNow}
                    </AppText>
                  </View>
                ) : null}
              </View>
            </View>
          </FadeIn>

          {choices.length > 0 ? (
            <FadeIn index={1}>
              <PlanCards
                title={t.locations.plan.title}
                choices={choices}
                selected={choice?.key ?? null}
                onSelect={setPicked}
                perDay={t.locations.plan.perDay}
                soldOut={t.annex.soldOut}
                withoutSub={
                  loc.pay_per_visit_halalas !== null
                    ? {
                        label: t.locations.plan.withoutSub,
                        price: fmt(t.locations.plan.perVisit, {
                          amount: isolate(formatMoney(loc.pay_per_visit_halalas, t)),
                        }),
                      }
                    : null
                }
                basis={dayBasis(loc, t)}
              />
            </FadeIn>
          ) : null}

          <FadeIn index={2}>
            <Card>
              <View style={styles.cardHead}>
                <IconBadge name="map-pin" size={36} />
                <AppText variant="cardTitle" accessibilityRole="header" style={styles.flex}>
                  {t.locations.address}
                </AppText>
              </View>
              {view.address ? <AppText>{view.address}</AppText> : null}
              {loc.lat !== null || view.address ? (
                <Button
                  label={t.locations.openInMaps}
                  icon="map"
                  variant="secondary"
                  size="md"
                  onPress={() => void maps()}
                />
              ) : null}
            </Card>
          </FadeIn>

          <FadeIn index={3}>
            <Card>
              <View style={styles.cardHead}>
                <IconBadge name="clock" size={36} />
                <AppText variant="cardTitle" accessibilityRole="header" style={styles.flex}>
                  {t.locations.hours}
                </AppText>
              </View>
              {hoursLines(loc.opening_hours, t, Date.now()).map((h) => (
                <View key={h.day} style={[styles.hoursRow, h.today && styles.today]}>
                  <AppText variant={h.today ? 'bodyStrong' : 'body'} style={styles.flex}>
                    {h.today ? `${h.label} (${t.locations.today})` : h.label}
                  </AppText>
                  <AppText style={[styles.hours, h.today && styles.hoursToday]}>{h.text}</AppText>
                </View>
              ))}
            </Card>
          </FadeIn>

          {choices.length === 0 ? (
            <FadeIn index={4}>
              <Card>
                <View style={styles.cardHead}>
                  <IconBadge name="wallet" size={36} />
                  <AppText variant="cardTitle" accessibilityRole="header" style={styles.flex}>
                    {t.locations.prices}
                  </AppText>
                </View>
                <View style={styles.tiles}>
                  {view.prices.map((p) => {
                    const yearly = p.label === t.locations.yearly;
                    return (
                      <View key={p.label} style={[styles.tile, yearly && saving !== null && styles.tileBest]}>
                        {yearly && saving !== null ? (
                          <View style={styles.saveBadge}>
                            <Icon name="badge-percent" size={14} tint={color.onPrimary} />
                            <AppText variant="caption" style={styles.saveText}>
                              {fmt(t.subscribe.saving, { pct: saving })}
                            </AppText>
                          </View>
                        ) : null}
                        <AppText variant="small" tone="muted">
                          {p.label}
                        </AppText>
                        <AppText style={styles.price}>{p.value}</AppText>
                      </View>
                    );
                  })}
                </View>
                <AppText variant="small" tone="muted">
                  {t.locations.vatNote}
                </AppText>
              </Card>
            </FadeIn>
          ) : null}
          {notice ? <Banner tone="warning">{notice}</Banner> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.border,
    overflow: 'hidden',
    boxShadow: shadow.md,
  },
  heroBand: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space[8],
    backgroundColor: color.primarySubtle,
  },
  heroBody: { padding: space[4], gap: space[2] },
  openChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space[1] + space[0.5],
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[1] },
  photos: { gap: space[2], padding: space[2] },
  photo: { width: 280, height: 180, borderRadius: radius.lg, backgroundColor: color.surface2 },
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 36,
    paddingHorizontal: space[2],
    borderRadius: radius.sm,
  },
  today: { backgroundColor: color.primarySubtle },
  hours: { fontFamily: font.mono, ...fontSize.sm, color: color.text },
  hoursToday: { fontFamily: font.monoSemibold, color: color.primaryText },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 140,
    padding: space[3],
    gap: space[1],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bg,
  },
  tileBest: { borderColor: color.primary, borderWidth: 2, backgroundColor: color.primarySubtle },
  saveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space[1],
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.full,
    backgroundColor: color.primary,
  },
  saveText: { color: color.onPrimary },
  price: { fontFamily: font.bold, ...fontSize.lg, color: color.text },
});
