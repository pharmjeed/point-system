/**
 * C-11 بطاقة الدخول (V2-013, V2-D14; DEC-500): the QR the driver scans at the gate (O-01). It changes every 30 seconds
 * and is drawn on the device from the secret cached in secure storage, so it works with no network; online, the
 * screen refreshes the secret and the server-time offset first. The account's cars to choose from when there are
 * several (the token names the chosen one). The screen asks for full brightness while it is shown and gives the
 * device's own back when it goes. Logic in ../features/pass.ts (unit-tested); this file only renders it.
 */
import * as Brightness from 'expo-brightness';
import { useFocusEffect, useRouter } from 'expo-router';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
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
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card, ChoiceChips } from '../ui/Controls';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

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
  const { t, f } = useI18n();
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
        <View style={styles.center}>
          <ActivityIndicator color={color.primary} size="large" accessibilityLabel={t.pass.loading} />
        </View>
      ) : state.kind === 'unavailable' ? (
        <>
          <Banner tone="warning">{t.pass.unavailable}</Banner>
          <Button label={t.pass.retry} variant="secondary" onPress={() => void load()} />
        </>
      ) : (
        <>
          {state.kind === 'offline' ? <Banner tone="info">{t.pass.offline}</Banner> : null}
          <Card>
            <AppText center>{t.pass.hint}</AppText>
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
            {qr ? (
              <View accessibilityLiveRegion="polite">
                <AppText center tone="muted">
                  {f(t.pass.changesIn, { seconds: String(secondsLeft(qr)) })}
                </AppText>
              </View>
            ) : null}
          </Card>
          {cache && cache.pass.vehicles.length > 1 ? (
            <ChoiceChips
              label={t.pass.vehicle}
              options={cache.pass.vehicles.map((v) => ({ value: v.vehicle_id, label: v.plate_display }))}
              value={vehicle?.vehicle_id ?? null}
              onChange={(next) => next && setVehicleId(next)}
            />
          ) : vehicle ? (
            <AppText center>{`${t.pass.vehicle}: ${vehicle.plate_display}`}</AppText>
          ) : (
            <>
              <Banner tone="info">{t.pass.noVehicle}</Banner>
              <Button label={t.pass.addVehicle} variant="secondary" onPress={() => router.push('/vehicle')} />
            </>
          )}
        </>
      )}
    </Screen>
  );
}

/** Module size for a code of `n` modules inside the padded white square (the quiet zone). */
const cell = (n: number) => Math.floor((QR_SIZE - space[6] * 2) / n);

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: space[6] },
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
