/**
 * C-05 إضافة سيارة (owner's option 3, DEC-638): two short steps, skippable («يمكن تخطيه»).
 *
 * 1. «ما لوحة سيارتك؟»: the Saudi plate as on the car (`SaudiPlate`) filling from two fields under it, the digits
 *    and the letters. The letters are typed with the phone's own keyboard, Arabic or Latin («ا ب ح» or «ABJ»); there
 *    is no on-screen letter pad any more. «التالي» checks the plate with the shared rule before going on.
 * 2. «نوعها ولونها»: the type as tiles, the colour as swatches and the make from a list (02 §8.4, «أخرى» as free
 *    text, DEC-350), the model optional. «حفظ السيارة» sends it all; a refusal of the plate brings step 1 back with
 *    its error.
 *
 * C-15 «أضف سيارة» reuses it with `?from=vehicles` (V2-012): saving or cancelling returns to the list.
 */
import { CUSTOMER_VEHICLE_TYPES, saudiPlateDisplay } from '@point/shared/customer';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import {
  emptyVehicleForm,
  sanitizePlateDigits,
  validateVehicle,
  vehicleBody,
  vehicleIssueFromError,
  withLettersText,
  type VehicleErrors,
  type VehicleForm,
} from '../features/vehicle';
import { vehicleCaption } from '../features/vehicles';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Controls';
import { Field } from '../ui/Field';
import { CarCard } from '../ui/CarCard';
import { SaudiPlate } from '../ui/SaudiPlate';
import { Screen } from '../ui/Screen';
import { StepDots } from '../ui/StepHeader';
import { ColorSwatches, MakePicker, TypeTiles } from '../ui/VehiclePickers';

