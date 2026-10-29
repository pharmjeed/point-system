import { useEffect, useState } from 'react';
import type { BulkLabels } from '@/api/types';
import { Dialog, TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { setupStatus, ui } from '@/i18n/ar';
import { s09 } from '@/i18n/ar.staff';
import { onlyDigits } from '@/lib/digits';

/** One-field create form: «منطقة جديدة», «لوحة جديدة», «مجموعة جديدة». */
export function NameSheet({
  id,
  open,
  onOpenChange,
  title,
  label,
  pending,
  onSubmit,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  pending: boolean;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setName('');
      setErrors(NO_ERRORS);
    }
  }, [open]);
  const submit = async () => {
    if (!name.trim()) {
      setErrors({ form: null, requestId: null, fields: { name: ui.validation } });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      await onSubmit(name.trim());
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
    }
  };
  return (
    <FormSheet
      id={id}
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      submitLabel={title}
      onSubmit={submit}
      pending={pending}
      errors={errors}
    >
      <TextField
        id={`${id}-name`}
        label={label}
        value={name}
        maxLength={60}
        error={fieldError(errors, 'name')}
        onChange={(e) => setName(e.target.value)}
      />
    </FormSheet>
  );
}

/**
 * Bulk creation by range (02 S-09: spots «A-01 إلى A-40», slots «1 إلى 120») — `range` body of
 * `POST /v1/venues/{venueId}/parking-spots` / `POST /v1/key-boards/{boardId}/slots` (max 500 labels).
 */
export function RangeSheet({
  id,
  open,
  onOpenChange,
  title,
  pattern,
  defaultPrefix,
  pending,
  onSubmit,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  pattern: string;
  defaultPrefix: string;
  pending: boolean;
  onSubmit: (range: NonNullable<BulkLabels['range']>) => Promise<unknown>;
}) {
  const [prefix, setPrefix] = useState(defaultPrefix);
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setPrefix(defaultPrefix);
      setFrom('1');
      setTo('');
      setErrors(NO_ERRORS);
    }
  }, [open]); // deliberately not on defaultPrefix
  const submit = async () => {
    const a = Number(onlyDigits(from));
    const b = Number(onlyDigits(to));
    const fields: Record<string, string> = {};
    if (!from.trim() || !Number.isInteger(a)) fields['range.from'] = ui.validation;
    if (!to.trim() || !Number.isInteger(b) || b < a || b - a + 1 > 500) fields['range.to'] = ui.validation;
    if (Object.keys(fields).length) {
      setErrors({ form: null, requestId: null, fields });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      await onSubmit({ ...(prefix.trim() ? { prefix: prefix.trim() } : {}), from: a, to: b });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
    }
  };
  return (
    <FormSheet
      id={id}
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      submitLabel={title}
      onSubmit={submit}
      pending={pending}
      errors={errors}
    >
      <TextField
        id={`${id}-prefix`}
        label={s09.prefix}
        hint={pattern}
        dir="ltr"
        value={prefix}
        maxLength={10}
        error={fieldError(errors, 'range.prefix', 'prefix')}
        onChange={(e) => setPrefix(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          id={`${id}-from`}
          label={s09.from}
          inputMode="numeric"
          dir="ltr"
          value={from}
          error={fieldError(errors, 'range.from')}
          onChange={(e) => setFrom(onlyDigits(e.target.value))}
        />
        <TextField
          id={`${id}-to`}
          label={s09.to}
          inputMode="numeric"
          dir="ltr"
          value={to}
          error={fieldError(errors, 'range.to', 'labels')}
          onChange={(e) => setTo(onlyDigits(e.target.value))}
        />
      </div>
    </FormSheet>
  );
}

/** Disable / enable one spot or slot; an occupied item cannot be disabled (02 S-09). */
export function ToggleItemDialog({
  id,
  label,
  active,
  open,
  onOpenChange,
  pending,
  error,
  onConfirm,
}: {
  id: string;
  label: string;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error?: string;
  onConfirm: () => Promise<unknown>;
}) {
  return (
    <Dialog
      id={id}
      open={open}
      onOpenChange={onOpenChange}
      title={label}
      body={active ? setupStatus.active : setupStatus.inactive}
      destructive={active}
      confirmLabel={active ? s09.disable : s09.enable}
      loading={pending}
      error={error}
      onConfirm={onConfirm}
      onCancel={() => onOpenChange(false)}
    />
  );
}
