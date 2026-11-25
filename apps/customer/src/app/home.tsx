/**
 * C-06 الرئيسية — by subscription (DEC-639): the app is for the subscribers of the places Point serves, each place
 * with its own subscription.
 *
 * - **No subscription and no visit in progress:** «أين تركن عادةً؟» (owner's option 2, `PlacesChooser`): the places
 *   that sell a subscription on a map, a sheet to choose one and «اشترك في هذا المكان» (C-08 → C-09 → C-10), and the
 *   shortcuts. The entry pass is not offered before a subscription.
 * - **Subscribed, or a visit in progress:** V2-UX option A «زر واحد» (DEC-620 … DEC-627), below. Subscribed without a
 *   visit (owner's option 4): the green «مشترك · {المكان}» over the circle, and under it the covered car and the
 *   renewal (opens C-14).
 *
 * Option A: an almost empty white screen with one big circle that changes with the moment.
 *
 * - **Top bar:** the brand mark at the start; at the end the locations (C-07, `home-locations`) and the account
 *   (C-19, `home-account`) as round buttons. No tab bar (DEC-626).
 * - **Greeting:** «مساء الخير» over the name.
 * - **Status pill** (the screen's header, a little larger than the mockup at the owner's request) with a blinking dot:
 *   «عند وصولك» · «سيارتك متوقفة بأمان» · «طلبت سيارتك» · «في الطريق إليك» · «جاهزة عند البوابة» …
 * - **The circle** (`HoldCircle`, `home-circle`): no visit → blue, QR, «بطاقة الدخول» (C-11); parked → blue, the car,
 *   «اطلب سيارتك»: **press and hold 3 seconds** to request it (DEC-621; `request-car-hold`), the light burst when the
 *   server accepted it and the circle turns navy; requested / on the way → navy, «منذ طلبك m:ss» ticking (opens C-12);
 *   ready → green, the handover code masked until tapped (DEC-625: the same endpoint as C-12, kept in memory only,
 *   hidden again at its expiry or when the car leaves «جاهزة»). A short hold requests nothing and shows the hint
 *   «اضغط مطولًا 3 ثوانٍ لطلب سيارتك» under the circle.
 * - **Under the circle:** the venue and the plate (opens C-12, `home-visit`), or the subscription's car and renewal
 *   (opens C-14, `home-subscription`).
 * - **Shortcuts:** سياراتي (أضف سيارة without one) · زياراتي · اشتراكاتي · الفواتير.
 *
 * The visit's details beyond `GET /v1/customer/home` (whether a request is possible, the time of the request, the
 * handover code's availability) come from C-12's own read (`GET /v1/customer/visits/{id}`), read again with home on
 * every `visit.updated` of the customer socket (V2-015), every reconnection and every return to the screen.
 */
import type { CustomerHandoverCode, CustomerHome, CustomerVisitDetail } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import {
  codeGroups,
  greeting,
  homeAction,
  homeStage,
  homeStop,
  homeTone,
  type HomeStage,
  type HomeTone,
} from '../features/home';
import {
  heldSubscriptions,
  homeMode,
  placeCards,
  subscribedChip,
  subscriptionLine,
  type PlaceCard,
} from '../features/places';
import { requestCar } from '../features/requestCar';
import { dayPart, elapsedView } from '../features/ux';
import { visitView } from '../features/visit';
import { fmt, isolate } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, layout, radius, space } from '../theme/tokens';
import { FadeIn } from '../ui/Animated';
import { AppText } from '../ui/AppText';
import { Banner } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { haptic } from '../ui/haptics';
import { HoldCircle, type HoldCircleState } from '../ui/HoldCircle';
import { Icon, type IconName } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { ease, nativeDriver, useReducedMotion } from '../ui/motion';
import { CarGlyph } from '../ui/CarGlyph';
import { PlacesChooser } from '../ui/PlacesChooser';
import { PlateBadge } from '../ui/PlateBadge';
import { IconButton } from '../ui/ScreenHeader';
import { SkeletonList } from '../ui/Skeleton';
import { Touchable } from '../ui/Touchable';

/** The answer to the request, shown while the car is still at the stop it was given at (then the pill says it). */
type Message = { tone: 'success' | 'danger' | 'warning' | 'info'; text: string; stop: number | null } | null;

/** The circle of option A is 196 across (the mockup); it shrinks on short screens only through the scroll. */
const CIRCLE = 196;

const TINT: Record<HomeTone, string> = {
  blue: color.primary,
  navy: color.surfaceInverse,
  green: color.success,
};

