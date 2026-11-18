/**
 * C-12 سيارتي الآن (V2-015; docs/v2/01 R3/R4, DEC-516 … DEC-520): the live state with its timeline, the intake photos
 * (short-lived links read again on every display), «اطلب السيارة», the waiting and ready states,
 * the handover code card while the car is ready (fetched on demand, kept in memory only — DEC-38), «مساعدة» (the
 * support WhatsApp of the build), the payment area (VisitPaymentSlot: V2-022 adds «ادفع» there), and C-13 after the
 * delivery. It reads the visit again on every `visit.updated` of the customer socket, on every (re)connection and
 * when it comes back into view: the server is the source of truth. Offline, the request is refused with the WhatsApp
 * and driver alternatives (01 §4).
 *
 * V2-UX (DEC-570): the hero screen of the app — a status hero (the car's state as a picture, the big status title,
 * one line of explanation, the venue, operator and plate, the time since the request), the six-stage tracker, then
 * the code, payment, photos and the detailed timeline; the one primary action of the state («اطلب السيارة», «اعرض
 * الرمز» with the code itself, or «قيّم الخدمة») lives in the sticky bottom sheet, and each change of state
 * cross-fades the hero and the sheet. Behaviour and copy are V2-015's.
 *
 * V2-UX option A (DEC-621, DEC-624): «اطلب السيارة» is the same hold as the home screen's circle in a compact form —
 * a small circle in the bottom sheet (`HoldCircle`, test id `request-car-hold`) held 3 seconds while its ring fills,
 * with the words beside it («اضغط مطولًا على الدائرة 3 ثوانٍ» → «استمر بالضغط… 2» → «جارٍ الإرسال…», or the hint
 * after a short hold). The hold is the confirmation (DEC-622); screen readers and the keyboard reach the command
 * through the confirmation dialog. The command is shared with C-06 (`requestCar`); when the server accepts it the
 * circle shows a check with the light burst, then the sheet moves on. Opened with `show=code`, the code is fetched
 * once it is available.
 */
import type { CustomerHandoverCode, CustomerVisitDetail } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/errors';
import { appConfig } from '../../config';
import { CommandKey } from '../../features/commandKey';
import { errorText } from '../../features/errorText';
import { shouldOfferPush } from '../../features/push';
import { requestCar } from '../../features/requestCar';
import { elapsedView, heroKind, trackerProgress, trackerStages, type HeroKind } from '../../features/ux';
import { codeSecondsLeft, helpLink, visitView } from '../../features/visit';
import { fmt, isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { usePush } from '../../push/usePush';
import { flags, newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, shadow, space, statusColor } from '../../theme/tokens';
import { FadeIn, Pulse } from '../../ui/Animated';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, IconBadge } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { haptic } from '../../ui/haptics';
import { HoldCircle, type HoldCircleState } from '../../ui/HoldCircle';
import { Icon, type IconName } from '../../ui/Icon';
import { useReducedMotion } from '../../ui/motion';
import { openLink } from '../../ui/openLinks';
import { PlateBadge } from '../../ui/PlateBadge';
import { RatingSheet } from '../../ui/RatingSheet';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { SkeletonList } from '../../ui/Skeleton';
import { StageTracker, StepTimeline } from '../../ui/VisitTracker';
import { VisitPaymentSlot } from '../../ui/VisitPaymentSlot';

type Message = { tone: 'success' | 'danger' | 'warning' | 'info'; text: string } | null;

/** The picture of the hero for each kind of state (the design system's status icons, DEC-49). */
const HERO_ICON: Record<HeroKind, IconName> = {
  parking: 'circle-parking',
  parked: 'square-parking',
  waiting: 'bell-ring',
  moving: 'navigation',
  ready: 'circle-check',
  done: 'check-check',
  void: 'circle-x',
};

/**
 * The hero's colours: a soft band and a solid disc of the status family (brand §4.3 `status.*`, the semantic roles) —
 * never a large blue surface (03 §2.2).
 */
const HERO_TINT: Record<HeroKind, { band: string; disc: string }> = {
  parking: { band: statusColor.received.bg, disc: statusColor.received.fg },
  parked: { band: statusColor.parked.bg, disc: statusColor.parked.fg },
  waiting: { band: statusColor.requested.bg, disc: statusColor.requested.fg },
  moving: { band: color.primarySubtle, disc: color.primary },
  ready: { band: color.successSubtle, disc: color.success },
  done: { band: statusColor.parked.bg, disc: statusColor.delivered.fg },
  void: { band: statusColor.voided.bg, disc: statusColor.voided.fg },
};

/** States where something is happening right now: the picture breathes. */
const LIVE: ReadonlySet<HeroKind> = new Set<HeroKind>(['parking', 'waiting', 'moving', 'ready']);

