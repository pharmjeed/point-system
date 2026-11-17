/**
 * C-09 اختيار الباقة (V2-032; docs/v2/01 R2; DEC-532, DEC-534): the plans of the location (monthly / yearly with the
 * yearly saving), the covered car(s) — 1 … the plan's cars, chosen from «سياراتي» — the terms, then «متابعة إلى الدفع»
 * opens C-10 (the pay sheet of C-12 in its subscription mode). Paid → C-14. Every price, date and refusal comes from
 * the server.
 *
 * V2-UX (DEC-579): the cycle as a segmented control with the yearly saving on its segment, the plans as selectable
 * cards (name, the price large, the cars, the saving badge; a tick when chosen), the covered cars, and a summary card
 * with the total; «متابعة إلى الدفع» in the sticky bottom sheet. Skeletons while loading.
 *
 * V2-036 (the subscriptions annex, docs/v2/04 §7; DEC-590 … DEC-605): before payment the selected plan shows who it is
 * for, its counted days and the dates if paid now, the price before VAT, the VAT and the total, its policies (one
 * visit a day, the freeze, no automatic renewal, non-refundable, closures), the announced holidays and closures, the
 * valuables notice, and the consent it needs (terms and privacy, the non-refund condition) — recorded with the
 * payment. A plan checked for eligibility asks for the student number and the name first (`…/apply`); once approved,
 * C-14 brings the customer back here (`?pay=`) to pay it. «اكتملت المقاعد» marks a plan whose capacity is reached;
 * `?plan=` preselects a plan (the renewal from C-14).
 */
import type {
  CustomerLocationDetail,
  CustomerPurchaseConsent,
  CustomerVehicle,
} from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { isApiError } from '../../api/errors';
import { closureLines, applicationIssue, planAnnex } from '../../features/annex';
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
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, shadow, space } from '../../theme/tokens';
import { FadeIn } from '../../ui/Animated';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, Checkbox, IconBadge, SegmentedControl } from '../../ui/Controls';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Touchable } from '../../ui/Touchable';
import { DevBanner } from '../../ui/DevBanner';
import { Screen } from '../../ui/Screen';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { SkeletonList } from '../../ui/Skeleton';

