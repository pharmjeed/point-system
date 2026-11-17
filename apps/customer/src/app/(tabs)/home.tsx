/**
 * C-06 الرئيسية — V2-UX option B «البطاقة الحية», chosen by the owner (DEC-580 … DEC-582):
 *
 * - **The blue hero:** «مساء الخير، {الاسم}» with the white brand mark, the car's state as the big title with one line
 *   of explanation, and — while a visit is live — the road of three stops (متوقفة · في الطريق · جاهزة) with the car
 *   sliding to where it is (`CarRoad`). Without a visit: the welcome and no road.
 * - **The live card** over the hero's edge: the venue, its operator and the plate (it opens C-12, `home-visit`), and
 *   the one action of the moment (`homeAction`): «بطاقة الدخول» (C-11) without a visit; the swipe to request the car
 *   when it is parked (DEC-583, the same command as C-12, DEC-581); «منذ طلبك m:ss» while it comes (opens C-12);
 *   «اعرض رمز التسليم» in green when it is ready (opens C-12 at the code).
 * - **Chips:** بطاقة الدخول · اشترك ووفّر (C-07 on «يقبل الاشتراك») · سياراتي; then my subscriptions when there are any
 *   (C-14) and the nearby locations with «كل المواقع» (C-07). Visits, subscriptions and the account are tabs (DEC-582).
 *
 * The visit's details beyond `GET /v1/customer/home` (the operator, whether a request is possible, the time of the
 * request, the handover code's availability) come from C-12's own read (`GET /v1/customer/visits/{id}`), read again
 * with home on every `visit.updated` of the customer socket (V2-015), every reconnection and every return to the tab.
 */
import type { CustomerHome, CustomerVisitDetail } from '@point/shared/customer';
import { setStatusBarStyle } from 'expo-status-bar';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommandKey } from '../../features/commandKey';
import { errorText } from '../../features/errorText';
import {
  greeting,
  homeAction,
  homeSections,
  homeStage,
  homeStop,
  locationRow,
  type HomeSection,
  type HomeStage,
} from '../../features/home';
import { requestCar } from '../../features/requestCar';
import { dayPart, elapsedView, homeSubscriptionLine } from '../../features/ux';
import { visitView } from '../../features/visit';
import { isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, layout, radius, shadow, space } from '../../theme/tokens';
import { FadeIn } from '../../ui/Animated';
import { AppText } from '../../ui/AppText';
import { CarRoad } from '../../ui/CarRoad';
import { Banner, IconBadge, SectionTitle } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { fromStart } from '../../ui/direction';
import { EmptyState } from '../../ui/EmptyState';
import { haptic } from '../../ui/haptics';
import { Icon, type IconName } from '../../ui/Icon';
import { LocationCard } from '../../ui/LocationCard';
import { Logo } from '../../ui/Logo';
import { PlateBadge } from '../../ui/PlateBadge';
import { SkeletonList } from '../../ui/Skeleton';
import { SwipeToConfirm } from '../../ui/SwipeToConfirm';
import { Touchable } from '../../ui/Touchable';

/** The answer to the swipe, shown while the car is still at the stop it was given at (then the hero says it). */
type Message = { tone: 'success' | 'danger' | 'warning' | 'info'; text: string; stop: number | null } | null;