/** The pill when subscribed and no visit (DEC-639): the success pair, «مشترك · …». */
const SUBSCRIBED_PILL = { bg: color.successSubtle, fg: color.successText };

/** The pill's colours: a light band of the circle's family and its readable text (brand §4.4 pairs). */
const PILL: Record<HomeTone, { bg: string; fg: string }> = {
  blue: { bg: color.primarySubtle, fg: color.primaryText },
  navy: { bg: color.surface2, fg: color.text },
  green: { bg: color.successSubtle, fg: color.successText },
};

const STAGE_ICON: Record<HomeTone, IconName> = { blue: 'car', navy: 'navigation', green: 'key' };

/** The pill's dot blinks (none under reduce motion). */
function BlinkDot({ tint }: { tint: string }) {
  const reduced = useReducedMotion();
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, {
          toValue: 0.25,
          duration: 700,
          easing: ease.standard,
          useNativeDriver: nativeDriver,
        }),
        Animated.timing(blink, {
          toValue: 1,
          duration: 700,
          easing: ease.standard,
          useNativeDriver: nativeDriver,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink, reduced]);
  return <Animated.View aria-hidden style={[styles.dot, { backgroundColor: tint, opacity: blink }]} />;
}

function Shortcut({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      feedback="tap"
      pressScale={0.94}
      containerStyle={styles.shortcutBox}
      style={styles.shortcut}
    >
      {({ pressed }) => (
        <>
          <View style={[styles.shortcutIcon, pressed && styles.shortcutIconPressed]}>
            <Icon name={icon} size={24} tint={color.primary} />
          </View>
          <AppText variant="small" center numberOfLines={1} style={styles.shortcutLabel}>
            {label}
          </AppText>
        </>
      )}
    </Touchable>
  );
}