export default function Subscribe() {
  const params = useLocalSearchParams<{ venueId: string; plan?: string; pay?: string }>();
  const venueId = params.venueId;
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [loc, setLoc] = useState<CustomerLocationDetail | null>(null);
  const [vehicles, setVehicles] = useState<CustomerVehicle[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [planId, setPlanId] = useState<string | null>(params.plan ?? null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  // V2-036: the application, the consent, an approved subscription to pay
  const [studentNumber, setStudentNumber] = useState('');
  const [studentName, setStudentName] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptNonRefund, setAcceptNonRefund] = useState(false);
  const [payId, setPayId] = useState<string | null>(params.pay ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [detail, cars, subs] = await Promise.all([
            session.api.location(venueId),
            session.api.vehicles(),
            params.pay ? session.api.subscriptions() : Promise.resolve([]),
          ]);
          if (cancelled) return;
          setLoc(detail);
          setVehicles(cars);
          setFailure(detail.plans.length === 0 ? t.subscribe.unavailable : null);
          const cycles = cyclesOf(detail.plans);
          setCycle((c) => (cycles.includes(c) ? c : (cycles[0] ?? 'monthly')));
          // one car on the account: it is the obvious choice
          setChosen((c) => (c.length === 0 && cars.length === 1 ? [cars[0]!.id] : c));
          // C-14 «ادفع» of an approved application: its plan and cars
          const waiting = subs.find((s) => s.subscription_id === params.pay);
          if (waiting) {
            setPlanId(waiting.plan_id);
            setChosen(waiting.vehicles.filter((v) => !v.removed).map((v) => v.vehicle_id));
          }
        } catch (e) {
          if (cancelled) return;
          setFailure(isApiError(e, 'VENUE_NOT_LISTED') ? t.locations.notListed : errorText(e, t, locale));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [session.api, venueId, params.pay, t, locale]),
  );

  const plans = useMemo(() => planOptions(loc?.plans ?? [], cycle, t), [loc, cycle, t]);
  const cycles = cyclesOf(loc?.plans ?? []);
  const plan = plans.find((p) => p.planId === planId) ?? null;
  const planRow = loc?.plans.find((p) => p.plan_id === planId) ?? null;
  const annex = planRow ? planAnnex(planRow, t) : null;
  const max = planRow?.vehicles_included ?? 1;
  const cars = coverableVehicles(vehicles ?? []);
  const venue = loc ? (locale === 'en' && loc.name_en ? loc.name_en : loc.name_ar) : '';
  const saving = loc ? bestYearlySaving(loc.plans) : null;
  const closures = loc ? closureLines(loc.closures, t) : [];
  const applying = !!annex?.needsEligibility && !payId;

  const choosePlan = (id: string | null) => {
    if (payId) return; // paying an approved application: its plan is fixed
    setPlanId(id);
    const included = loc?.plans.find((p) => p.plan_id === id)?.vehicles_included ?? 1;
    setChosen((c) => (c.length > included ? c.slice(c.length - included) : c));
    setIssue(null);
  };

  const consent = (): CustomerPurchaseConsent | undefined =>
    planRow
      ? {
          terms_version: planRow.terms_version,
          privacy_version: planRow.privacy_version,
          non_refundable: planRow.policy.refund_policy === 'non_refundable' && acceptNonRefund,
          valuables_notice: true,
        }
      : undefined;

  const consentIssue = () =>
    annex?.needsConsent && (!acceptTerms || (annex.nonRefundable && !acceptNonRefund))
      ? t.annex.consentNeeded
      : null;

  const proceed = () => {
    const problem = subscribeIssue(plan ? plan.planId : null, chosen, t) ?? consentIssue();
    setIssue(problem);
    if (!problem) setPaying(true);
  };

  const apply = async () => {
    const problem =
      subscribeIssue(plan ? plan.planId : null, chosen, t) ??
      applicationIssue(studentNumber, studentName, t) ??
      consentIssue();
    setIssue(problem);
    if (problem || !plan) return;
    setBusy(true);
    try {
      const s = await session.api.applySubscription(
        {
          plan_id: plan.planId,
          vehicle_ids: chosen,
          student_number: studentNumber.trim(),
          student_name: studentName.trim(),
        },
        newIdempotencyKey(),
      );
      if (s.status === 'pending_payment') {
        // approved at once (the venue's list, or a renewal): pay now
        setPayId(s.subscription_id);
        setNotice(t.annex.done.approved);
        setPaying(true);
      } else router.replace({ pathname: '/subscriptions', params: { notice: 'applied', venue } });
    } catch (e) {
      const fields = isApiError(e, 'VALIDATION_FAILED')
        ? ((e.details as { fields?: { field?: string; issue?: string }[] }).fields ?? [])
        : [];
      setIssue(fields.some((x) => x.issue === 'in_use') ? t.annex.numberInUse : errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  const ready = loc && plans.length > 0 && cars.length > 0;
  return (
    <Screen
      footer={
        ready ? (
          applying ? (
            <Button
              label={t.annex.apply}
              icon="graduation-cap"
              loading={busy}
              onPress={() => void apply()}
              testID="subscribe-apply"
            />
          ) : (
            <Button
              label={payId ? t.annex.payTitle : t.subscribe.pay}
              icon="credit-card"
              disabled={!!annex?.soldOut && !payId}
              onPress={proceed}
              testID="subscribe-pay"
            />
          )
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
      {notice ? <Banner tone="success">{notice}</Banner> : null}
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
              const row = loc.plans.find((x) => x.plan_id === p.planId)!;
              const info = planAnnex(row, t);
              return (
                <FadeIn key={p.planId} index={i} swapKey={cycle}>
                  <Touchable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: info.soldOut }}
                    accessibilityLabel={`${p.title} · ${p.priceText}${info.soldOut ? ` · ${t.annex.soldOut}` : ''}`}
                    onPress={() => (info.soldOut ? undefined : choosePlan(on ? null : p.planId))}
                    feedback="select"
                    style={({ pressed }) => [
                      styles.plan,
                      on && styles.planOn,
                      info.soldOut && styles.planOff,
                      pressed && !on && { backgroundColor: color.surface2 },
                    ]}
                  >
                    <View style={styles.planHead}>
                      <IconBadge name={info.term ? 'graduation-cap' : 'calendar-check'} size={40} />
                      <View style={styles.flex}>
                        <AppText variant="bodyStrong">{p.title}</AppText>
                        <AppText variant="small" tone="muted">
                          {info.term ?? p.vehicles}
                        </AppText>
                        {info.audience ? (
                          <AppText variant="small" tone="muted">
                            {info.audience}
                          </AppText>
                        ) : null}
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
                      {info.soldOut ? (
                        <View style={styles.soldOut}>
                          <AppText variant="caption" style={styles.soldOutText}>
                            {t.annex.soldOut}
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
          {annex && annex.bullets.length > 0 ? (
            <Card>
              <AppText variant="cardTitle">{t.annex.details}</AppText>
              {annex.countedNote ? (
                <AppText variant="small" tone="muted">
                  {annex.countedNote}
                </AppText>
              ) : null}
              {annex.preview ? (
                <View style={styles.planHead}>
                  <Icon name="calendar-days" size={18} tint={color.primary} />
                  <AppText variant="bodyStrong" style={styles.flex}>
                    {annex.preview}
                  </AppText>
                </View>
              ) : null}
              {annex.bullets.map((b) => (
                <View key={b} style={styles.bullet}>
                  <AppText tone="muted">•</AppText>
                  <AppText variant="small" style={styles.flex}>
                    {b}
                  </AppText>
                </View>
              ))}
            </Card>
          ) : null}
          {closures.length > 0 ? (
            <Card>
              <View style={styles.planHead}>
                <Icon name="calendar-days" size={18} tint={color.textMuted} />
                <AppText variant="bodyStrong" style={styles.flex}>
                  {t.annex.closuresTitle}
                </AppText>
              </View>
              {closures.map((c) => (
                <AppText key={c} variant="small">
                  {c}
                </AppText>
              ))}
              <AppText variant="small" tone="muted">
                {t.annex.closureNote}
              </AppText>
            </Card>
          ) : null}
          {applying ? (
            <Card>
              <View style={styles.planHead}>
                <Icon name="graduation-cap" size={18} tint={color.primary} />
                <AppText variant="bodyStrong" style={styles.flex}>
                  {t.annex.eligibilityTitle}
                </AppText>
              </View>
              <AppText variant="small" tone="muted">
                {t.annex.eligibilityHint}
              </AppText>
              <Field
                label={t.annex.studentNumber}
                value={studentNumber}
                onChangeText={(v) => setStudentNumber(v.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32))}
                autoCapitalize="characters"
                ltr
                testID="student-number"
              />
              <Field
                label={t.annex.studentName}
                value={studentName}
                onChangeText={(v) => setStudentName(v.slice(0, 80))}
                testID="student-name"
              />
            </Card>
          ) : null}
          <Card>
            {!annex || !annex.manualRenewal ? (
              <View style={styles.planHead}>
                <Icon name="info" size={18} tint={color.textMuted} />
                <AppText variant="small" tone="muted" style={styles.flex}>
                  {t.subscribe.terms}
                </AppText>
              </View>
            ) : null}
            {plan ? (
              <FadeIn swapKey={plan.planId}>
                {annex?.breakdown ? (
                  <View style={styles.breakdown} accessibilityRole="summary">
                    <View style={styles.line}>
                      <AppText tone="muted">{t.annex.net}</AppText>
                      <AppText>{annex.breakdown.net}</AppText>
                    </View>
                    <View style={styles.line}>
                      <AppText tone="muted">{annex.breakdown.vatLabel}</AppText>
                      <AppText>{annex.breakdown.vat}</AppText>
                    </View>
                  </View>
                ) : null}
                <View style={styles.total}>
                  <AppText style={styles.totalText}>
                    {t.subscribe.total}: {plan.priceText}
                  </AppText>
                </View>
              </FadeIn>
            ) : null}
          </Card>
          {plan ? <Banner tone="info">{t.annex.valuables}</Banner> : null}
          {annex?.needsConsent ? (
            <View style={styles.group}>
              <Checkbox
                label={t.annex.consentTerms}
                checked={acceptTerms}
                onChange={(v) => {
                  setAcceptTerms(v);
                  setIssue(null);
                }}
              />
              {annex.nonRefundable ? (
                <Checkbox
                  label={t.annex.consentNonRefund}
                  checked={acceptNonRefund}
                  onChange={(v) => {
                    setAcceptNonRefund(v);
                    setIssue(null);
                  }}
                />
              ) : null}
            </View>
          ) : null}
          {issue ? <Banner tone="warning">{issue}</Banner> : null}
        </>
      ) : null}
      {plan && planRow ? (
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
            manualRenewal: planRow.policy.renewal_mode === 'manual',
            start: (body, idempotencyKey) =>
              payId
                ? session.api.paySubscription(payId, { ...body, purchase_consent: consent() }, idempotencyKey)
                : session.api.subscribe(
                    {
                      plan_id: plan.planId,
                      billing_cycle: cycle,
                      vehicle_ids: chosen,
                      ...body,
                      ...(annex?.needsConsent ? { purchase_consent: consent() } : {}),
                    },
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
  planOff: { opacity: 0.6 },
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
  soldOut: {
    paddingHorizontal: space[2],
    paddingVertical: space[0.5],
    borderRadius: radius.full,
    backgroundColor: color.dangerSubtle,
  },
  soldOutText: { color: color.dangerText },
  bullet: { flexDirection: 'row', gap: space[2], alignItems: 'flex-start' },
  breakdown: { gap: space[1], paddingTop: space[2] },
  line: { flexDirection: 'row', justifyContent: 'space-between' },
  total: {
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space[3],
    marginTop: space[1],
  },
  totalText: { fontFamily: font.bold, ...fontSize.lg, color: color.text },
});
