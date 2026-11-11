/**
 * C-15 سياراتي (V2-012): the account's cars, «أضف سيارة» (the C-05 form, up to five) and «حذف» after a
 * confirmation. A car in a visit in progress shows «في زيارة جارية» and offers no removal; the server refuses it
 * anyway (`CUSTOMER_VEHICLE_IN_ACTIVE_VISIT`, DEC-505). One Idempotency-Key per removal.
 */
import { CUSTOMER_VEHICLES_MAX, type CustomerVehicle } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { errorText } from '../features/errorText';
import { canAddVehicle, removeIssueFromError, vehicleRow } from '../features/vehicles';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Screen } from '../ui/Screen';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function Vehicles() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerVehicle[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setItems(await session.api.vehicles());
    } catch (e) {
      setMessage({ tone: 'danger', text: `${t.vehicles.loadFailed} ${errorText(e, t, locale)}` });
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const remove = async (v: CustomerVehicle) => {
    setBusy(v.id);
    setMessage(null);
    try {
      await session.api.removeVehicle(v.id, newIdempotencyKey());
      setMessage({ tone: 'success', text: t.vehicles.removed });
    } catch (e) {
      const issue = removeIssueFromError(e);
      setMessage(
        issue === 'in_visit'
          ? { tone: 'warning', text: t.vehicles.inVisitHint }
          : issue === 'gone'
            ? { tone: 'warning', text: t.vehicles.gone }
            : { tone: 'danger', text: errorText(e, t, locale) },
      );
    } finally {
      setBusy(null);
      await load();
    }
  };

  const confirmRemove = (v: CustomerVehicle) =>
    Alert.alert(t.vehicles.confirmTitle, f(t.vehicles.confirmBody, { plate: vehicleRow(v, t).plate }), [
      { text: t.vehicles.cancel, style: 'cancel' },
      { text: t.vehicles.confirm, style: 'destructive', onPress: () => void remove(v) },
    ]);

  const count = items?.length ?? 0;
  return (
    <Screen
      footer={
        items ? (
          canAddVehicle(count) ? (
            <Button
              label={t.vehicles.add}
              onPress={() => router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })}
            />
          ) : (
            <AppText tone="muted" center>
              {f(t.vehicles.limitReached, { max: CUSTOMER_VEHICLES_MAX })}
            </AppText>
          )
        ) : undefined
      }
    >
      <ScreenHeader title={t.vehicles.title} backLabel={t.vehicles.back} onBack={() => router.back()} />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      {!items ? <SkeletonList label={t.common.loading} count={2} avatar /> : null}
      {items && items.length === 0 ? <EmptyState icon="car" text={t.vehicles.empty} /> : null}
      {items?.map((v) => {
        const row = vehicleRow(v, t);
        return (
          <Card key={row.id}>
            <AppText style={styles.plate}>{row.plate}</AppText>
            {row.details ? <AppText tone="muted">{row.details}</AppText> : null}
            {row.inActiveVisit ? (
              <View style={styles.badge} accessibilityRole="text">
                <AppText variant="small" style={styles.badgeText}>
                  {t.vehicles.inVisit}
                </AppText>
                <AppText variant="small" tone="muted">
                  {t.vehicles.inVisitHint}
                </AppText>
              </View>
            ) : null}
            {row.canRemove ? (
              <Button
                label={t.vehicles.remove}
                variant="secondary"
                size="md"
                loading={busy === row.id}
                loadingLabel={t.common.saving}
                disabled={busy !== null && busy !== row.id}
                accessibilityHint={f(t.vehicles.removeLabel, { plate: row.plate })}
                onPress={() => confirmRemove(v)}
              />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  plate: { fontFamily: font.mono, ...fontSize.xl },
  badge: { gap: space[1] },
  badgeText: { color: color.warningText, fontFamily: font.semibold },
});
