/**
 * C-14 «تجميد الاشتراك» (V2-036; docs/v2/01 C-14; docs/v2/04 §7; DEC-594; the subscriptions annex clause 4): the
 * start day and the return day of a freeze asked ahead — service days only (Friday and Saturday are never offered and
 * never counted) — with the counted days it freezes and the term's new last day, previewed by the server's own rule
 * (`freezeRequestCheck`). The server decides; a refusal names its reason. Once per term, never retroactive.
 */
import type { CustomerSubscription } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { dayText, freezeDayChoices, freezePreview, todayRiyadh } from '../../features/annex';
import { errorText } from '../../features/errorText';
import { fmt } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, ChoiceChips } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { SkeletonList } from '../../ui/Skeleton';

export default function Freeze() {
  const { subscriptionId } = useLocalSearchParams<{ subscriptionId: string }>();
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [sub, setSub] = useState<CustomerSubscription | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [startsOn, setStartsOn] = useState<string | null>(null);
  const [returnsOn, setReturnsOn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayRiyadh();

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      session.api
        .subscription(subscriptionId)
        .then((s) => {
          if (cancelled) return;
          setSub(s);
          setFailure(s.can_freeze ? null : t.annex.freezeUnavailable);
        })
        .catch((e) => !cancelled && setFailure(errorText(e, t, locale)));
      return () => {
        cancelled = true;
      };
    }, [session.api, subscriptionId, t, locale]),
  );

  const weekdays = sub?.policy.service_weekdays ?? null;
  const maxDays = sub?.policy.freeze_max_days ?? 0;
  const starts = useMemo(
    () =>
      weekdays && sub?.service_end_on
        ? freezeDayChoices(today, weekdays, 10).filter((d) => d <= (sub.service_end_on as string))
        : [],
    [weekdays, sub, today],
  );
  const returns = useMemo(
    () => (weekdays && startsOn ? freezeDayChoices(today, weekdays, maxDays + 1, startsOn).slice(1) : []),
    [weekdays, startsOn, today, maxDays],
  );
  const preview = sub ? freezePreview(sub, startsOn, returnsOn, today, t) : null;

  const submit = async () => {
    if (!sub || !startsOn || !returnsOn || !preview?.ok) return;
    setBusy(true);
    try {
      await session.api.freezeSubscription(
        sub.subscription_id,
        { starts_on: startsOn, returns_on: returnsOn },
        newIdempotencyKey(),
      );
      router.replace({ pathname: '/subscriptions', params: { notice: 'frozen' } });
    } catch (e) {
      setFailure(
        isApiError(e, 'SUBSCRIPTION_FREEZE_INVALID') || isApiError(e, 'SUBSCRIPTION_FREEZE_UNAVAILABLE')
          ? t.annex.freezeUnavailable
          : errorText(e, t, locale),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      footer={
        sub?.can_freeze ? (
          <Button
            label={t.annex.freezeSubmit}
            icon="snowflake"
            loading={busy}
            disabled={!preview?.ok}
            onPress={() => void submit()}
            testID="freeze-submit"
          />
        ) : undefined
      }
    >
      <ScreenHeader title={t.annex.freezeTitle} backLabel={t.common.back} onBack={() => router.back()} />
      <DevBanner />
      {failure ? <Banner tone="warning">{failure}</Banner> : null}
      {!sub && !failure ? <SkeletonList label={t.common.loading} count={2} /> : null}
      {sub?.can_freeze ? (
        <>
          <Card>
            <View style={styles.row}>
              <Icon name="snowflake" size={18} tint={color.primary} />
              <AppText variant="bodyStrong" style={styles.flex}>
                {sub.venue_name_ar}
              </AppText>
            </View>
            <AppText variant="small" tone="muted">
              {fmt(t.annex.freezeHint, { days: maxDays })}
            </AppText>
            {sub.service_start_on && sub.service_end_on ? (
              <AppText variant="small">
                {fmt(t.annex.period, {
                  start: dayText(sub.service_start_on, t),
                  end: dayText(sub.service_end_on, t),
                })}
              </AppText>
            ) : null}
          </Card>
          <ChoiceChips
            label={t.annex.freezeStart}
            options={starts.map((d) => ({ value: d, label: dayText(d, t) }))}
            value={startsOn}
            onChange={(d) => {
              setStartsOn(d);
              setReturnsOn(null);
            }}
          />
          {startsOn ? (
            <ChoiceChips
              label={t.annex.freezeReturn}
              options={returns.map((d) => ({ value: d, label: dayText(d, t) }))}
              value={returnsOn}
              onChange={setReturnsOn}
            />
          ) : null}
          {preview?.ok && preview.newEnd ? (
            <Banner tone="info">
              {fmt(t.annex.freezeSummary, { days: preview.days, end: dayText(preview.newEnd, t) })}
            </Banner>
          ) : null}
          {preview?.issue ? <Banner tone="warning">{preview.issue}</Banner> : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
});
