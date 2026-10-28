import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { queryKeys } from '@/api/queryClient';
import { createVenue, patchVenue, type VenueInput } from '@/api/setup';
import type { Venue } from '@/api/types';
import { TextField } from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { useCommand } from '@/hooks/useCommand';
import { s08, ui } from '@/i18n/ar';
import { useUiStore } from '@/stores/ui';

const blank = { code: '', name_ar: '', name_en: '', city: '', address: '' };

/** «موقع جديد» / «تعديل الموقع» (S-08, `venue.manage`): POST /v1/venues or PATCH /v1/venues/{venueId}. */
export function VenueFormSheet({
  open,
  onOpenChange,
  venue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venue?: Venue;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  // reset only when the sheet opens (a refetch must not wipe what the user typed)
  useEffect(() => {
    if (!open) return;
    setErrors(NO_ERRORS);
    setForm(
      venue
        ? {
            code: venue.code,
            name_ar: venue.name_ar,
            name_en: venue.name_en ?? '',
            city: venue.city ?? '',
            address: venue.address ?? '',
          }
        : blank,
    );
  }, [open]); // deliberately not on venue

  const create = useCommand((body: VenueInput, key: string) => createVenue(body, key));
  const update = useCommand((body: Parameters<typeof patchVenue>[1], key: string) =>
    patchVenue(venue?.id ?? '', body, key),
  );
  const pending = create.pending || update.pending;

  const submit = async () => {
    const code = form.code.trim().toUpperCase();
    const local: Record<string, string> = {};
    if (!venue && !/^[A-Z0-9]{2,8}$/.test(code)) local.code = ui.validation;
    if (!form.name_ar.trim()) local.name_ar = ui.validation;
    if (Object.keys(local).length) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    const optional = (v: string) => (v.trim() ? v.trim() : undefined);
    try {
      if (venue) {
        await update.run({
          expected_version: venue.version,
          name_ar: form.name_ar.trim(),
          name_en: optional(form.name_en) ?? null,
          city: optional(form.city) ?? null,
          address: optional(form.address) ?? null,
        });
      } else {
        const created = await create.run({
          code,
          name_ar: form.name_ar.trim(),
          name_en: optional(form.name_en),
          city: optional(form.city),
          address: optional(form.address),
        });
        navigate(`/venues/${created.id}`);
      }
      pushToast({ message: ui.saved, tone: 'success' });
      await qc.invalidateQueries({ queryKey: queryKeys.venues });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
      if (venue) void qc.invalidateQueries({ queryKey: queryKeys.venue(venue.id) });
    }
  };

  const set = (key: keyof typeof blank) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <FormSheet
      id="venue-form"
      open={open}
      onOpenChange={onOpenChange}
      title={venue ? s08.editVenue : s08.newVenue}
      submitLabel={venue ? s08.editVenue : s08.newVenue}
      onSubmit={submit}
      pending={pending}
      errors={errors}
    >
      <TextField
        id="venue-code"
        label={s08.venueCode}
        value={form.code}
        dir="ltr"
        autoCapitalize="characters"
        maxLength={8}
        disabled={!!venue}
        error={fieldError(errors, 'code')}
        onChange={set('code')}
      />
      <TextField
        id="venue-name"
        label={s08.venueName}
        value={form.name_ar}
        error={fieldError(errors, 'name_ar')}
        onChange={set('name_ar')}
      />
      <TextField
        id="venue-name-en"
        label={s08.venueNameEn}
        value={form.name_en}
        dir="ltr"
        error={fieldError(errors, 'name_en')}
        onChange={set('name_en')}
      />
      <TextField
        id="venue-city"
        label={s08.city}
        value={form.city}
        error={fieldError(errors, 'city')}
        onChange={set('city')}
      />
      <TextField
        id="venue-address"
        label={s08.address}
        value={form.address}
        error={fieldError(errors, 'address')}
        onChange={set('address')}
      />
    </FormSheet>
  );
}