export default function Vehicle() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  // C-15 «أضف سيارة» opens this same form (V2-012): it goes back to the list instead of continuing R1
  const fromList = useLocalSearchParams<{ from?: string }>().from === 'vehicles';
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<VehicleForm>(emptyVehicleForm);
  const [serverErrors, setServerErrors] = useState<VehicleErrors>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;

  const errors = checked ? { ...validateVehicle(form), ...serverErrors } : serverErrors;
  const update = (next: VehicleForm) => {
    setForm(next);
    setServerErrors({});
  };

  const finish = async () => {
    if (fromList) return router.back();
    await session.markVehiclePromptDone();
    const me = await session.api.me().catch(() => session.me);
    router.replace(me ? await session.setMe(me) : '/home');
  };

  const next = () => {
    setChecked(true);
    const local = validateVehicle(form);
    if (local.digits || local.letters) return;
    setFailure(null);
    setStep(2);
  };

  const submit = async () => {
    const local = validateVehicle(form);
    if (local.digits || local.letters) {
      setChecked(true);
      setStep(1);
      return;
    }
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const body = vehicleBody(form);
    try {
      await session.api.addVehicle(body, key.for(JSON.stringify(body)));
      key.reset();
      await finish();
    } catch (e) {
      const issue = vehicleIssueFromError(e);
      if (issue?.kind === 'field') {
        setServerErrors(issue.errors);
        setStep(1);
      } else if (issue?.kind === 'duplicate') {
        setFailure(t.vehicle.duplicate);
        setStep(1);
      } else if (issue?.kind === 'limit') setFailure(f(t.vehicle.limit, { max: issue.max }));
      else setFailure(errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  const leave = (
    <Button
      label={fromList ? t.vehicles.cancel : t.vehicle.skip}
      variant="ghost"
      size="md"
      onPress={finish}
      disabled={busy}
    />
  );

  // the plate as the app writes it elsewhere («1234 ا ب ح»), for screen readers
  const plateLabel = saudiPlateDisplay({ digits: form.digits, letters_ar: form.letters.join(' ') });

  return (
    <Screen
      footerKey={String(step)}
      footer={
        step === 1 ? (
          <>
            <Button label={t.vehicle.next} icon="go" onPress={next} testID="vehicle-next" />
            {leave}
          </>
        ) : (
          <>
            <Button
              label={t.vehicle.submit}
              loading={busy}
              loadingLabel={t.common.saving}
              onPress={submit}
              testID="vehicle-submit"
            />
            <Button
              label={t.vehicle.editPlate}
              variant="ghost"
              size="md"
              onPress={() => setStep(1)}
              disabled={busy}
            />
          </>
        )
      }
    >
      <View style={styles.head}>
        {fromList ? null : <StepDots step={4} />}
        <View style={styles.bars} accessible={false} importantForAccessibility="no-hide-descendants">
          <View style={[styles.bar, styles.barOn]} />
          <View style={[styles.bar, step === 2 && styles.barOn]} />
        </View>
        <AppText variant="title" accessibilityRole="header">
          {step === 1 ? t.vehicle.title : t.vehicle.looksTitle}
        </AppText>
        <AppText tone="muted">
          {f(t.vehicle.step, { n: step })} · {step === 1 ? t.vehicle.hint : t.vehicle.looksHint}
        </AppText>
      </View>

      {step === 1 ? (
        <>
          <SaudiPlate
            digits={form.digits}
            letters={form.letters}
            country={t.vehicle.plateCountry}
            label={plateLabel ? `${t.vehicle.plate}: ${plateLabel}` : t.vehicle.plate}
          />
          {/* the plate's order: digits on the left, letters on the right */}
          <View style={styles.fields}>
            <View style={styles.flex}>
              <Field
                label={t.vehicle.digits}
                testID="plate-digits"
                value={form.digits}
                onChangeText={(v) => update({ ...form, digits: sanitizePlateDigits(v) })}
                keyboardType="number-pad"
                placeholder={t.vehicle.digitsPlaceholder}
                maxLength={8}
                error={errors.digits ? t.vehicle.digitsInvalid : null}
                ltr
              />
            </View>
            <View style={styles.flex}>
              <Field
                label={t.vehicle.letters}
                testID="plate-letters"
                value={form.lettersText}
                onChangeText={(v) => update(withLettersText(form, v))}
                placeholder={t.vehicle.lettersPlaceholder}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                maxLength={12}
                error={errors.letters ? t.vehicle.lettersInvalid : null}
                ltr
              />
            </View>
          </View>
          <AppText variant="small" tone="muted">
            {t.vehicle.lettersHint}
          </AppText>
        </>
      ) : (
        <>
          {/* DEC-642/643: the car as chosen so far, with its plate, as its «بطاقة السيارة» */}
          <CarCard
            type={form.type}
            paint={form.color}
            plate={plateLabel}
            caption={vehicleCaption(vehicleBody(form), t)}
            width={190}
            testID="vehicle-preview"
          />
          <TypeTiles
            label={t.vehicle.type}
            types={CUSTOMER_VEHICLE_TYPES}
            names={t.vehicle.types}
            value={form.type}
            onChange={(type) => update({ ...form, type })}
          />
          <ColorSwatches
            label={t.vehicle.color}
            names={t.vehicleColors}
            more={t.vehicle.moreColors}
            value={form.color}
            onChange={(c) => update({ ...form, color: c })}
          />
          {form.color === 'other' ? (
            <Field
              label={`${t.vehicle.color} — ${t.vehicle.other}`}
              value={form.colorOther}
              onChangeText={(colorOther) => update({ ...form, colorOther })}
              placeholder={t.vehicle.otherPlaceholder}
              maxLength={40}
            />
          ) : null}
          <MakePicker
            label={`${t.vehicle.make} (${t.common.optional})`}
            placeholder={t.vehicle.makePick}
            names={t.vehicleMakes}
            value={form.make}
            onChange={(make) => update({ ...form, make })}
          />
          {form.make === 'other' ? (
            <Field
              label={`${t.vehicle.make} — ${t.vehicle.other}`}
              value={form.makeOther}
              onChangeText={(makeOther) => update({ ...form, makeOther })}
              placeholder={t.vehicle.otherPlaceholder}
              maxLength={40}
            />
          ) : null}
          {form.make ? (
            <Field
              label={`${t.vehicle.model} (${t.common.optional})`}
              value={form.model}
              onChangeText={(model) => update({ ...form, model })}
              placeholder={t.vehicle.modelPlaceholder}
              maxLength={40}
            />
          ) : null}
        </>
      )}
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space[2], paddingTop: space[2], paddingBottom: space[1] },
  bars: { flexDirection: 'row', gap: space[1] + space[0.5], marginTop: space[1] },
  bar: { flex: 1, height: 4, borderRadius: radius.full, backgroundColor: color.border },
  barOn: { backgroundColor: color.primary },
  fields: { flexDirection: 'row', direction: 'ltr', gap: space[3] },
  flex: { flex: 1 },
});
