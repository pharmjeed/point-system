/**
 * C-11 بطاقة الدخول (V2-013, V2-D14; DEC-500): the QR the driver scans at the gate (O-01). It changes every 30 seconds
 * and is drawn on the device from the secret cached in secure storage, so it works with no network; online, the
 * screen refreshes the secret and the server-time offset first. The account's cars to choose from when there are
 * several (the token names the chosen one). The screen asks for full brightness while it is shown and gives the
 * device's own back when it goes. Logic in ../features/pass.ts (unit-tested); this file only renders it.
 *
 * V2-UX (DEC-578): the pass as a card — the brand mark, the hint, the large code on its white square, a countdown
 * ring emptying towards the next code (the code's own clock), a perforated edge, and the car as a `PlateBadge`; a
 * brightness note under it. Skeleton while the pass is prepared.
 */
import * as Brightness from 'expo-brightness';
import { useFocusEffect, useRouter } from 'expo-router';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PASS_STEP_S } from '@point/shared/customer';
import { StyleSheet, View } from 'react-native';
import {
  chosenVehicle,
  loadPass,
  passQr,
  qrRuns,
  secondsLeft,
  type PassCache,
  type PassLoad,
} from '../features/pass';
import { useI18n } from '../i18n/I18nProvider';
import { securePassStore } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from '../ui/Animated';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, ChoiceChips } from '../ui/Controls';
import { CountdownRing } from '../ui/CountdownRing';
import { Icon } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { PlateBadge } from '../ui/PlateBadge';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';
import { SkeletonList } from '../ui/Skeleton';

/** Side of the drawn code, quiet zone included (a phone held to a driver's camera at arm's length). */
const QR_SIZE = 280;

/** Full brightness while the code is on screen (01 C-11 «زد السطوع» تلقائيًا); best effort, never blocks. */
function useFullBrightness() {
  useFocusEffect(
    useCallback(() => {
      let previous: number | null = null;
      void (async () => {
        try {
          previous = await Brightness.getBrightnessAsync();
          await Brightness.setBrightnessAsync(1);
        } catch {
          // a device without the API keeps its brightness
        }
      })();
      return () => {
        void (async () => {
          try {
            if (previous !== null) await Brightness.setBrightnessAsync(previous);
            await Brightness.restoreSystemBrightnessAsync?.();
          } catch {
            // nothing to restore
          }
        })();
      };
    }, []),
  );
}