/** The card's action button: navy, or green when the car is ready (the mockup's colours, DEC-580). */
function CardAction({
  icon,
  label,
  onPress,
  tone = 'navy',
  hint,
  testID,
  value,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: 'navy' | 'green';
  hint?: string;
  testID?: string;
  /** a number drawn in mono after the label (the elapsed time) */
  value?: string;
}) {
  const bg = tone === 'green' ? color.success : color.surfaceInverse;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label} ${value}` : label}
      accessibilityHint={hint}
      onPress={onPress}
      feedback="tap"
      pressScale={0.98}
      testID={testID}
      style={({ pressed }) => [styles.action, { backgroundColor: bg }, pressed && styles.actionPressed]}
    >
      <Icon name={icon} size={22} tint={color.onPrimary} />
      <AppText style={styles.actionText}>{label}</AppText>
      {value ? <AppText style={styles.actionValue}>{isolate(value)}</AppText> : null}
    </Touchable>
  );
}

function Chip({
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
      pressScale={0.96}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      <Icon name={icon} size={18} tint={color.primary} />
      <AppText variant="smallStrong" numberOfLines={1}>
        {label}
      </AppText>
    </Touchable>
  );
}

export default function Home() {
  const { t, f, locale, brand } = useI18n();
  const session = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [home, setHome] = useState<CustomerHome | null>(null);
  const [detail, setDetail] = useState<CustomerVisitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const key = useRef(new CommandKey(newIdempotencyKey)).current;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const h = await session.api.home();
      setHome(h);
      setFailure(null);
      // C-12's read for the card's action; its failure leaves «افتح حالة سيارتك», which reads it again
      setDetail(
        h.current_visit ? await session.api.visit(h.current_visit.ticket_id).catch(() => null) : null,
      );
    } catch (e) {
      setFailure(errorText(e, t, locale));
    } finally {
      setLoading(false);
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // white text on the blue hero; the other screens keep the dark status bar of the root layout
      setStatusBarStyle('light');
      return () => setStatusBarStyle('dark');
    }, [load]),
  );

  // V2-015: the card follows the customer socket (and every reconnection reads home again)
  useEffect(
    () =>
      session.events.subscribe({
        onVisit: () => void load(),
        onSubscription: () => void load(),
        onResync: () => void load(),
      }),
    [session.events, load],
  );

  const visit = home?.current_visit ?? null;
  const live = visit && detail?.ticket_id === visit.ticket_id ? detail : null;
  const stage: HomeStage = visit
    ? homeStage(live?.status ?? visit.status, live?.request.pending_early ?? false)
    : 'none';
  const stop = homeStop(stage);
  const action = homeAction(stage, live);
  const elapsed = live && action === 'elapsed' ? elapsedView(live, t, now) : null;

  // «منذ طلبك m:ss» ticks every second
  useEffect(() => {
    if (action !== 'elapsed') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [action]);

  if (!session.me) return null;

  const openVisit = (params: Record<string, string> = {}) => {
    if (visit)
      router.push({ pathname: '/visit/[ticketId]', params: { ticketId: visit.ticket_id, ...params } });
  };

  const request = async () => {
    if (!visit) return;
    setMessage(null);
    const r = await requestCar(session.api, visit.ticket_id, key, t);
    if (r.kind === 'requested') {
      setDetail(r.visit);
      haptic.success();
      setMessage({
        tone: 'success',
        text: r.text,
        stop: homeStop(homeStage(r.visit.status, r.visit.request.pending_early)),
      });
    } else {
      haptic.error();
      setMessage(
        r.kind === 'refused'
          ? { tone: 'danger', text: errorText(r.error, t, locale), stop }
          : r.kind === 'already'
            ? // a request is open: the car is on its way (stop 1) once home is read again
              { tone: 'info', text: r.text, stop: 1 }
            : { tone: 'warning', text: r.text, stop },
      );
    }
    await load();
  };

  const view = live ? visitView(live, t, locale) : null;
  const hero = t.home.hero[stage];
  const heroBody = stage === 'ready' && view?.handoverNote ? view.handoverNote : hero.body;
  const venue = visit
    ? locale === 'en' && visit.venue_name_en
      ? visit.venue_name_en
      : visit.venue_name_ar
    : null;
  const nearestLoc = home?.nearby_locations[0] ?? null;
  const nearest = nearestLoc ? locationRow(nearestLoc, t, locale) : null;
  const subscribedVenues = new Set(home?.subscriptions.map((s) => s.venue_id) ?? []);

  const cardAction = (() => {
    switch (action) {
      case 'pass':
        return (
          <CardAction
            icon="qr-code"
            label={t.home.pass}
            hint={t.home.passHint}
            onPress={() => router.push('/pass')}
            testID="home-card-pass"
          />
        );
      case 'swipe':
        return (
          <SwipeToConfirm
            testID="request-car-swipe"
            label={t.visit.swipe}
            accessibilityLabel={t.visit.request}
            accessibilityHint={t.visit.swipeHint}
            confirm={{
              title: t.visit.requestConfirmTitle,
              body: t.visit.requestConfirmBody,
              ok: t.visit.requestConfirm,
              cancel: t.visit.requestCancel,
            }}
            busyLabel={t.common.sending}
            onConfirm={request}
            onDragChange={setDragging}
          />
        );
      case 'elapsed':
        return (
          <CardAction
            icon="navigation"
            label={elapsed?.label ?? t.home.openVisit}
            value={elapsed?.value}
            hint={t.home.openVisit}
            onPress={() => openVisit()}
            testID="home-card-action"
          />
        );
      case 'code':
        return (
          <CardAction
            icon="key"
            tone="green"
            label={t.home.showCode}
            onPress={() => openVisit({ show: 'code' })}
            testID="home-show-code"
          />
        );
      case 'open':
        return (
          <CardAction
            icon="go"
            label={t.home.openVisit}
            onPress={() => openVisit()}
            testID="home-card-action"
          />
        );
    }
  })();

  const section = (s: HomeSection, i: number) => {
    if (!home) return null;
    switch (s) {
      case 'card':
        return (
          <FadeIn key={s} index={i} swapKey={stage} style={styles.card}>
            {visit ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`${t.home.currentVisit} ${t.ticketStatus[live?.status ?? visit.status]}`}
                accessibilityHint={t.home.openVisit}
                onPress={() => openVisit()}
                pressScale={0.99}
                style={({ pressed }) => [styles.venueRow, pressed && styles.pressedSoft]}
                testID="home-visit"
              >
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" numberOfLines={2}>
                    {venue}
                  </AppText>
                  {view ? (
                    <AppText variant="small" tone="muted" numberOfLines={2}>
                      {view.operator}
                    </AppText>
                  ) : null}
                </View>
                {visit.plate_display ? <PlateBadge plate={isolate(visit.plate_display)} /> : null}
              </Touchable>
            ) : nearest ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`${t.home.nearest}: ${nearest.title}`}
                onPress={() =>
                  router.push({ pathname: '/location/[venueId]', params: { venueId: nearest.id } })
                }
                pressScale={0.99}
                style={({ pressed }) => [styles.venueRow, pressed && styles.pressedSoft]}
              >
                <View style={styles.flex}>
                  <AppText variant="bodyStrong">{t.home.nearest}</AppText>
                  <AppText variant="small" tone="muted" numberOfLines={2}>
                    {[
                      nearest.title,
                      nearestLoc?.open_now === true
                        ? t.home.openNow
                        : nearestLoc?.open_now === false
                          ? t.home.closedNow
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>
                </View>
              </Touchable>
            ) : null}
            {cardAction}
          </FadeIn>
        );
      case 'chips':
        return (
          <FadeIn key={s} index={i}>
            {message && message.stop === stop ? (
              <View style={styles.message}>
                <Banner tone={message.tone}>{message.text}</Banner>
              </View>
            ) : null}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              accessibilityRole="toolbar"
              accessibilityLabel={t.home.quickActions}
            >
              <Chip
                icon="qr-code"
                label={t.home.pass}
                onPress={() => router.push('/pass')}
                testID="home-pass"
              />
              <Chip
                icon="badge-percent"
                label={t.home.subscribeSave}
                onPress={() => router.push({ pathname: '/locations', params: { filter: 'subscribable' } })}
                testID="home-subscribe"
              />
              <Chip
                icon={home.vehicles_count === 0 ? 'plus' : 'car'}
                label={home.vehicles_count === 0 ? t.home.addVehicle : t.home.myVehicles}
                onPress={() =>
                  home.vehicles_count === 0
                    ? router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })
                    : router.push('/vehicles')
                }
                testID="home-vehicles"
              />
            </ScrollView>
          </FadeIn>
        );
      case 'subscriptions':
        return (
          <FadeIn key={s} index={i} style={styles.section}>
            <SectionTitle>{t.home.subscriptions}</SectionTitle>
            {home.subscriptions.map((sub) => {
              const title = locale === 'en' && sub.venue_name_en ? sub.venue_name_en : sub.venue_name_ar;
              const active = sub.status === 'active';
              return (
                <Touchable
                  key={sub.subscription_id}
                  accessibilityRole="button"
                  accessibilityLabel={title}
                  onPress={() => router.navigate('/subscriptions')}
                  style={({ pressed }) => [styles.listCard, pressed && styles.pressed]}
                >
                  <IconBadge
                    name="calendar-check"
                    tint={active ? color.successText : color.warningText}
                    bg={active ? color.successSubtle : color.warningSubtle}
                  />
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong">{title}</AppText>
                    <AppText variant="small" tone={active ? 'success' : 'default'}>
                      {`${t.subscribe[sub.billing_cycle]} · ${homeSubscriptionLine(sub, t)}`}
                    </AppText>
                  </View>
                  <Icon name="go" size={20} tint={color.textMuted} />
                </Touchable>
              );
            })}
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
    <View style={styles.screen}>
      <ScrollView
        scrollEnabled={!dragging}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading && home !== null} onRefresh={load} />}
      >
        <View style={[styles.hero, { paddingTop: insets.top + space[4] }]}>
          {/* decoration only: clipped by the hero's rounded box */}
          <View style={[styles.heroCircle, fromStart(-90)]} pointerEvents="none" aria-hidden />
          <View style={styles.heroInner}>
            <View style={styles.heroTop}>
              <AppText variant="small" style={[styles.onBlue, styles.flex, styles.soft]} numberOfLines={1}>
                {greeting(home, t, dayPart(now))}
              </AppText>
              <Logo variant="markWhite" height={30} label={brand} />
            </View>
            <FadeIn swapKey={stage}>
              <AppText variant="display" accessibilityRole="header" style={[styles.onBlue, styles.heroTitle]}>
                {f(hero.title)}
              </AppText>
              <AppText style={[styles.onBlue, styles.soft]}>{f(heroBody)}</AppText>
            </FadeIn>
            {stop !== null ? <CarRoad stop={stop} /> : null}
          </View>
        </View>
        <View style={styles.content}>
          {failure ? <Banner tone="danger">{`${t.home.loadFailed} ${failure}`}</Banner> : null}
          {!home && loading ? (
            <View style={styles.card}>
              <SkeletonList label={t.common.loading} count={1} lines={2} />
            </View>
          ) : null}
          {home ? homeSections(home).map(section) : null}
          <DevBanner />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  scroll: { paddingBottom: space[6] },
  hero: {
    backgroundColor: color.primary,
    borderBottomLeftRadius: radius.xl + space[2],
    borderBottomRightRadius: radius.xl + space[2],
    paddingHorizontal: space[5],
    paddingBottom: space[16],
    overflow: 'hidden',
  },
  heroCircle: {
    position: 'absolute',
    top: -110,
    width: 240,
    height: 240,
    borderRadius: radius.full,
    backgroundColor: color.primaryHover,
    opacity: 0.55,
  },
  heroInner: { width: '100%', maxWidth: layout.shellMaxW - 2 * space[5], alignSelf: 'center' },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  heroTitle: { marginTop: space[4] },
  onBlue: { color: color.onPrimary },
  soft: { opacity: 0.9 },
  content: {
    width: '100%',
    maxWidth: layout.shellMaxW,
    alignSelf: 'center',
    paddingHorizontal: space[4],
    marginTop: -space[10],
    gap: space[4],
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    padding: space[4],
    gap: space[3],
    boxShadow: shadow.lg,
  },
  venueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    borderRadius: radius.md,
  },
  pressedSoft: { opacity: 0.85 },
  action: {
    minHeight: layout.buttonLg,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    boxShadow: shadow.md,
  },
  actionPressed: { opacity: 0.9 },
  actionText: { ...fontSize.base, fontFamily: font.bold, color: color.onPrimary },
  actionValue: { ...fontSize.lg, fontFamily: font.monoSemibold, color: color.onPrimary },
  message: { marginBottom: space[3] },
  chips: { gap: space[2], paddingVertical: space[0.5] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1] + space[0.5],
    minHeight: space[12],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
  },
  section: { gap: space[3] },
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