export default function VisitScreen() {
  // `show=code`: opened from C-06's «اعرض رمز التسليم» (DEC-581) — fetch the code once it is available
  const { ticketId, show } = useLocalSearchParams<{ ticketId: string; show?: string }>();
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const push = usePush(t.visit.title);
  const [visit, setVisit] = useState<CustomerVisitDetail | null>(null);
  const [gone, setGone] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [code, setCode] = useState<CustomerHandoverCode | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [rating, setRating] = useState(false);
  const [offered, setOffered] = useState(true);
  const [hold, setHold] = useState<HoldCircleState>({ phase: 'idle', count: 3, hint: false });
  const [burst, setBurst] = useState(0);
  const [celebrate, setCelebrate] = useState(false);
  const reduced = useReducedMotion();
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const ratingShown = useRef(false);

  const load = useCallback(async () => {
    if (!ticketId) return;
    try {
      const v = await session.api.visit(ticketId);
      setVisit(v);
      setGone(false);
      if (!v.handover.code_available) setCode(null);
      if (v.can_rate && !ratingShown.current) {
        ratingShown.current = true;
        setRating(true);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RESOURCE_NOT_FOUND') setGone(true);
      else setMessage({ tone: 'danger', text: `${t.visit.loadFailed} ${errorText(e, t, locale)}` });
    }
  }, [session.api, ticketId, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // the customer socket: re-read on this visit's updates and after every (re)connection
  useEffect(
    () =>
      session.events.subscribe({
        onVisit: (e) => {
          if (e.ticket_id === ticketId) void load();
        },
        onResync: () => void load(),
      }),
    [session.events, ticketId, load],
  );

  const elapsed = visit ? elapsedView(visit, t, now) : null;
  const ticking = code !== null || elapsed?.live === true;

  // the code's countdown and the time since the request tick every second
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // the car reached the gate: a success buzz (the screen says it too)
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!visit) return;
    if (lastStatus.current && lastStatus.current !== visit.status && visit.status === 'ready')
      haptic.success();
    lastStatus.current = visit.status;
  }, [visit]);

  useEffect(() => {
    void flags.pushOffered().then(setOffered);
  }, []);

  // the hold is the confirmation (DEC-622): no dialog before the command; the circle stays busy until it settles
  const request = async () => {
    if (!ticketId) return;
    setMessage(null);
    const r = await requestCar(session.api, ticketId, key, t);
    if (r.kind === 'requested') {
      haptic.success();
      setMessage({ tone: 'success', text: r.text });
      // the check and the light burst on the circle, then the sheet moves on (at once under reduce motion)
      setCelebrate(true);
      setBurst((n) => n + 1);
      if (!reduced) await new Promise((done) => setTimeout(done, 750));
      setVisit(r.visit);
      setCelebrate(false);
      return;
    }
    haptic.error();
    setMessage(
      r.kind === 'refused'
        ? { tone: 'danger', text: errorText(r.error, t, locale) }
        : { tone: r.kind === 'offline' ? 'warning' : 'info', text: r.text },
    );
    await load();
  };

  const showCode = async () => {
    if (!ticketId) return;
    setCodeBusy(true);
    try {
      setCode(await session.api.handoverCode(ticketId));
      setNow(Date.now());
    } catch (e) {
      setMessage({ tone: 'warning', text: errorText(e, t, locale) });
      await load();
    } finally {
      setCodeBusy(false);
    }
  };

  // from C-06's «اعرض رمز التسليم»: the code is fetched once, as if «اعرض الرمز» had been pressed here
  const autoCode = useRef(false);
  const codeAvailable = visit?.handover.code_available === true;
  useEffect(() => {
    if (show !== 'code' || autoCode.current || !codeAvailable) return;
    autoCode.current = true;
    void showCode();
  }, [show, codeAvailable, showCode]);

  const help = async () => {
    const link = helpLink(appConfig.support.whatsapp, t);
    if (!link || !(await openLink(link))) setMessage({ tone: 'info', text: t.visit.helpNone });
  };

  const answerOffer = async (enable: boolean) => {
    setOffered(true);
    await flags.setPushOffered();
    if (!enable) return;
    const r = await push.enable().catch(() => 'failed' as const);
    setMessage(
      r === 'enabled'
        ? { tone: 'success', text: t.push.enabled }
        : r === 'denied'
          ? { tone: 'warning', text: t.push.blocked }
          : r === 'unavailable'
            ? { tone: 'info', text: t.push.unavailable }
            : { tone: 'danger', text: t.push.failed },
    );
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const view = visit ? visitView(visit, t, locale) : null;
  const offerPush =
    visit !== null &&
    push.state.ready &&
    shouldOfferPush({
      available: push.state.available,
      permission: push.state.permission,
      offered,
      visitOpen: visit.open,
    });
  const stages = visit ? trackerStages(visit) : [];
  const kind = visit ? heroKind(visit.status) : 'parked';
  const tint = HERO_TINT[kind];

  // the sticky sheet: the one primary action of the state, then «مساعدة»
  const primary =
    view && view.canRequest ? (
      <View style={styles.holdRow}>
        <HoldCircle
          size={76}
          compact
          tint={color.primary}
          mode={celebrate ? 'tap' : 'hold'}
          disabled={celebrate}
          onHoldComplete={request}
          onHoldChange={setHold}
          burstKey={burst}
          confirm={{
            title: t.visit.requestConfirmTitle,
            body: t.visit.requestConfirmBody,
            ok: t.visit.requestConfirm,
            cancel: t.visit.requestCancel,
          }}
          accessibilityLabel={t.visit.request}
          accessibilityHint={t.visit.holdHint}
          testID="request-car-hold"
          contentKey={celebrate ? 'done' : 'request'}
          renderHolding={(count) => <AppText style={styles.holdCount}>{String(count)}</AppText>}
          sending={celebrate ? undefined : <ActivityIndicator color={color.onPrimary} />}
        >
          <Icon name={celebrate ? 'check' : 'car'} size={30} tint={color.onPrimary} />
        </HoldCircle>
        {/* the words beside the circle, for the eye: the circle carries the name and the hint for screen readers */}
        <View style={styles.flex} aria-hidden>
          <AppText variant="label">{t.visit.request}</AppText>
          <AppText variant="small" tone={hold.hint ? 'primary' : 'muted'}>
            {celebrate
              ? t.visit.requested
              : hold.phase === 'holding'
                ? `${t.home.holding} ${hold.count}`
                : hold.phase === 'sending'
                  ? t.common.sending
                  : hold.hint
                    ? t.home.holdHint
                    : t.visit.holdCaption}
          </AppText>
        </View>
      </View>
    ) : view && view.showCode ? (
      <View style={styles.codePanel}>
        <View style={styles.codeHead}>
          <IconBadge name="shield-check" size={40} />
          <View style={styles.flex}>
            <AppText variant="label">{t.visit.code.title}</AppText>
            <AppText variant="small" tone="muted">
              {t.visit.code.hint}
            </AppText>
          </View>
        </View>
        {code ? (
          <FadeIn swapKey={code.code}>
            <View style={styles.codeBox}>
              <AppText style={styles.code} center accessibilityRole="text">
                {isolate(code.code)}
              </AppText>
            </View>
            <AppText variant="small" tone="muted" center style={styles.codeExpiry}>
              {fmt(t.visit.code.expiresIn, {
                minutes: isolate(String(Math.ceil(codeSecondsLeft(code.expires_at, now) / 60))),
              })}
            </AppText>
            <Button
              label={t.visit.code.hide}
              icon="eye-off"
              variant="ghost"
              size="md"
              onPress={() => setCode(null)}
            />
          </FadeIn>
        ) : (
          <>
            <View style={[styles.codeBox, styles.codeBoxMasked]} aria-hidden>
              <AppText style={[styles.code, styles.codeMasked]} center>
                {'••••••'}
              </AppText>
            </View>
            <Button
              label={t.visit.code.show}
              icon="eye"
              loading={codeBusy}
              loadingLabel={t.visit.code.loading}
              onPress={() => void showCode()}
              testID="visit-show-code"
            />
          </>
        )}
      </View>
    ) : view && view.canRate ? (
      <Button label={t.visit.rate} icon="star" variant="secondary" onPress={() => setRating(true)} />
    ) : null;

  const footerKey = view
    ? view.canRequest
      ? 'request'
      : view.showCode
        ? 'code'
        : view.canRate
          ? 'rate'
          : 'help'
    : null;

  return (
    <Screen
      footerKey={footerKey}
      footer={
        visit && view ? (
          <>
            {primary}
            <Button
              label={t.visit.help}
              icon="message-circle"
              variant="ghost"
              size="md"
              onPress={() => void help()}
            />
          </>
        ) : undefined
      }
    >
      <ScreenHeader title={t.visit.title} backLabel={t.visit.back} onBack={back} />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      {gone ? (
        <Card>
          <AppText>{t.visit.gone}</AppText>
        </Card>
      ) : null}
      {!visit && !gone ? <SkeletonList label={t.common.loading} hero count={1} /> : null}
      {visit && view ? (
        <>
          <FadeIn swapKey={visit.status}>
            <View style={styles.hero}>
              <View style={[styles.heroBand, { backgroundColor: tint.band }]}>
                {LIVE.has(kind) ? (
                  <Pulse size={88} tint={tint.disc}>
                    <View style={[styles.heroDisc, { backgroundColor: tint.disc }]}>
                      <Icon name={HERO_ICON[kind]} size={44} tint={color.onPrimary} />
                    </View>
                  </Pulse>
                ) : (
                  <View style={[styles.heroDisc, { backgroundColor: tint.disc }]}>
                    <Icon name={HERO_ICON[kind]} size={44} tint={color.onPrimary} />
                  </View>
                )}
              </View>
              <View style={styles.heroBody}>
                <AppText variant="display" accessibilityRole="header">
                  {view.title}
                </AppText>
                {view.waiting ? (
                  <AppText variant="bodyStrong" tone="primary">
                    {view.waiting}
                  </AppText>
                ) : null}
                {elapsed ? (
                  <View style={styles.elapsed}>
                    <Icon name={elapsed.live ? 'timer' : 'clock'} size={18} tint={color.textMuted} />
                    <AppText variant="small" tone="muted">
                      {elapsed.label}
                    </AppText>
                    <AppText style={styles.elapsedValue}>{isolate(elapsed.value)}</AppText>
                  </View>
                ) : null}
                <View style={styles.divider} />
                <View style={styles.place}>
                  <IconBadge name="building" size={40} />
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong">{view.venue}</AppText>
                    <AppText variant="small" tone="muted">
                      {view.operator}
                    </AppText>
                  </View>
                </View>
                {view.plate || view.vehicle ? (
                  <View style={styles.car}>
                    {view.plate ? <PlateBadge plate={view.plate} /> : null}
                    {view.vehicle ? (
                      <AppText variant="small" tone="muted" style={styles.flex}>
                        {view.vehicle}
                      </AppText>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </View>
          </FadeIn>

          <FadeIn index={1}>
            <Card>
              <StageTracker stages={stages} progress={trackerProgress(stages)} />
            </Card>
          </FadeIn>

          {view.handoverNote ? <Banner tone="info">{view.handoverNote}</Banner> : null}

          {offerPush ? (
            <Card>
              <View style={styles.place}>
                <IconBadge name="bell-ring" size={40} />
                <View style={styles.flex}>
                  <AppText variant="label">{t.visit.pushOfferTitle}</AppText>
                  <AppText variant="small" tone="muted">
                    {t.visit.pushOfferBody}
                  </AppText>
                </View>
              </View>
              <Button
                label={t.visit.pushOfferEnable}
                variant="secondary"
                size="md"
                onPress={() => void answerOffer(true)}
              />
              <Button
                label={t.visit.pushOfferLater}
                variant="ghost"
                size="md"
                onPress={() => void answerOffer(false)}
              />
            </Card>
          ) : null}

          {/* V2-022 (payments stream): the «ادفع» area lives inside this slot */}
          <VisitPaymentSlot visit={visit} onPaid={() => void load()} />

          <FadeIn index={2}>
            <Card>
              <StepTimeline steps={view.steps} />
            </Card>
          </FadeIn>

          {visit.photos.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="label">{t.visit.photos}</AppText>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.photos}
              >
                {visit.photos.map((p, i) => (
                  <Image
                    key={p.url}
                    source={{ uri: p.url }}
                    style={styles.photo}
                    accessibilityLabel={f(t.visit.photo, { n: i + 1, count: visit.photos.length })}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          <RatingSheet
            ticketId={visit.ticket_id}
            visible={rating}
            onClose={() => setRating(false)}
            onRated={() => {
              setRating(false);
              haptic.success();
              setMessage({ tone: 'success', text: t.rating.thanks });
              void load();
            }}
          />
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
  heroBand: { alignItems: 'center', justifyContent: 'center', paddingVertical: space[6] },
  heroDisc: {
    width: 88,
    height: 88,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBody: { padding: space[4], gap: space[2] },
  elapsed: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  elapsedValue: { fontFamily: font.monoSemibold, ...fontSize.base, color: color.text },
  divider: { height: 1, backgroundColor: color.border, marginVertical: space[1] },
  place: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  car: { flexDirection: 'row', alignItems: 'center', gap: space[3], flexWrap: 'wrap' },
  holdRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  holdCount: { fontFamily: font.monoSemibold, ...fontSize['3xl'], color: color.onPrimary },
  codePanel: { gap: space[3] },
  codeHead: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  codeBox: {
    backgroundColor: color.primarySubtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.primary,
    paddingVertical: space[3],
  },
  codeBoxMasked: { backgroundColor: color.surface2, borderColor: color.border },
  // the letter spacing also follows the last digit: the same space before the first keeps the code centred
  code: {
    fontFamily: font.monoSemibold,
    ...fontSize.display,
    letterSpacing: 10,
    paddingLeft: 10,
    color: color.text,
  },
  codeMasked: { color: color.textDisabled },
  codeExpiry: { marginTop: space[2] },
  section: { gap: space[2] },
  photos: { gap: space[2] },
  photo: { width: 220, height: 150, borderRadius: radius.lg, backgroundColor: color.surface2 },
});
