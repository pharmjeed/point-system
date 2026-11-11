/**
 * C-09 اختيار الباقة (V2-032; docs/v2/01 R2; DEC-532, DEC-534): the plans of the location (monthly / yearly with the
 * yearly saving), the covered car(s) — 1 … the plan's cars, chosen from «سياراتي» — the terms, then «متابعة إلى الدفع»
 * opens C-10 (the pay sheet of C-12 in its subscription mode: a saved card, or a new card kept for the renewals; Apple
 * Pay is not offered). Paid → C-14. Every price, date and refusal comes from the server.
 *
 * V2-UX (DEC-579): the cycle as a segmented control with the yearly saving on its segment, the plans as selectable
 * cards (name, the price large, the cars, the saving badge; a tick when chosen), the covered cars, and a summary card
 * with the total; «متابعة إلى الدفع» in the sticky bottom sheet. Skeletons while loading.
 */
import type { CustomerLocationDetail, CustomerVehicle } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { errorText } from '../../features/errorText';
import { PaySheet } from '../../features/pay';
import {
  coverableVehicles,
  cyclesOf,
  planOptions,
  subscribeIssue,
  toggleVehicle,
  type Cycle,
} from '../../features/subscriptions';
import { bestYearlySaving } from '../../features/ux';
import { fmt } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, shadow, space } from '../../theme/tokens';
import { FadeIn } from '../../ui/Animated';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, Checkbox, IconBadge, SegmentedControl } from '../../ui/Controls';
import { Icon } from '../../ui/Icon';
import { Touchable } from '../../ui/Touchable';
import { DevBanner } from '../../ui/DevBanner';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { SkeletonList } from '../../ui/Skeleton';

