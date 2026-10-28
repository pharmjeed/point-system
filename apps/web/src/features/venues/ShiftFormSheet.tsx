import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import { createShift } from '@/api/setup';
import type { DispatchPool, ShiftInput } from '@/api/types';
import { Select, TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { useCommand } from '@/hooks/useCommand';
import { s08, ui } from '@/i18n/ar';
import { riyadhParts, riyadhRange, todayRiyadh } from '@/lib/riyadh';
import { useUiStore } from '@/stores/ui';

/** «وردية جديدة» (S-08, `shift.manage`): POST /v1/venues/{venueId}/shifts — name, start, optional end. */
export function ShiftFormSheet({
  open,
  onOpenChange,
  venueId,
  pools,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueId: string;
  pools: DispatchPool[];
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const activePools = pools.filter((p) => p.status === 'active');
  const defaultPool = activePools.find((p) => p.is_default)?.id ?? activePools[0]?.id ?? '';
  const blank = () => ({
    name: '',
    date: todayRiyadh(),
    start: riyadhParts(Date.now()).time,
    end: '',
    pool: defaultPool,
  });
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  // reset only when the sheet opens
  useEffect(() => {
    if (!open) return;
    setErrors(NO_ERRORS);
    setForm(blank());
  }, [open]); // deliberately not on pools

  const create = useCommand((body: ShiftInput, key: string) => createShift(venueId, body, key));

  const submit = async () => {
    const { starts_at, ends_at } = riyadhRange(form.date, form.start, form.end);
    if (!starts_at) {
      setErrors({ form: null, requestId: null, fields: { starts_at: ui.validation } });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      await create.run({
        name: form.name.trim() || null,
        starts_at,
        ends_at,
        ...(form.pool ? { dispatch_pool_id: form.pool } : {}),
      });
      pushToast({ message: ui.saved, tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.shifts(venueId) });
    }
  };

  return (
    <FormSheet
      id="shift-form"
      open={open}
      onOpenChange={onOpenChange}
      title={s08.newShift}
      submitLabel={s08.newShift}
      onSubmit={submit}
      pending={create.pending}
      errors={errors}
    >
      <TextField
        id="shift-name"
        label={s08.shiftName}
        value={form.name}
        maxLength={60}
        error={fieldError(errors, 'name')}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
      />
      <TextField
        id="shift-date"
        type="date"
        label={s08.date}
        value={form.date}
        onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          id="shift-start"
          type="time"
          label={s08.start}
          value={form.start}
          error={fieldError(errors, 'starts_at')}
          onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
        />
        <TextField
          id="shift-end"
          type="time"
          label={s08.shiftEnd}
          value={form.end}
          error={fieldError(errors, 'ends_at')}
          onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
        />
      </div>
      {activePools.length > 1 ? (
        <Select
          id="shift-pool"
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
