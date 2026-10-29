import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createDriver, listDrivers, type DriverInput } from '@/api/drivers';
import { queryKeys } from '@/api/queryClient';
import { listVenues } from '@/api/setup';
import type { CreatedDriver, Venue } from '@/api/types';
import { can } from '@/app/permissions';
import {
  Button,
  DriverStateChip,
  EmptyState,
  FilterChips,
  ListItem,
  PhoneInput,
  SearchField,
  Select,
  TextField,
} from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { QueryView } from '@/features/common/QueryView';
import { UserStatusChip } from '@/features/common/StateChip';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { useCommand } from '@/hooks/useCommand';
import { nav, ui } from '@/i18n/ar';
import { s05 } from '@/i18n/ar.staff';
import { errorMessagesAr } from '@/i18n/errors';
import { normalizeSaudiMobile } from '@/lib/phone';
import { matchesFilter, matchesSearch, stateOf, type DriverFilter } from './driverModel';
import { TempSecretDialog } from './TempSecretDialog';

const FILTERS: DriverFilter[] = ['all', 'available', 'busy', 'on_break', 'off_duty', 'disabled'];

/**
 * S-05 — drivers of the caller's venues with their state (02 S-05; live updates in PNT-084). «إضافة سائق»
 * for `driver.manage` only.
 */
export function DriversPage() {
  const me = useStaffMe();
  const venues = useQuery({ queryKey: queryKeys.venues, queryFn: ({ signal }) => listVenues(signal) });
  const scoped = me.scopes
    .filter((s) => s.scope_type === 'venue' && s.venue_id)
    .map((s) => s.venue_id as string);
  const [venueId, setVenueId] = useState<string>(scoped.length === 1 ? (scoped[0] as string) : '');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DriverFilter>('all');
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedDriver | null>(null);
  const drivers = useQuery({
    queryKey: queryKeys.driverList(venueId || null),
    queryFn: ({ signal }) => listDrivers(venueId ? { venue_id: venueId } : {}, signal),
  });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-title">
      <div className="pt-pagehead">
        <h1 className="pt-page-title" id="page-title">
          {nav.drivers}
        </h1>
        {can(me, 'driver.manage') ? (
          <Button compact variant="secondary" iconStart={Plus} onClick={() => setAdding(true)}>
            {s05.add}
          </Button>
        ) : null}
      </div>
      {venues.data && venues.data.length > 1 ? (
        <Select
          id="drivers-venue"
          label={s05.venue}
          value={venueId}
          options={[['', s05.allVenues] as const, ...venues.data.map((v) => [v.id, v.name_ar] as const)]}
          onChange={(e) => setVenueId(e.target.value)}
        />
      ) : null}
      <SearchField
        id="drivers-search"
        value={query}
        onChange={setQuery}
        placeholder={s05.search}
        label={s05.search}
      />
      <FilterChips
        label={nav.drivers}
        value={[filter]}
        onChange={(next) => setFilter((next.find((v) => v !== filter) as DriverFilter | undefined) ?? 'all')}
        options={FILTERS.map((f) => ({ value: f, label: s05.filters[f] }))}
      />
      <QueryView query={drivers}>
        {(list) => {
          const shown = list
            .filter((d) => matchesFilter(d, filter) && matchesSearch(d, query))
            .sort((a, b) => a.user.full_name.localeCompare(b.user.full_name, 'ar'));
          return shown.length === 0 ? (
            <EmptyState icon={Users} title={s05.empty} />
          ) : (
            <ul className="pt-list" aria-label={nav.drivers}>
              {shown.map((d) => (
                <li key={d.user.id}>
                  <ListItem
                    icon={User}
                    to={`/drivers/${d.user.id}`}
                    title={
                      <>
                        {d.user.full_name} ·{' '}
                        <bdi dir="ltr" className="pt-num">
                          {d.user.employee_code}
                        </bdi>
                      </>
                    }
                    meta={d.active_assignment?.venue_name_ar ?? s05.none}
                    trailing={
                      d.user.status === 'disabled' ? (
                        <UserStatusChip status="disabled" />
                      ) : (
                        <DriverStateChip state={stateOf(d)} />
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          );
        }}
      </QueryView>
      {can(me, 'driver.manage') ? (
        <AddDriverSheet
          open={adding}
          onOpenChange={setAdding}
          venues={venues.data ?? []}
          defaultVenue={venueId}
          onCreated={setCreated}
        />
      ) : null}
      <TempSecretDialog
        name={created?.driver.full_name ?? ''}
        secret={created?.temporary_secret ?? null}
        onClose={() => setCreated(null)}
      />
    </section>
  );
}

/** «إضافة سائق» (02 S-05): name, phone, employee code, optional first venue — one `POST /v1/drivers`. */
function AddDriverSheet({
  open,
  onOpenChange,
  venues,
  defaultVenue,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venues: Venue[];
  defaultVenue: string;
  onCreated: (created: CreatedDriver) => void;
}) {
  const qc = useQueryClient();
  const blank = { full_name: '', phone: '', employee_code: '', venue: defaultVenue };
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setForm(blank);
      setErrors(NO_ERRORS);
    }
  }, [open]); // deliberately not on defaultVenue
  const create = useCommand((body: DriverInput, key: string) => createDriver(body, key));
  const submit = async () => {
    const phone = normalizeSaudiMobile(form.phone);
    const local: Record<string, string> = {};
    if (!form.full_name.trim()) local.full_name = ui.validation;
    if (!phone) local.phone = errorMessagesAr.PHONE_INVALID;
    if (Object.keys(local).length || !phone) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      const created = await create.run({
        full_name: form.full_name.trim(),
        phone,
        ...(form.employee_code.trim() ? { employee_code: form.employee_code.trim() } : {}),
        initial_venue_id: form.venue || null,
      });
      onOpenChange(false);
      onCreated(created);
    } catch (error) {
      setErrors(toFormErrors(error, { PHONE_INVALID: 'phone' }));
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.drivers });
    }
  };
  return (
    <FormSheet
      id="driver-form"
      open={open}
      onOpenChange={onOpenChange}
      title={s05.addTitle}
      submitLabel={s05.add}
      onSubmit={submit}
      pending={create.pending}
      errors={errors}
    >
      <TextField
        id="driver-name"
        label={s05.fullName}
        value={form.full_name}
        maxLength={80}
        error={fieldError(errors, 'full_name')}
        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
      />
      <PhoneInput
        id="driver-phone"
        label={s05.phone}
        value={form.phone}
        error={fieldError(errors, 'phone')}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
      />
      <TextField
        id="driver-code"
        label={s05.employeeCode}
        value={form.employee_code}
        dir="ltr"
        maxLength={20}
        error={fieldError(errors, 'employee_code')}
        onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
      />
      <Select
        id="driver-venue"
        label={s05.initialVenue}
        value={form.venue}
        placeholder="—"
        options={venues.map((v) => [v.id, v.name_ar] as const)}
        error={fieldError(errors, 'initial_venue_id')}
        onChange={(e) => setForm((f) => ({ ...f, venue: e.target.value }))}
      />
    </FormSheet>
  );
}