export default function Subscribe() {
  const { venueId } = useLocalSearchParams<{ venueId: string }>();
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [loc, setLoc] = useState<CustomerLocationDetail | null>(null);
  const [vehicles, setVehicles] = useState<CustomerVehicle[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [planId, setPlanId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [detail, cars] = await Promise.all([session.api.location(venueId), session.api.vehicles()]);
          if (cancelled) return;
          setLoc(detail);
          setVehicles(cars);
          setFailure(detail.plans.length === 0 ? t.subscribe.unavailable : null);
          const cycles = cyclesOf(detail.plans);
          setCycle((c) => (cycles.includes(c) ? c : (cycles[0] ?? 'monthly')));
          // one car on the account: it is the obvious choice
          setChosen((c) => (c.length === 0 && cars.length === 1 ? [cars[0]!.id] : c));
        } catch (e) {
          if (cancelled) return;
          setFailure(isApiError(e, 'VENUE_NOT_LISTED') ? t.locations.notListed : errorText(e, t, locale));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [session.api, venueId, t, locale]),
  );

  const plans = useMemo(() => planOptions(loc?.plans ?? [], cycle, t), [loc, cycle, t]);
  const cycles = cyclesOf(loc?.plans ?? []);
  const plan = plans.find((p) => p.planId === planId) ?? null;
  const max = loc?.plans.find((p) => p.plan_id === planId)?.vehicles_included ?? 1;
  const cars = coverableVehicles(vehicles ?? []);
  const venue = loc ? (locale === 'en' && loc.name_en ? loc.name_en : loc.name_ar) : '';
  const saving = loc ? bestYearlySaving(loc.plans) : null;

  const choosePlan = (id: string | null) => {
    setPlanId(id);
    const included = loc?.plans.find((p) => p.plan_id === id)?.vehicles_included ?? 1;
    setChosen((c) => (c.length > included ? c.slice(c.length - included) : c));
    setIssue(null);
  };

  const proceed = () => {
    const problem = subscribeIssue(plan ? plan.planId : null, chosen, t);
    setIssue(problem);
    if (!problem) setPaying(true);
  };

  return (
    <Screen
      footer={
        loc && plans.length > 0 && cars.length > 0 ? (
          <Button label={t.subscribe.pay} icon="credit-card" onPress={proceed} testID="subscribe-pay" />
        ) : undefined
      }
    >
      <ScreenHeader
        title={loc ? f(t.subscribe.title, { venue }) : t.subscribe.action}
        backLabel={t.common.back}
        onBack={() => router.back()}
      />
      <DevBanner />
      {failure ? <Banner tone={loc ? 'warning' : 'danger'}>{failure}</Banner> : null}
      {!loc && !failure ? <SkeletonList label={t.common.loading} count={3} /> : null}
      {loc && cycles.length > 0 ? (
        <>
          {cycles.length > 1 ? (
            <SegmentedControl
              label={t.subscribe.cycle}
              options={cycles.map((c) => ({
                value: c,
                label: t.subscribe[c],
                badge: c === 'yearly' && saving !== null ? fmt(t.subscribe.saving, { pct: saving }) : null,
              }))}
              value={cycle}
              onChange={(c) => {
                if (c === cycle) return;
                setCycle(c);
                setPlanId(null);
              }}
            />
          ) : null}
          <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={t.subscribe.plan}>
            <AppText variant="label">{t.subscribe.plan}</AppText>
            {plans.map((p, i) => {
              const on = p.planId === planId;
              return (
                <FadeIn key={p.planId} index={i} swapKey={cycle}>
                  <Touchable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${p.title} · ${p.priceText}`}
                    onPress={() => choosePlan(on ? null : p.planId)}
                    feedback="select"
                    style={({ pressed }) => [
                      styles.plan,
                      on && styles.planOn,
                      pressed && !on && { backgroundColor: color.surface2 },
                    ]}
                  >
                    <View style={styles.planHead}>
                      <IconBadge name="calendar-check" size={40} />
                      <View style={styles.flex}>
                        <AppText variant="bodyStrong">{p.title}</AppText>
                        <AppText variant="small" tone="muted">
                          {p.vehicles}
                        </AppText>
                      </View>
                      <View style={[styles.radio, on && styles.radioOn]}>
                        {on ? <Icon name="check" size={16} tint={color.onPrimary} strokeWidth={3} /> : null}
                      </View>
                    </View>
                    <View style={styles.planFoot}>
                      <AppText style={styles.planPrice}>{p.priceText}</AppText>
                      {p.saving ? (
                        <View style={styles.saving}>
                          <Icon name="badge-percent" size={14} tint={color.successText} />
                          <AppText variant="caption" style={styles.savingText}>
                            {p.saving}
                          </AppText>
                        </View>
                      ) : null}
                    </View>
                  </Touchable>
                </FadeIn>
              );
            })}
          </View>
          <View style={styles.group}>
            <AppText variant="label">{t.subscribe.vehicles}</AppText>
            {cars.length === 0 ? (
              <Card>
                <AppText tone="muted">{t.subscribe.noVehicles}</AppText>
                <Button
                  label={t.subscribe.addVehicle}
                  variant="secondary"
                  size="md"
                  onPress={() => router.push({ pathname: '/vehicle', params: { from: 'vehicles' } })}
                />
              </Card>
            ) : (
              <>
                <AppText variant="small" tone="muted">
                  {f(t.subscribe.vehiclesHint, { n: max })}
                </AppText>
                {cars.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={c.label}
                    checked={chosen.includes(c.id)}
                    onChange={() => {
                      setChosen((list) => toggleVehicle(list, c.id, max));
                      setIssue(null);
                    }}
                  />
                ))}
              </>
            )}
          </View>
          <Card>
            <View style={styles.planHead}>
              <Icon name="info" size={18} tint={color.textMuted} />
              <AppText variant="small" tone="muted" style={styles.flex}>
                {t.subscribe.terms}
              </AppText>
            </View>
            {plan ? (
              <FadeIn swapKey={plan.planId}>
                <View style={styles.total}>
                  <AppText style={styles.totalText}>
                    {t.subscribe.total}: {plan.priceText}
                  </AppText>
                </View>
              </FadeIn>
            ) : null}
          </Card>
          {issue ? <Banner tone="warning">{issue}</Banner> : null}
        </>
      ) : null}
      {plan ? (
        <PaySheet
          visible={paying}
          amountHalalas={plan.price}
          title={f(t.subscribe.title, { venue })}
          onClose={() => setPaying(false)}
          onPaid={() => {
            setPaying(false);
            router.replace({ pathname: '/subscriptions', params: { notice: 'subscribed', venue } });
          }}
          subscription={{
            start: (body, idempotencyKey) =>
              session.api.subscribe(
                { plan_id: plan.planId, billing_cycle: cycle, vehicle_ids: chosen, ...body },
                idempotencyKey,
              ),
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { gap: space[2] },
  plan: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[3],
    boxShadow: shadow.sm,
  },
  planOn: {
    borderColor: color.primary,
    borderWidth: 2,
    backgroundColor: color.primarySubtle,
    boxShadow: shadow.md,
  },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  planFoot: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] },
  planPrice: { fontFamily: font.bold, ...fontSize.xl, color: color.text },
  radio: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
  },
  radioOn: { backgroundColor: color.primary, borderColor: color.primary },
  saving: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.full,
    backgroundColor: color.successSubtle,
  },
  savingText: { color: color.successText },
  total: {
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space[3],
    marginTop: space[1],
  },
  totalText: { fontFamily: font.bold, ...fontSize.lg, color: color.text },
});