export default function Home() {
  const { t, locale, brand } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [home, setHome] = useState<CustomerHome | null>(null);
  const [detail, setDetail] = useState<CustomerVisitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [hold, setHold] = useState<HoldCircleState>({ phase: 'idle', count: 3, hint: false });
  const [burst, setBurst] = useState(0);
  const [code, setCode] = useState<CustomerHandoverCode | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // DEC-639: the places to choose from without a subscription, and the covered car with one
  const [places, setPlaces] = useState<PlaceCard[]>([]);
  const [placesFailure, setPlacesFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [covered, setCovered] = useState<{ plate: string; type: string | null; color: string | null } | null>(
    null,
  );
  const key = useRef(new CommandKey(newIdempotencyKey)).current;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const h = await session.api.home();
      setHome(h);
      setFailure(null);
      // C-12's read for the circle's action; its failure leaves «افتح حالة سيارتك», which reads it again
      setDetail(
        h.current_visit ? await session.api.visit(h.current_visit.ticket_id).catch(() => null) : null,
      );
      const mode = homeMode(h);
      if (mode === 'choose') {
        try {
          const page = await session.api.locations({ filter: 'subscribable' });
          const cards = placeCards(page.items, t, locale);
          setPlaces(cards);
          setPlacesFailure(null);
          setChosen((c) => (c && cards.some((p) => p.id === c) ? c : (cards[0]?.id ?? null)));
        } catch (e) {
          setPlacesFailure(`${t.home.places.loadFailed} ${errorText(e, t, locale)}`);
        }
      } else if (mode === 'subscribed') {
        // the covered car of the first subscription (C-14's read); without it the line keeps the renewal only
        const first = heldSubscriptions(h)[0];
        const [sub, cars] = await Promise.all([
          first ? session.api.subscription(first.subscription_id).catch(() => null) : null,
          session.api.vehicles().catch(() => []),
        ]);
        const kept = sub?.vehicles.find((v) => !v.removed) ?? null;
        const car = kept ? cars.find((c) => c.id === kept.vehicle_id) : undefined;
        // DEC-642: the covered car drawn in its type and colour next to its plate
        setCovered(
          kept?.plate_display
            ? {
                plate: kept.plate_display,
                type: car?.vehicle_type ?? null,
                color: car?.vehicle_color ?? null,
              }
            : null,
        );
      }
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

  // V2-015: the circle follows the customer socket (and every reconnection reads home again)
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
  const tone = homeTone(stage);
  const action = homeAction(stage, live);
  const elapsed = live && action === 'elapsed' ? elapsedView(live, t, now) : null;

  // «منذ طلبك m:ss» ticks every second
  useEffect(() => {
    if (action !== 'elapsed') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [action]);

  // the handover code lives in memory only while the car is ready (DEC-38, DEC-625), and goes at its expiry
  const ticket = visit?.ticket_id ?? null;
  useEffect(() => {
    if (action !== 'code') setCode(null);
  }, [action, ticket]);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, Date.parse(code.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);

  if (!session.me) return null;

  const openVisit = () => {
    if (visit) router.push({ pathname: '/visit/[ticketId]', params: { ticketId: visit.ticket_id } });
  };

  // the hold is the confirmation (DEC-622): the circle stays «sending» until this settles
  const request = async () => {
    if (!visit) return;
    setMessage(null);
    const r = await requestCar(session.api, visit.ticket_id, key, t);
    if (r.kind === 'requested') {
      haptic.success();
      setBurst((n) => n + 1);
      setDetail(r.visit);
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

  const toggleCode = async () => {
    if (!visit || codeBusy) return;
    if (code) {
      setCode(null);
      return;
    }
    setCodeBusy(true);
    try {
      setCode(await session.api.handoverCode(visit.ticket_id));
    } catch (e) {
      setMessage({ tone: 'warning', text: errorText(e, t, locale), stop });
      await load();
    } finally {
      setCodeBusy(false);
    }
  };

  const view = live ? visitView(live, t, locale) : null;
  const venue = visit
    ? locale === 'en' && visit.venue_name_en
      ? visit.venue_name_en
      : visit.venue_name_ar
    : null;
  const mode = home ? homeMode(home) : null;
  const held = home ? heldSubscriptions(home) : [];
  const firstHeld = held[0] ?? null;
  const part = dayPart(now);

  const label = (text: string) => (
    <AppText center numberOfLines={2} style={styles.circleLabel}>
      {text}
    </AppText>
  );
  const caption = (text: string) => (
    <AppText center numberOfLines={2} style={styles.circleCaption}>
      {text}
    </AppText>
  );

  // the circle for the moment: its action, colour, words and test id
  const circle = (() => {
    const tint = TINT[tone];
    // the same circle in every state (one element, so colours and contents cross-fade and the burst plays on)
    const common = { size: CIRCLE, tint, burstKey: burst, onHoldChange: setHold } as const;
    switch (action) {
      case 'pass':
        return (
          <HoldCircle
            {...common}
            mode="tap"
            onPress={() => router.push('/pass')}
            accessibilityLabel={t.home.pass}
            accessibilityHint={t.home.passHint}
            testID="home-pass"
            contentKey="pass"
          >
            <Icon name="qr-code" size={44} tint={color.onPrimary} strokeWidth={1.8} />
            {label(t.home.pass)}
          </HoldCircle>
        );
      case 'hold':
        return (
          <HoldCircle
            {...common}
            mode="hold"
            onHoldComplete={request}
            confirm={{
              title: t.visit.requestConfirmTitle,
              body: t.visit.requestConfirmBody,
              ok: t.visit.requestConfirm,
              cancel: t.visit.requestCancel,
            }}
            accessibilityLabel={t.visit.request}
            accessibilityHint={t.visit.holdHint}
            testID="request-car-hold"
            contentKey="hold"
            renderHolding={(count) => (
              <>
                <AppText center style={styles.count}>
                  {String(count)}
                </AppText>
                {caption(t.home.holding)}
              </>
            )}
            sending={
              <>
                <ActivityIndicator color={color.onPrimary} size="large" />
                {caption(t.common.sending)}
              </>
            }
          >
            <Icon name="car" size={44} tint={color.onPrimary} strokeWidth={1.8} />
            {label(t.home.hold)}
            {caption(t.home.holdCaption)}
          </HoldCircle>
        );
      case 'elapsed':
        return (
          <HoldCircle
            {...common}
            mode="tap"
            onPress={openVisit}
            accessibilityLabel={elapsed ? `${elapsed.label} ${elapsed.value}` : t.home.openVisit}
            accessibilityHint={t.home.openVisit}
            testID="home-elapsed"
            contentKey="elapsed"
          >
            <Icon name="navigation" size={44} tint={color.onPrimary} strokeWidth={1.8} />
            <View style={styles.elapsedRow}>
              <AppText style={styles.circleLabel}>{elapsed?.label ?? ''}</AppText>
              <AppText style={styles.elapsedValue}>{isolate(elapsed?.value ?? '')}</AppText>
            </View>
          </HoldCircle>
        );
      case 'code':
        return (
          <HoldCircle
            {...common}
            mode="tap"
            glowPulse
            onPress={() => void toggleCode()}
            accessibilityLabel={
              code ? fmt(t.home.codeShown, { code: code.code.split('').join(' ') }) : t.home.codeHidden
            }
            accessibilityHint={code ? t.home.codeTapHide : t.home.codeTapShow}
            testID="home-code"
            contentKey={code ? 'code-shown' : 'code-hidden'}
          >
            <Icon name="key" size={40} tint={color.onPrimary} strokeWidth={1.8} />
            {codeBusy ? (
              <ActivityIndicator color={color.onPrimary} />
            ) : (
              <AppText center style={[styles.code, !code && styles.codeMasked]}>
                {code ? isolate(codeGroups(code.code)) : '••• •••'}
              </AppText>
            )}
            {caption(code ? t.home.codeTapHide : t.home.codeTapShow)}
          </HoldCircle>
        );
      case 'open':
        return (
          <HoldCircle
            {...common}
            mode="tap"
            glowPulse={tone === 'green'}
            onPress={openVisit}
            accessibilityLabel={stage === 'ready' ? t.home.ready : t.home.openVisit}
            accessibilityHint={t.home.openVisit}
            testID="home-open"
            contentKey={`open-${tone}`}
          >
            <Icon name={STAGE_ICON[tone]} size={44} tint={color.onPrimary} strokeWidth={1.8} />
            {label(stage === 'ready' ? t.home.ready : t.home.openVisit)}
          </HoldCircle>
        );
    }
  })();

  // subscribed without a visit (option 4): the green «مشترك · {المكان}» says where the pass is for
  const subscribedNow = mode === 'subscribed' && stage === 'none';
  const pill = subscribedNow ? SUBSCRIBED_PILL : PILL[tone];
  const pillText = subscribedNow ? subscribedChip(held, t, locale) : t.home.status[stage];

  const shortcuts = home ? (
    <View style={styles.shortcuts} accessibilityRole="toolbar" accessibilityLabel={t.home.quickActions}>
      <Shortcut
        icon={home.vehicles_count === 0 ? 'plus' : 'car'}
        label={home.vehicles_count === 0 ? t.home.addVehicle : t.home.myVehicles}
        onPress={() =>
          home.vehicles_count === 0
            ? router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })
            : router.push('/vehicles')
        }
        testID="home-vehicles"
      />
      <Shortcut
        icon="history"
        label={t.home.myVisits}
        onPress={() => router.push('/visits')}
        testID="home-visits"
      />
      <Shortcut
        icon="calendar-check"
        label={t.home.subscriptions}
        onPress={() => router.push('/subscriptions')}
        testID="home-subscriptions"
      />
      <Shortcut
        icon="receipt"
        label={t.settings.invoices}
        onPress={() => router.push('/invoices')}
        testID="home-invoices"
      />
    </View>
  ) : null;

  if (home && mode === 'choose') {
    return (
      <SafeAreaView style={[styles.safe, styles.flex]} edges={['top', 'bottom']}>
        <PlacesChooser
          places={places}
          loading={loading}
          failure={failure ? `${t.home.loadFailed} ${failure}` : placesFailure}
          selected={chosen}
          onSelect={setChosen}
          onSubscribe={(venueId) => router.push({ pathname: '/location/[venueId]', params: { venueId } })}
          onSearch={() => router.push('/locations')}
          onAccount={() => router.push('/settings')}
          shortcuts={shortcuts}
          text={{
            greeting: greeting(home, t, part),
            title: t.home.places.title,
            hint: t.home.places.hint,
            search: t.home.places.search,
            account: t.home.account,
            mapLabel: t.home.places.mapLabel,
            count: fmt(t.home.places.count, { n: places.length }),
            subscribe: t.home.places.subscribe,
            empty: t.home.places.empty,
            loading: t.common.loading,
          }}
        />
        <DevBanner />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        // a hold is never taken over by the scroll
        scrollEnabled={hold.phase === 'idle'}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading && home !== null} onRefresh={load} />}
      >
        <View style={styles.page}>
          <View style={styles.bar}>
            <Logo variant="mark" height={32} label={brand} />
            <View style={styles.flex} />
            <IconButton
              icon="map"
              label={t.home.allLocations}
              onPress={() => router.push('/locations')}
              testID="home-locations"
            />
            <IconButton
              icon="user"
              label={t.home.account}
              onPress={() => router.push('/settings')}
              testID="home-account"
            />
          </View>

          <View style={styles.hello} accessible accessibilityLabel={greeting(home, t, part)}>
            <AppText tone="muted">{t.home[part]}</AppText>
            {home?.display_name ? (
              <AppText variant="title" numberOfLines={1}>
                {home.display_name}
              </AppText>
            ) : null}
          </View>

          {failure ? <Banner tone="danger">{`${t.home.loadFailed} ${failure}`}</Banner> : null}

          <View style={styles.stage}>
            {!home && loading ? (
              <SkeletonList label={t.common.loading} count={1} lines={2} />
            ) : home ? (
              <>
                <FadeIn swapKey={subscribedNow ? 'subscribed' : stage}>
                  <View style={[styles.pill, { backgroundColor: pill.bg }]}>
                    <BlinkDot tint={pill.fg} />
                    <AppText accessibilityRole="header" style={[styles.pillText, { color: pill.fg }]}>
                      {pillText}
                    </AppText>
                  </View>
                </FadeIn>
                <View testID="home-circle">{circle}</View>
                <View style={styles.hintSlot}>
                  {hold.hint && action === 'hold' ? (
                    <FadeIn>
                      <AppText center tone="primary" variant="smallStrong" accessibilityRole="alert">
                        {t.home.holdHint}
                      </AppText>
                    </FadeIn>
                  ) : view?.handoverNote && action === 'open' ? (
                    <AppText center tone="muted" variant="small">
                      {view.handoverNote}
                    </AppText>
                  ) : null}
                </View>
                {visit ? (
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={`${t.home.currentVisit} ${t.ticketStatus[live?.status ?? visit.status]}`}
                    accessibilityHint={t.home.openVisit}
                    onPress={openVisit}
                    pressScale={0.98}
                    testID="home-visit"
                    style={({ pressed }) => [styles.where, pressed && styles.pressed]}
                  >
                    <AppText tone="muted" center numberOfLines={2}>
                      {venue}
                    </AppText>
                    {visit.plate_display ? <PlateBadge plate={isolate(visit.plate_display)} /> : null}
                  </Touchable>
                ) : subscribedNow && firstHeld ? (
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={[covered?.plate, subscriptionLine(firstHeld, t)]
                      .filter(Boolean)
                      .join('، ')}
                    accessibilityHint={t.home.subscriptions}
                    onPress={() => router.push('/subscriptions')}
                    pressScale={0.98}
                    testID="home-subscription"
                    style={({ pressed }) => [styles.where, pressed && styles.pressed]}
                  >
                    {covered ? (
                      <View style={styles.car}>
                        <CarGlyph type={covered.type} paint={covered.color} width={56} />
                        <PlateBadge plate={isolate(covered.plate)} />
                      </View>
                    ) : null}
                    <AppText
                      tone={firstHeld.status === 'past_due' ? 'danger' : 'muted'}
                      variant="small"
                      center
                      numberOfLines={2}
                    >
                      {subscriptionLine(firstHeld, t)}
                    </AppText>
                  </Touchable>
                ) : null}
                {message && message.stop === stop ? (
                  <View style={styles.message}>
                    <Banner tone={message.tone}>{message.text}</Banner>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>

          {shortcuts}
          <DevBanner />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: space[5], paddingBottom: space[4] },
  page: { flexGrow: 1, width: '100%', maxWidth: layout.shellMaxW, alignSelf: 'center', gap: space[2] },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingTop: space[3] },
  hello: { marginTop: space[3] },
  stage: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingVertical: space[3],
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.full,
  },
  // the owner asked for the line over the circle a little larger than the mockup's (DEC-620)
  pillText: { ...fontSize.lg, fontFamily: font.bold },
  dot: { width: space[2] + space[0.5], height: space[2] + space[0.5], borderRadius: radius.full },
  circleLabel: { ...fontSize.xl, fontFamily: font.bold, color: color.onPrimary },
  circleCaption: { ...fontSize.sm, fontFamily: font.medium, color: color.onPrimary, opacity: 0.85 },
  count: { ...fontSize.display, fontFamily: font.monoSemibold, color: color.onPrimary },
  elapsedRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  elapsedValue: { ...fontSize.xl, fontFamily: font.monoSemibold, color: color.onPrimary },
  code: { ...fontSize['3xl'], fontFamily: font.monoSemibold, color: color.onPrimary, letterSpacing: 2 },
  codeMasked: { opacity: 0.85 },
  hintSlot: { minHeight: fontSize.sm.lineHeight, justifyContent: 'center', paddingHorizontal: space[4] },
  where: {
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[1],
    paddingHorizontal: space[3],
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: color.primarySubtle },
  car: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  message: { alignSelf: 'stretch' },
  shortcuts: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space[3],
    paddingTop: space[2],
  },
  shortcutBox: { width: 72 },
  shortcut: { alignItems: 'center', gap: space[1], minHeight: space[12] },
  shortcutIcon: {
    width: space[12] + space[2],
    height: space[12] + space[2],
    borderRadius: radius.lg,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutIconPressed: { backgroundColor: color.primarySubtle },
  shortcutLabel: { color: color.text },
});
