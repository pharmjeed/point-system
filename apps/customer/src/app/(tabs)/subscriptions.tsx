/**
 * C-14 اشتراكاتي (V2-032; docs/v2/01 R2; docs/v2/04 §1; DEC-532, DEC-534): each subscription with its venue, state,
 * price and cycle, the one line that matters now (renews on / ends on / waiting for payment / past due / frozen), the
 * covered car(s), and the commands the server allows (`can_*`): «إلغاء التجديد» (effective at the end of the period,
 * undone by «استئناف التجديد»), «ادفع الآن» (a subscription waiting for its payment or in its grace — C-10), «تغيير
 * السيارة» (once per period). Read again on focus and on every `subscription.updated`.
 */
import type { CustomerSubscription, CustomerVehicle } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { errorText } from '../../features/errorText';
import { PaySheet } from '../../features/pay';
import { coverableVehicles, subscriptionCard, toggleVehicle } from '../../features/subscriptions';
import { useI18n } from '../../i18n/I18nProvider';
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, Checkbox } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { Screen } from '../../ui/Screen';
import { SkeletonList } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/EmptyState';
import { ScreenHeader } from '../../ui/ScreenHeader';

type Message = { tone: 'success' | 'danger' | 'warning'; text: string };

const TEXT_TONE = { success: 'success', warning: 'primary', danger: 'danger', muted: 'muted' } as const;

export default function Subscriptions() {
  const params = useLocalSearchParams<{ notice?: string; venue?: string }>();
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerSubscription[] | null>(null);
  const [vehicles, setVehicles] = useState<CustomerVehicle[]>([]);
  const [message, setMessage] = useState<Message | null>(
    params.notice === 'subscribed'
      ? { tone: 'success', text: f(t.subscribe.success, { venue: params.venue ?? '' }) }
      : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; chosen: string[] } | null>(null);
  const [paying, setPaying] = useState<CustomerSubscription | null>(null);

  const load = useCallback(async () => {
    try {
      const [subs, cars] = await Promise.all([session.api.subscriptions(), session.api.vehicles()]);
      setItems(subs);
      setVehicles(cars);
    } catch (e) {
      setMessage({ tone: 'danger', text: errorText(e, t, locale) });
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(
    () =>
      session.events.subscribe({
        onVisit: () => undefined,
        onSubscription: () => void load(),
        onResync: () => void load(),
      }),
    [session.events, load],
  );

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: 'success', text: done });
      setEditing(null);
    } catch (e) {
      setMessage({
        tone: 'warning',
        text: isApiError(e, 'SUBSCRIPTION_VEHICLES_LOCKED')
          ? t.subscriptions.locked
          : errorText(e, t, locale),
      });
    } finally {
      setBusy(null);
      await load();
    }
  };

  const cancel = (s: CustomerSubscription) => {
    const run = () =>
      void act(
        `cancel:${s.subscription_id}`,
        () => session.api.cancelSubscription(s.subscription_id, newIdempotencyKey()),
        t.subscriptions.done.canceled,
      );
    if (s.status === 'pending_payment') return run();
    Alert.alert(t.subscriptions.cancel, t.subscriptions.cancelConfirm, [
      { text: t.common.back, style: 'cancel' },
      { text: t.subscriptions.cancel, style: 'destructive', onPress: run },
    ]);
  };

  const cars = coverableVehicles(vehicles);

  return (
    <Screen tab>
      <ScreenHeader title={t.subscriptions.title} />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      {!items ? <SkeletonList label={t.common.loading} count={2} /> : null}
      {items && items.length === 0 ? (
        <EmptyState
          icon="calendar-check"
          text={t.subscriptions.empty}
          action={
            <Button
              label={t.subscriptions.browse}
              icon="map"
              variant="secondary"
              size="md"
              onPress={() => router.push('/locations')}
            />
          }
        />
      ) : null}
      {items?.map((s) => {
        const card = subscriptionCard(s, t, locale);
        const id = s.subscription_id;
        const edit = editing?.id === id ? editing : null;
        return (
          <Card key={id} accent={s.status === 'active'}>
            <AppText variant="cardTitle">{card.title}</AppText>
            <AppText variant="bodyStrong" tone={TEXT_TONE[card.tone]}>
              {card.status}
            </AppText>
            <AppText>{card.price}</AppText>
            {card.line ? <AppText tone="muted">{card.line}</AppText> : null}
            {card.vehicles ? <AppText variant="small">{card.vehicles}</AppText> : null}
            {card.nextPrice ? (
              <AppText variant="small" tone="primary">
                {card.nextPrice}
              </AppText>
            ) : null}
            {s.can_pay ? (
              <Button
                label={t.subscriptions.pay}
                size="md"
                onPress={() => setPaying(s)}
                testID={`pay-${id}`}
              />
            ) : null}
            {s.can_resume ? (
              <Button
                label={t.subscriptions.resume}
                variant="secondary"
                size="md"
                loading={busy === `resume:${id}`}
                disabled={busy !== null}
                onPress={() =>
                  void act(
                    `resume:${id}`,
                    () => session.api.resumeSubscription(id, newIdempotencyKey()),
                    t.subscriptions.done.resumed,
                  )
                }
              />
            ) : null}
            {s.can_change_vehicles && !edit ? (
              <Button
                label={t.subscriptions.changeVehicle}
                variant="secondary"
                size="md"
                disabled={busy !== null}
                onPress={() =>
                  setEditing({ id, chosen: s.vehicles.filter((v) => !v.removed).map((v) => v.vehicle_id) })
                }
              />
            ) : null}
            {edit ? (
              <View style={styles.edit}>
                <AppText variant="small" tone="muted">
                  {`${f(t.subscribe.vehiclesHint, { n: s.vehicles_included })} ${t.subscriptions.changeVehicleHint}`}
                </AppText>
                {cars.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={c.label}
                    checked={edit.chosen.includes(c.id)}
                    onChange={() =>
                      setEditing({ id, chosen: toggleVehicle(edit.chosen, c.id, s.vehicles_included) })
                    }
                  />
                ))}
                <Button
                  label={t.subscriptions.save}
                  size="md"
                  loading={busy === `vehicles:${id}`}
                  disabled={edit.chosen.length === 0 || busy !== null}
                  onPress={() =>
                    void act(
                      `vehicles:${id}`,
                      () => session.api.setSubscriptionVehicles(id, edit.chosen, newIdempotencyKey()),
                      t.subscriptions.done.vehicles,
                    )
                  }
                />
                <Button label={t.pay.cancel} variant="ghost" size="md" onPress={() => setEditing(null)} />
              </View>
            ) : null}
            {s.can_cancel ? (
              <Button
                label={
                  s.status === 'pending_payment' ? t.subscriptions.cancelPending : t.subscriptions.cancel
                }
                variant="ghost"
                size="md"
                loading={busy === `cancel:${id}`}
                disabled={busy !== null}
                onPress={() => cancel(s)}
              />
            ) : null}
          </Card>
        );
      })}
      {paying ? (
        <PaySheet
          visible
          amountHalalas={paying.next_price_halalas ?? paying.price_halalas}
          title={subscriptionCard(paying, t, locale).title}
          onClose={() => {
            setPaying(null);
            void load();
          }}
          onPaid={() => {
            setPaying(null);
            setMessage({ tone: 'success', text: t.pay.paid });
            void load();
          }}
          subscription={{
            start: (body, idempotencyKey) =>
              session.api.paySubscription(paying.subscription_id, body, idempotencyKey),
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  edit: { gap: space[2] },
});
