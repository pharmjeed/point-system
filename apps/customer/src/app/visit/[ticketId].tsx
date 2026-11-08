/**
 * C-12 سيارتي الآن (V2-015; docs/v2/01 R3/R4, DEC-516 … DEC-520): the live state with its timeline, the intake photos
 * (short-lived links read again on every display), «اطلب السيارة» after a confirmation, the waiting and ready states,
 * the handover code card while the car is ready (fetched on demand, kept in memory only — DEC-38), «مساعدة» (the
 * support WhatsApp of the build), the payment area (VisitPaymentSlot: V2-022 adds «ادفع» there), and C-13 after the
 * delivery. It reads the visit again on every `visit.updated` of the customer socket, on every (re)connection and
 * when it comes back into view: the server is the source of truth. Offline, the request is refused with the WhatsApp
 * and driver alternatives (01 §4).
 */
import type { CustomerHandoverCode, CustomerVisitDetail } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/errors';
import { NetworkError } from '../../api/transport';
import { appConfig } from '../../config';
import { CommandKey } from '../../features/commandKey';
import { errorText } from '../../features/errorText';
import { shouldOfferPush } from '../../features/push';
import { codeSecondsLeft, helpLink, visitView } from '../../features/visit';
import { fmt, isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { usePush } from '../../push/usePush';
import { flags, newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { openLink } from '../../ui/openLinks';
import { RatingSheet } from '../../ui/RatingSheet';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { VisitPaymentSlot } from '../../ui/VisitPaymentSlot';

type Message = { tone: 'success' | 'danger' | 'warning' | 'info'; text: string } | null;

export default function VisitScreen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const push = usePush(t.visit.title);
  const [visit, setVisit] = useState<CustomerVisitDetail | null>(null);
  const [gone, setGone] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<CustomerHandoverCode | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [rating, setRating] = useState(false);
  const [offered, setOffered] = useState(true);
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

  // the code's countdown, and its card again when the code is shown
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  useEffect(() => {
    void flags.pushOffered().then(setOffered);
  }, []);

  const request = async () => {
    if (!ticketId) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await session.api.requestVisit(ticketId, key.for('request'));
      key.reset();
      setVisit(r.visit);
      setMessage({
        tone: 'success',
        text: r.outcome === 'requested_early' ? t.visit.requestedEarly : t.visit.requested,
      });
    } catch (e) {
      if (e instanceof NetworkError) setMessage({ tone: 'warning', text: t.visit.offline });
      else if (e instanceof ApiError && e.code === 'RETRIEVAL_ALREADY_ACTIVE') {
        key.reset();
        setMessage({ tone: 'info', text: t.visit.alreadyRequested });
      } else setMessage({ tone: 'danger', text: errorText(e, t, locale) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const confirmRequest = () =>
    Alert.alert(t.visit.requestConfirmTitle, t.visit.requestConfirmBody, [
      { text: t.visit.requestCancel, style: 'cancel' },
      { text: t.visit.requestConfirm, onPress: () => void request() },
    ]);

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

  return (
    <Screen
      footer={
        view && view.canRequest ? (
          <Button
            label={t.visit.request}
            loading={busy}
            loadingLabel={t.common.sending}
            onPress={confirmRequest}
            testID="visit-request"
          />
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
      {!visit && !gone ? (
        <ActivityIndicator color={color.primary} accessibilityLabel={t.common.loading} />
      ) : null}
      {visit && view ? (
        <>
          <Card accent>
            <AppText variant="cardTitle" accessibilityRole="header">
              {view.title}
            </AppText>
            <AppText>{view.venue}</AppText>
            <AppText variant="small" tone="muted">
              {view.operator}
            </AppText>
            {view.plate ? <AppText style={styles.mono}>{view.plate}</AppText> : null}
            {view.vehicle ? <AppText tone="muted">{view.vehicle}</AppText> : null}
            {view.waiting ? <AppText tone="primary">{view.waiting}</AppText> : null}
          </Card>

          {view.showCode ? (
            <Card accent>
              <AppText variant="label">{t.visit.code.title}</AppText>
              <AppText tone="muted">{t.visit.code.hint}</AppText>
              {code ? (
                <>
                  <AppText style={styles.code} center accessibilityRole="text">
                    {isolate(code.code)}
                  </AppText>
                  <AppText variant="small" tone="muted" center>
                    {fmt(t.visit.code.expiresIn, {
                      minutes: isolate(String(Math.ceil(codeSecondsLeft(code.expires_at, now) / 60))),
                    })}
                  </AppText>
                  <Button label={t.visit.code.hide} variant="ghost" size="md" onPress={() => setCode(null)} />
                </>
              ) : (
                <Button
                  label={t.visit.code.show}
                  loading={codeBusy}
                  loadingLabel={t.visit.code.loading}
                  onPress={() => void showCode()}
                  testID="visit-show-code"
                />
              )}
            </Card>
          ) : null}
          {view.handoverNote ? <Banner tone="info">{view.handoverNote}</Banner> : null}

          {offerPush ? (
            <Card>
              <AppText variant="label">{t.visit.pushOfferTitle}</AppText>
              <AppText tone="muted">{t.visit.pushOfferBody}</AppText>
              <Button label={t.visit.pushOfferEnable} size="md" onPress={() => void answerOffer(true)} />
              <Button
                label={t.visit.pushOfferLater}
                variant="ghost"
                size="md"
                onPress={() => void answerOffer(false)}
              />
            </Card>
          ) : null}

          <Card>
            {view.steps.map((s) => (
              <View key={s.step} style={styles.step} accessibilityRole="text">
                <View
                  style={[
                    styles.dot,
                    s.state === 'done' && styles.dotDone,
                    s.state === 'current' && styles.dotCurrent,
                  ]}
                />
                <AppText
                  style={styles.flex}
                  variant={s.state === 'current' ? 'bodyStrong' : 'body'}
                  tone={s.state === 'todo' ? 'muted' : 'default'}
                >
                  {s.label}
                </AppText>
                {s.time ? (
                  <AppText variant="small" tone="muted">
                    {s.time}
                  </AppText>
                ) : null}
              </View>
            ))}
          </Card>

          {/* V2-022 (payments stream): the «ادفع» area lives inside this slot */}
          <VisitPaymentSlot visit={visit} />

          {visit.photos.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="label">{t.visit.photos}</AppText>
              <ScrollView horizontal contentContainerStyle={styles.photos}>
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

          {view.canRate ? (
            <Button label={t.visit.rate} variant="secondary" size="md" onPress={() => setRating(true)} />
          ) : null}
          <Button label={t.visit.help} variant="ghost" size="md" onPress={() => void help()} />
          <RatingSheet
            ticketId={visit.ticket_id}
            visible={rating}
            onClose={() => setRating(false)}
            onRated={() => {
              setRating(false);
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
  mono: { fontFamily: font.mono, ...fontSize.lg },
  code: { fontFamily: font.monoSemibold, ...fontSize.display, letterSpacing: 6, color: color.text },
  step: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 32 },
  dot: { width: 12, height: 12, borderRadius: radius.full, borderWidth: 2, borderColor: color.borderStrong },
  dotDone: { backgroundColor: color.success, borderColor: color.success },
  dotCurrent: { backgroundColor: color.primary, borderColor: color.primary },
  section: { gap: space[2] },
  photos: { gap: space[2] },
  photo: { width: 220, height: 150, borderRadius: radius.lg, backgroundColor: color.surface2 },
});
