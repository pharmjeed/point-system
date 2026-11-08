/**
 * C-05 إضافة سيارة: Saudi plate (digits + three plate letters, normalised as in `tickets`), make, model, colour
 * and type — skippable («يمكن تخطيه»). Make and colour are the 02 §8.4 pick lists with «أخرى» as free text.
 * C-15 «أضف سيارة» reuses it with `?from=vehicles` (V2-012): saving or cancelling returns to the list.
 */
import { CUSTOMER_VEHICLE_TYPES, type CustomerVehicleType } from '@point/shared/customer';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import {
  addLetter,
  emptyVehicleForm,
  removeLastLetter,
  sanitizePlateDigits,
  validateVehicle,
  vehicleBody,
  vehicleIssueFromError,
  type VehicleErrors,
  type VehicleForm,
} from '../features/vehicle';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, ChoiceChips } from '../ui/Controls';
import { Field } from '../ui/Field';
import { PlateInput } from '../ui/PlateInput';
import { Screen } from '../ui/Screen';

export default function Vehicle() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  // C-15 «أضف سيارة» opens this same form (V2-012): it goes back to the list instead of continuing R1
  const fromList = useLocalSearchParams<{ from?: string }>().from === 'vehicles';
  const [form, setForm] = useState<VehicleForm>(emptyVehicleForm);
  const [serverErrors, setServerErrors] = useState<VehicleErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;

  const errors = submitted ? { ...validateVehicle(form), ...serverErrors } : serverErrors;
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

  const submit = async () => {
    setSubmitted(true);
    const local = validateVehicle(form);
    if (local.digits || local.letters || busy) return;
    setBusy(true);
    setFailure(null);
    const body = vehicleBody(form);
    try {
      await session.api.addVehicle(body, key.for(JSON.stringify(body)));
      key.reset();
      await finish();
    } catch (e) {
      const issue = vehicleIssueFromError(e);
      if (issue?.kind === 'field') setServerErrors(issue.errors);
      else if (issue?.kind === 'duplicate') setFailure(t.vehicle.duplicate);
      else if (issue?.kind === 'limit') setFailure(f(t.vehicle.limit, { max: issue.max }));
      else setFailure(errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  const options = (map: Readonly<Record<string, string>>) =>
    Object.entries(map).map(([value, label]) => ({ value, label }));

  return (
    <Screen
      footer={
        <>
          <Button
            label={t.vehicle.submit}
            loading={busy}
            loadingLabel={t.common.saving}
            onPress={submit}
            testID="vehicle-submit"
          />
          <Button
            label={fromList ? t.vehicles.cancel : t.vehicle.skip}
            variant="ghost"
            size="md"
            onPress={finish}
            disabled={busy}
          />
        </>
      }
    >
      <AppText variant="title" accessibilityRole="header">
        {t.vehicle.title}
      </AppText>
      <AppText tone="muted">{t.vehicle.hint}</AppText>
      <PlateInput
        digits={form.digits}
        letters={form.letters}
        onDigits={(v) => update({ ...form, digits: sanitizePlateDigits(v) })}
        onLetter={(l) => update(addLetter(form, l))}
        onBackspace={() => update(removeLastLetter(form))}
        text={{
          plate: t.vehicle.plate,
          digits: t.vehicle.digits,
          digitsPlaceholder: t.vehicle.digitsPlaceholder,
          letters: t.vehicle.letters,
          lettersHint: t.vehicle.lettersHint,
          clearLetters: t.vehicle.clearLetters,
          digitsError: errors.digits ? t.vehicle.digitsInvalid : null,
          lettersError: errors.letters ? t.vehicle.lettersInvalid : null,
        }}
      />
      <ChoiceChips
        label={t.vehicle.make}
        options={options(t.vehicleMakes)}
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
      <Field
        label={`${t.vehicle.model} (${t.common.optional})`}
        value={form.model}
        onChangeText={(model) => update({ ...form, model })}
        placeholder={t.vehicle.modelPlaceholder}
        maxLength={40}
      />
      <ChoiceChips
        label={t.vehicle.color}
        options={options(t.vehicleColors)}
        value={form.color}
        onChange={(color) => update({ ...form, color })}
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
      <ChoiceChips<CustomerVehicleType>
        label={t.vehicle.type}
        options={CUSTOMER_VEHICLE_TYPES.map((value) => ({ value, label: t.vehicle.types[value] }))}
        value={form.type}
        onChange={(type) => update({ ...form, type })}
      />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
    </Screen>
  );
}
