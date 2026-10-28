import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import { createEvent, patchEvent } from '@/api/setup';
import type {
  DispatchPool,
  EventInput,
  PaymentMethod,
  PricingMode,
  VenueEvent,
  VenueSettings,
} from '@/api/types';
import { Checkbox, FieldError, SegmentedControl, Select, TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { useCommand } from '@/hooks/useCommand';
import { components, paymentMethod, s08, ui } from '@/i18n/ar';
import { halalasFromSar, riyadhParts, riyadhRange, sarFromHalalas, todayRiyadh } from '@/lib/riyadh';
import { useUiStore } from '@/stores/ui';
import { PAYMENT_METHODS } from './venueModel';

interface EventForm {
  name_ar: string;
  host_name: string;
  event_date: string;
  start: string;
  end: string;
  pricing_mode: PricingMode;
  amount: string;
  methods: PaymentMethod[];
  pool: string;
}

function initialForm(
  event: VenueEvent | undefined,
  settings: VenueSettings | undefined,
  pool: string,
): EventForm {
  if (event) {
    return {
      name_ar: event.name_ar,
      host_name: event.host_name ?? '',
      event_date: event.event_date,
      start: event.starts_at ? riyadhParts(event.starts_at).time : '',
      end: event.ends_at ? riyadhParts(event.ends_at).time : '',
      pricing_mode: event.pricing_mode,
      amount: event.pricing_mode === 'per_vehicle' ? sarFromHalalas(event.fee_halalas) : '',
      methods: event.allowed_payment_methods?.length ? event.allowed_payment_methods : PAYMENT_METHODS,
      pool: event.dispatch_pool_id,
    };
  }
  // New events start from the venue defaults pricing.* (canon §12)
  const mode = settings?.pricing?.default_mode ?? 'included';
  const fee = settings?.pricing?.default_fee_halalas ?? 0;
  return {
    name_ar: '',
    host_name: '',
    event_date: todayRiyadh(),
    start: '',
    end: '',
    pricing_mode: mode,
    amount: mode === 'per_vehicle' && fee > 0 ? sarFromHalalas(fee) : '',
    methods: settings?.pricing?.allowed_methods?.length ? settings.pricing.allowed_methods : PAYMENT_METHODS,
    pool,
  };
}

/**
 * «حفل جديد» / «تعديل» (S-08, `event.manage`): name, host, date, start and end, pricing «مشمول / رسوم لكل
 * مركبة», amount when charged, payment methods. Pricing rules are checked locally as well as by the server
 * (included ⇒ fee 0, per_vehicle ⇒ fee > 0; 07 §2.5).
 */
export function EventFormSheet({
  open,
  onOpenChange,
  venueId,
  event,
  pools,
  settings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueId: string;
  event?: VenueEvent;
  pools: DispatchPool[];
  settings?: VenueSettings;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const activePools = pools.filter((p) => p.status === 'active');
  const defaultPool = activePools.find((p) => p.is_default)?.id ?? activePools[0]?.id ?? '';
  const [form, setForm] = useState<EventForm>(() => initialForm(event, settings, defaultPool));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  // reset only when the sheet opens (later refetches must not wipe what the user typed)
  useEffect(() => {
    if (!open) return;
    setErrors(NO_ERRORS);
    setForm(initialForm(event, settings, defaultPool));
  }, [open]); // deliberately not on event/settings/defaultPool

  const create = useCommand((body: EventInput, key: string) => createEvent(venueId, body, key));
  const update = useCommand((body: Parameters<typeof patchEvent>[1], key: string) =>
    patchEvent(event?.id ?? '', body, key),
  );
  const pending = create.pending || update.pending;

  const submit = async () => {
    const local: Record<string, string> = {};
    if (!form.name_ar.trim()) local.name_ar = ui.validation;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.event_date)) local.event_date = ui.validation;
    const fee = form.pricing_mode === 'per_vehicle' ? halalasFromSar(form.amount) : 0;
    if (form.pricing_mode === 'per_vehicle' && !(fee && fee > 0)) local.fee_halalas = ui.validation;
    if (form.methods.length === 0) local.allowed_payment_methods = ui.validation;
    if (Object.keys(local).length) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    const { starts_at, ends_at } = riyadhRange(form.event_date, form.start, form.end);
    const body: EventInput = {
      name_ar: form.name_ar.trim(),
      host_name: form.host_name.trim() || null,
      event_date: form.event_date,
      starts_at,
      ends_at,
      pricing_mode: form.pricing_mode,
      fee_halalas: fee ?? 0,
      allowed_payment_methods: PAYMENT_METHODS.filter((m) => form.methods.includes(m)),
      ...(form.pool ? { dispatch_pool_id: form.pool } : {}),
    };
    try {
      if (event) {
        // Only what changed: pricing is locked after the first ticket (07 §2.5)
        const patch: Partial<EventInput> = {};
        if (body.name_ar !== event.name_ar) patch.name_ar = body.name_ar;
        if ((body.host_name ?? null) !== (event.host_name ?? null)) patch.host_name = body.host_name;
        if (body.event_date !== event.event_date) patch.event_date = body.event_date;
        if ((body.starts_at ?? null) !== (event.starts_at ?? null)) patch.starts_at = body.starts_at;
        if ((body.ends_at ?? null) !== (event.ends_at ?? null)) patch.ends_at = body.ends_at;
        if (body.pricing_mode !== event.pricing_mode) patch.pricing_mode = body.pricing_mode;
        if (body.fee_halalas !== event.fee_halalas) patch.fee_halalas = body.fee_halalas;
        if (body.allowed_payment_methods.join() !== (event.allowed_payment_methods ?? []).join())
          patch.allowed_payment_methods = body.allowed_payment_methods;
        if (body.dispatch_pool_id && body.dispatch_pool_id !== event.dispatch_pool_id)
          patch.dispatch_pool_id = body.dispatch_pool_id;
        await update.run({ ...patch, expected_version: event.version });
      } else {
        await create.run(body);
      }
      pushToast({ message: ui.saved, tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.events(venueId) });
    }
  };

  const toggleMethod = (m: PaymentMethod, on: boolean) =>
    setForm((f) => ({
      ...f,
      methods: on ? [...new Set([...f.methods, m])] : f.methods.filter((x) => x !== m),
    }));
  const methodsError = fieldError(errors, 'allowed_payment_methods');

  return (
    <FormSheet
      id="event-form"
      open={open}
      onOpenChange={onOpenChange}
      title={event ? s08.edit : s08.newEvent}
      submitLabel={event ? s08.edit : s08.newEvent}
      onSubmit={submit}
      pending={pending}
      errors={errors}
    >
      <TextField
        id="event-name"
        label={s08.eventName}
        value={form.name_ar}
        maxLength={120}
        error={fieldError(errors, 'name_ar')}
        onChange={(e) => setForm((f) => ({ ...f, name_ar: e.target.value }))}
      />
      <TextField
        id="event-host"
        label={s08.host}
        value={form.host_name}
        maxLength={120}
        error={fieldError(errors, 'host_name')}
        onChange={(e) => setForm((f) => ({ ...f, host_name: e.target.value }))}
      />
      <TextField
        id="event-date"
        type="date"
        label={s08.date}
        value={form.event_date}
        error={fieldError(errors, 'event_date')}
        onChange={(e) => setForm((f) => ({ ...f, event_date: e.target.value }))}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          id="event-start"
          type="time"
          label={s08.start}
          value={form.start}
          error={fieldError(errors, 'starts_at')}
          onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
        />
        <TextField
          id="event-end"
          type="time"
          label={s08.end}
          value={form.end}
          error={fieldError(errors, 'ends_at')}
          onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="pt-field__label">{s08.pricing}</span>
        <SegmentedControl
          label={s08.pricing}
          value={form.pricing_mode}
          onChange={(v) => setForm((f) => ({ ...f, pricing_mode: v }))}
          options={[
            { value: 'included', label: s08.included },
            { value: 'per_vehicle', label: s08.perVehicle },
          ]}
        />
        {fieldError(errors, 'pricing_mode') ? (
          <FieldError>{fieldError(errors, 'pricing_mode')}</FieldError>
        ) : null}
      </div>
      {form.pricing_mode === 'per_vehicle' ? (
        <TextField
          id="event-amount"
          label={s08.amount}
          hint={components.money.currency}
          inputMode="decimal"
          dir="ltr"
          value={form.amount}
          error={fieldError(errors, 'fee_halalas')}
          onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
        />
      ) : null}
      <fieldset className="pt-radio" aria-describedby={methodsError ? 'event-methods-err' : undefined}>
        <legend className="pt-field__label">{s08.methods}</legend>
        {PAYMENT_METHODS.map((m) => (
          <Checkbox
            key={m}
            id={`event-method-${m}`}
            label={paymentMethod[m]}
            checked={form.methods.includes(m)}
            onChange={(e) => toggleMethod(m, e.target.checked)}
          />
        ))}
        {methodsError ? <FieldError id="event-methods-err">{methodsError}</FieldError> : null}
      </fieldset>
      {activePools.length > 1 ? (
        <Select
          id="event-pool"
          label={s08.pool}
          value={form.pool}
          options={activePools.map((p) => [p.id, p.name] as const)}
          error={fieldError(errors, 'dispatch_pool_id')}
          onChange={(e) => setForm((f) => ({ ...f, pool: e.target.value }))}
        />
      ) : null}
    </FormSheet>
  );
}