export default function Pass() {
  const { t, f, brand } = useI18n();
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<PassLoad | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useFullBrightness();

  const load = useCallback(async () => {
    setState(null);
    setState(
      await loadPass({
        fetchPass: () => session.api.pass(),
        store: securePassStore,
        accountId: session.me?.id ?? null,
        now: Date.now,
      }),
    );
  }, [session.api, session.me?.id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // re-render at each new step (the countdown ticks every second)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cache: PassCache | null = state && state.kind !== 'unavailable' ? state.cache : null;
  const vehicle = cache ? chosenVehicle(cache, vehicleId) : null;
  const qr = cache ? passQr(cache, vehicle?.vehicle_id ?? null, now) : null;
  // the token changes once a step: the matrix is encoded again only then
  const token = qr?.token ?? null;
  const runs = useMemo(
    () => (token ? qrRuns(QRCode.create(token, { errorCorrectionLevel: 'M' }).modules) : null),
    [token],
  );

  return (
    <Screen footer={<Button label={t.common.back} variant="secondary" onPress={() => router.back()} />}>
      <ScreenHeader title={t.pass.title} backLabel={t.common.back} onBack={() => router.back()} />
      {!state ? (
        <SkeletonList label={t.pass.loading} hero count={0} />
      ) : state.kind === 'unavailable' ? (
        <>
          <Banner tone="warning">{t.pass.unavailable}</Banner>
          <Button label={t.pass.retry} icon="refresh" variant="secondary" onPress={() => void load()} />
        </>
      ) : (
        <>
          {state.kind === 'offline' ? <Banner tone="info">{t.pass.offline}</Banner> : null}
          <FadeIn>
            <View style={styles.pass}>
              <View style={styles.passHead}>
                <Logo variant="mark" height={24} label={brand} />
                <AppText style={styles.brand}>{brand}</AppText>
                <View style={styles.flex} />
                <Icon name="qr-code" size={20} tint={color.primaryText} />
              </View>
              <View style={styles.passBody}>
                <AppText center>{t.pass.hint}</AppText>
                <View style={styles.qrFrame}>
                  <View
                    style={styles.qr}
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={t.pass.qrLabel}
                    testID="pass-qr"
                  >
                    {runs?.map((row, y) => {
                      const c = cell(runs.length);
                      return (
                        <View key={y} style={[styles.row, { height: c }]}>
                          {row.map(([x, n]) => (
                            <View key={x} style={[styles.dark, { left: x * c, width: n * c, height: c }]} />
                          ))}
                        </View>
                      );
                    })}
                  </View>
                </View>
                {qr ? (
                  <View style={styles.countdown} accessibilityLiveRegion="polite">
                    <CountdownRing left={secondsLeft(qr)} total={PASS_STEP_S} size={40} />
                    <AppText tone="muted">
                      {f(t.pass.changesIn, { seconds: String(secondsLeft(qr)) })}
                    </AppText>
                  </View>
                ) : null}
              </View>
              {/* the perforated edge of a ticket */}
              <View style={styles.perforation}>
                <View style={styles.notch} />
                <View style={styles.dashes} />
                <View style={styles.notch} />
              </View>
              <View style={styles.passFoot}>
                {cache && cache.pass.vehicles.length > 1 ? (
                  <ChoiceChips
                    label={t.pass.vehicle}
                    options={cache.pass.vehicles.map((v) => ({
                      value: v.vehicle_id,
                      label: v.plate_display,
                    }))}
                    value={vehicle?.vehicle_id ?? null}
                    onChange={(next) => next && setVehicleId(next)}
                  />
                ) : vehicle ? (
                  <View style={styles.vehicle}>
                    <Icon name="car-front" size={22} tint={color.textMuted} />
                    <AppText tone="muted">{`${t.pass.vehicle}: `}</AppText>
                    <PlateBadge plate={vehicle.plate_display} size="lg" />
                  </View>
                ) : (
                  <>
                    <Banner tone="info">{t.pass.noVehicle}</Banner>
                    <Button
                      label={t.pass.addVehicle}
                      icon="plus"
                      variant="secondary"
                      onPress={() => router.push('/vehicle')}
                    />
                  </>
                )}
              </View>
            </View>
          </FadeIn>
          <View style={styles.hintRow}>
            <Icon name="sun" size={18} tint={color.textMuted} />
            <AppText variant="small" tone="muted" style={styles.flex}>
              {t.pass.brightness}
            </AppText>
          </View>
          {/* V2-036 (annex clause 6, DEC-605): the valuables reminder at the handover of the car */}
          <View style={styles.hintRow}>
            <Icon name="car" size={18} tint={color.textMuted} />
            <AppText variant="small" tone="muted" style={styles.flex}>
              {t.annex.valuables}
            </AppText>
          </View>
        </>
      )}
    </Screen>
  );
}

/** Module size for a code of `n` modules inside the padded white square (the quiet zone). */
const cell = (n: number) => Math.floor((QR_SIZE - space[6] * 2) / n);

const NOTCH = 20;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pass: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.lg,
    overflow: 'hidden',
  },
  passHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    backgroundColor: color.primarySubtle,
  },
  brand: { fontFamily: font.bold, ...fontSize.lg, color: color.text },
  passBody: { padding: space[4], gap: space[3], alignItems: 'center' },
  qrFrame: {
    padding: space[2],
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: color.primarySubtle,
  },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  perforation: { flexDirection: 'row', alignItems: 'center', height: NOTCH },
  // half of each notch sits outside the card (clipped): a round bite on both edges
  notch: {
    width: NOTCH,
    height: NOTCH,
    borderRadius: radius.full,
    backgroundColor: color.bg,
    marginHorizontal: -NOTCH / 2,
  },
  dashes: {
    flex: 1,
    marginHorizontal: space[2],
    borderTopWidth: 2,
    borderStyle: 'dashed',
    borderColor: color.border,
  },
  passFoot: { padding: space[4], gap: space[3] },
  vehicle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    flexWrap: 'wrap',
  },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[2] },
  qr: {
    alignSelf: 'center',
    width: QR_SIZE,
    height: QR_SIZE,
    padding: space[6],
    backgroundColor: color.surface,
    borderRadius: radius.md,
    // the code is never mirrored in RTL
    direction: 'ltr',
  },
  row: { position: 'relative' },
  dark: { position: 'absolute', top: 0, backgroundColor: color.text },
});
