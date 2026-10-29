import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { isApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import { getVenueSettings, putVenueSettings } from '@/api/setup';
import type { VenueSettings, VenueSettingsResult } from '@/api/types';
import { Banner, Button, Checkbox, FieldError, Select, TextField, Toggle } from '@/components';
import { NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { QueryView } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { buttons, components, mediaKind, paymentMethod, ui } from '@/i18n/ar';
import { s08, s09 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { onlyDigits } from '@/lib/digits';
import { halalasFromSar, sarFromHalalas } from '@/lib/riyadh';
import { withDefaults, type FullVenueSettings } from '@/lib/venueDefaults';
import { useUiStore } from '@/stores/ui';

export type SettingsGroup = 'timers' | 'handover' | 'inspection';
type SettingKey = keyof typeof s09.settings;

type Field =
  | { kind: 'int'; key: SettingKey; unit?: keyof typeof s09.units; min: number; max?: number }
  | { kind: 'bool'; key: SettingKey }
  | { kind: 'enum'; key: SettingKey; options: ReadonlyArray<readonly [string, string]> }
  | { kind: 'money'; key: SettingKey }
  | { kind: 'multi'; key: SettingKey; options: ReadonlyArray<readonly [string, string]> };

/** The keys of each S-09 tab (02 S-09) with the ranges of `VenueSettings` in 07_openapi.yaml. */
export const SETTINGS_FIELDS: Record<SettingsGroup, Field[]> = {
  timers: [
    { kind: 'int', key: 'dispatch.single_offer_reminder_s', unit: 's', min: 5, max: 115 },
    { kind: 'int', key: 'dispatch.single_offer_ttl_s', unit: 's', min: 10, max: 120 },
    { kind: 'int', key: 'dispatch.broadcast_reminder_s', unit: 's', min: 10, max: 300 },
    { kind: 'int', key: 'dispatch.unaccepted_escalation_s', unit: 's', min: 20, max: 900 },
    { kind: 'int', key: 'dispatch.next_task_wait_alert_s', unit: 's', min: 60, max: 3600 },
    { kind: 'bool', key: 'dispatch.idle_driver_alert' },
    { kind: 'int', key: 'dispatch.accept_grace_ms', unit: 'ms', min: 0, max: 5000 },
    { kind: 'bool', key: 'dispatch.offline_drivers_last' },
  ],
  handover: [
    { kind: 'int', key: 'handover.code_ttl_min', unit: 'min', min: 5 },
    { kind: 'int', key: 'handover.max_attempts', min: 3, max: 10 },
    { kind: 'int', key: 'handover.max_resends', min: 0, max: 10 },
    { kind: 'int', key: 'ready.uncollected_alert_min', unit: 'min', min: 2, max: 60 },
    {
      kind: 'enum',
      key: 'pricing.default_mode',
      options: [
        ['included', s08.included],
        ['per_vehicle', s08.perVehicle],
      ],
    },
    { kind: 'money', key: 'pricing.default_fee_halalas' },
    {
      kind: 'multi',
      key: 'pricing.allowed_methods',
      options: [
        ['cash', paymentMethod.cash],
        ['pos', paymentMethod.pos],
      ],
    },
  ],
  inspection: [
    {
      kind: 'multi',
      key: 'inspection.required_photos',
      options: (
        ['photo_front', 'photo_rear', 'photo_right', 'photo_left', 'photo_extra', 'photo_damage'] as const
      ).map((k) => [k, mediaKind[k]] as const),
    },
    { kind: 'int', key: 'inspection.max_extra_photos', min: 0, max: 20 },
    { kind: 'int', key: 'link.qr_ttl_min', unit: 'min', min: 2, max: 60 },
    {
      kind: 'enum',
      key: 'parking.mode',
      options: (['assigned_spots', 'free_text', 'mixed'] as const).map(
        (m) => [m, s09.parkingModes[m]] as const,
      ),
    },
    { kind: 'bool', key: 'keys.require_slot' },
  ],
};

const read = (s: FullVenueSettings, key: string): unknown => {
  const [group, name] = key.split('.') as [string, string];
  return (s as unknown as Record<string, Record<string, unknown>>)[group]?.[name];
};

const write = (s: FullVenueSettings, key: string, value: unknown): FullVenueSettings => {
  const [group, name] = key.split('.') as [string, string];
  const next = structuredClone(s) as unknown as Record<string, Record<string, unknown>>;
  const into = next[group];
  if (into) into[name] = value;
  return next as unknown as FullVenueSettings;
};

/** Text inputs for the numeric fields (so a half-typed number is not lost). */
function textsFrom(settings: FullVenueSettings, fields: Field[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.kind === 'int') out[f.key] = String(read(settings, f.key) ?? '');
    if (f.kind === 'money') out[f.key] = sarFromHalalas(Number(read(settings, f.key) ?? 0));
  }
  return out;
}

/**
 * «المؤقتات» / «التسليم والتحصيل» / «الفحص والصف» (02 S-09): one form per tab over the effective settings;
 * «حفظ» sends the whole object with `expected_version` (PUT replaces it, 07 §2.5). Supervisors see the
 * values read-only. Local checks (02 S-09): every value in its range, the single-offer TTL above its reminder.
 */
export function SettingsSection({
  venueId,
  group,
  manage,
}: {
  venueId: string;
  group: SettingsGroup;
  manage: boolean;
}) {
  const settings = useQuery({
    queryKey: queryKeys.venueSettings(venueId),
    queryFn: ({ signal }) => getVenueSettings(venueId, signal),
  });
  return (
    <QueryView query={settings}>
      {(result) => <SettingsForm venueId={venueId} group={group} manage={manage} result={result} />}
    </QueryView>
  );
}

function SettingsForm({
  venueId,
  group,
  manage,
  result,
}: {
  venueId: string;
  group: SettingsGroup;
  manage: boolean;
  result: VenueSettingsResult;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const fields = SETTINGS_FIELDS[group];
  const [draft, setDraft] = useState(() => withDefaults(result.settings));
  const [texts, setTexts] = useState(() => textsFrom(withDefaults(result.settings), fields));
  const [version, setVersion] = useState(result.version);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  // a newer version from the server (after VERSION_CONFLICT) becomes the base; typed values stay
  useEffect(() => setVersion(result.version), [result.version]);

  const save = useCommand((body: { expected_version: number; settings: VenueSettings }, key: string) =>
    putVenueSettings(venueId, body, key),
  );

  const submit = async () => {
    const local: Record<string, string> = {};
    let next = draft;
    for (const f of fields) {
      if (f.kind === 'int') {
        const text = onlyDigits(texts[f.key] ?? '');
        const n = text === '' ? NaN : Number(text);
        if (!Number.isInteger(n) || n < f.min || (f.max !== undefined && n > f.max)) {
          local[f.key] = fmt(s09.outOfRange, { min: f.min, max: f.max ?? '∞' });
        } else next = write(next, f.key, n);
      }
      if (f.kind === 'money') {
        const n = halalasFromSar(texts[f.key] ?? '');
        if (n === null) local[f.key] = ui.validation;
        else next = write(next, f.key, n);
      }
    }
    if (
      group === 'timers' &&
      !local['dispatch.single_offer_reminder_s'] &&
      !local['dispatch.single_offer_ttl_s']
    ) {
      if (next.dispatch.single_offer_reminder_s > next.dispatch.single_offer_ttl_s - 5)
        local['dispatch.single_offer_reminder_s'] = s09.ttlAboveReminder;
    }
    if (group === 'handover') {
      if (next.pricing.allowed_methods.length === 0) local['pricing.allowed_methods'] = ui.validation;
      const fee = next.pricing.default_fee_halalas;
      if (next.pricing.default_mode === 'per_vehicle' ? fee <= 0 : fee !== 0)
        local['pricing.default_fee_halalas'] = ui.validation;
    }
    if (Object.keys(local).length) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      const saved = await save.run({ expected_version: version, settings: next });
      qc.setQueryData(queryKeys.venueSettings(venueId), saved);
      const full = withDefaults(saved.settings);
      setDraft(full);
      setTexts(textsFrom(full, fields));
      setVersion(saved.version);
      pushToast({ message: ui.saved, tone: 'success' });
    } catch (error) {
      const mapped = toFormErrors(error);
      // server field paths are dotted keys like the canon names (`dispatch.single_offer_ttl_s`)
      setErrors({
        ...mapped,
        fields: Object.fromEntries(
          Object.entries(mapped.fields).map(([k, v]) => [k.replace(/^settings\./, ''), v]),
        ),
      });
      if (isApiError(error, 'VERSION_CONFLICT'))
        void qc.invalidateQueries({ queryKey: queryKeys.venueSettings(venueId) });
    }
  };

  const id = (key: string) => `set-${key.replace(/[._]/g, '-')}`;
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (manage && !save.pending) void submit();
      }}
    >
      {group === 'timers' ? <Banner kind="info" rounded message={s09.timersHint} /> : null}
      {fields.map((f) => {
        const label = s09.settings[f.key];
        const error = errors.fields[f.key];
        switch (f.kind) {
          case 'int':
            return (
              <TextField
                key={f.key}
                id={id(f.key)}
                label={label}
                hint={f.unit ? s09.units[f.unit] : undefined}
                inputMode="numeric"
                dir="ltr"
                value={texts[f.key] ?? ''}
                disabled={!manage}
                error={error}
                onChange={(e) => setTexts((t) => ({ ...t, [f.key]: onlyDigits(e.target.value) }))}
              />
            );
          case 'money':
            return (
              <TextField
                key={f.key}
                id={id(f.key)}
                label={label}
                hint={components.money.currency}
                inputMode="decimal"
                dir="ltr"
                value={texts[f.key] ?? ''}
                disabled={!manage}
                error={error}
                onChange={(e) => setTexts((t) => ({ ...t, [f.key]: e.target.value }))}
              />
            );
          case 'bool':
            return (
              <Toggle
                key={f.key}
                id={id(f.key)}
                label={label}
                checked={Boolean(read(draft, f.key))}
                disabled={!manage}
                onChange={(on) => setDraft((d) => write(d, f.key, on))}
              />
            );
          case 'enum':
            return (
              <Select
                key={f.key}
                id={id(f.key)}
                label={label}
                options={f.options}
                value={String(read(draft, f.key) ?? '')}
                disabled={!manage}
                error={error}
                onChange={(e) => setDraft((d) => write(d, f.key, e.target.value))}
              />
            );
          case 'multi': {
            const values = (read(draft, f.key) as string[] | undefined) ?? [];
            return (
              <fieldset key={f.key} className="pt-radio" disabled={!manage}>
                <legend className="pt-field__label">{label}</legend>
                {f.options.map(([value, text]) => (
                  <Checkbox
                    key={value}
                    id={`${id(f.key)}-${value}`}
                    label={text}
                    checked={values.includes(value)}
                    onChange={(e) =>
                      setDraft((d) =>
                        write(
                          d,
                          f.key,
                          e.target.checked
                            ? f.options.map(([v]) => v).filter((v) => v === value || values.includes(v))
                            : values.filter((v) => v !== value),
                        ),
                      )
                    }
                  />
                ))}
                {error ? <FieldError>{error}</FieldError> : null}
              </fieldset>
            );
          }
          default:
            return null;
        }
      })}
      {errors.form ? (
        <Banner
          kind="error"
          rounded
          message={errors.form}
          detail={errors.requestId ? fmt(ui.requestId, { id: errors.requestId }) : undefined}
        />
      ) : null}
      {manage ? (
        <Button type="submit" fullWidth loading={save.pending} id={`save-${group}`}>
          {buttons.save}
        </Button>
      ) : null}
    </form>
  );
}
