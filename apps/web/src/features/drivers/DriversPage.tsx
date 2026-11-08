import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { createDriver, listDrivers, type DriverInput } from '@/api/drivers';
import { queryKeys } from '@/api/queryClient';
import { listVenues } from '@/api/setup';
import type { CreatedDriver, DriverListItem, Venue } from '@/api/types';
import { can } from '@/app/permissions';
import {
  Button,
  ConnectionIndicator,
  DataTable,
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
import { useSelectionStore } from '@/features/supervisor/selection';
import { useCommand } from '@/hooks/useCommand';
import { useServerNow } from '@/hooks/useNow';
import { nav, ui } from '@/i18n/ar';
import { s05, staff } from '@/i18n/ar.staff';
import { errorMessagesAr } from '@/i18n/errors';
import { fmt } from '@/i18n/fmt';
import { formatClock, formatTime } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { matchesFilter, matchesSearch, stateOf, type DriverFilter } from './driverModel';
import { TempSecretDialog } from './TempSecretDialog';
import '@/features/supervisor/staff.css';

const FILTERS: DriverFilter[] = ['all', 'available', 'busy', 'on_break', 'off_duty', 'disabled'];

/**
 * S-05 — drivers of the caller's venues with their state (02 S-05): each row «الاسم · الرمز │ الحالة» with the
 * venue, «منذ 4:10» for an available driver and the connection of an open duty; live through
 * `driver.state_changed` (staffRuntime). «إضافة سائق» for `driver.manage` only.
 */
export function DriversPage() {
  const me = useStaffMe();
  const venues = useQuery({ queryKey: queryKeys.venues, queryFn: ({ signal }) => listVenues(signal) });
  const scoped = me.scopes
    .filter((s) => s.scope_type === 'venue' && s.venue_id)
    .map((s) => s.venue_id as string);
  // the venue chosen in S-02 / S-11 / S-12 carries over and back (02 §1.3, DEC-320; audit A-SHELL-1); «كل
  // المواقع» stays local to S-05 (the shared selection always names one venue)
  const shared = useSelectionStore((s) => s.venueId);
  const setShared = useSelectionStore((s) => s.setVenue);
  const [venueId, setLocalVenue] = useState<string>(
    shared ?? (scoped.length === 1 ? (scoped[0] as string) : ''),
  );
  const setVenueId = (id: string) => {
    setLocalVenue(id);
    if (id && id !== shared) setShared(id);
  };
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DriverFilter>('all');
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<CreatedDriver | null>(null);
  const now = useServerNow(1000);
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
            <>
              {/* below 1024px the 02 S-05 DriverRow list; from 1024px the 02 S-05 table (02 §1.4, 03 §3.16) */}
              <ul className="pt-list st-below-desktop" aria-label={nav.drivers}>
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
                      meta={<RowMeta driver={d} now={now} />}
                      trailing={<StateCell driver={d} />}
                    />
                  </li>
                ))}
              </ul>
              <div className="st-desktop-only">
                <DriversTable rows={shown} now={now} />
              </div>
            </>
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

function StateCell({ driver }: { driver: DriverListItem }) {
  return driver.user.status === 'disabled' ? (
    <UserStatusChip status="disabled" />
  ) : (
    <DriverStateChip state={stateOf(driver)} />
  );
}

type SortKey = 'name' | 'code' | 'duty';

/**
 * 02 S-05 «على الشاشات الكبيرة: جدول بأعمدة: الاسم، الرقم الوظيفي، الحالة، المهمة، الاتصال، بداية المناوبة،
 * الجهاز». «المهمة» and «الجهاز» show «—»: `DriverLive` has task ids without ticket numbers and no device state
 * (staff-gaps.md API gaps 1–2, audit A-S06-1); the five other columns come from `GET /v1/drivers`.
 */
function DriversTable({ rows, now }: { rows: DriverListItem[]; now: number }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const liveOf = (d: DriverListItem) =>
    d.user.status !== 'disabled' && d.live && d.live.driver_state !== 'off_duty' ? d.live : null;
  const value = (d: DriverListItem, key: SortKey) =>
    key === 'name'
      ? d.user.full_name
      : key === 'code'
        ? (d.user.employee_code ?? '')
        : (liveOf(d)?.duty_started_at ?? '');
  const sorted = [...rows].sort((a, b) => {
    const c = value(a, sort.key).localeCompare(value(b, sort.key), 'ar');
    return sort.dir === 'asc' ? c : -c;
  });
  return (
    <DataTable<DriverListItem>
      layout="table"
      rows={sorted}
      rowKey={(d) => d.user.id}
      sort={sort}
      onSort={(key) =>
        setSort((s) => ({
          key: key as SortKey,
          dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc',
        }))
      }
      columns={[
        {
          key: 'name',
          label: s05.table.name,
          sortable: true,
          render: (d) => (
            <Link className="pt-link" to={`/drivers/${d.user.id}`}>
              {d.user.full_name}
            </Link>
          ),
        },
        {
          key: 'code',
          label: s05.table.employeeCode,
          sortable: true,
          render: (d) => (
            <bdi dir="ltr" className="pt-num">
              {d.user.employee_code}
            </bdi>
          ),
        },
        {
          key: 'state',
          label: s05.table.state,
          render: (d) => {
            const live = liveOf(d);
            return (
              <span className="inline-flex flex-wrap items-center gap-2">
                <StateCell driver={d} />
                {live?.driver_state === 'available' && live.available_since ? (
                  <span>
                    {fmt(staff.since, { time: '' })}
                    <bdi dir="ltr" className="pt-num">
                      {formatClock((now - Date.parse(live.available_since)) / 1000)}
                    </bdi>
                  </span>
                ) : null}
              </span>
            );
          },
        },
        { key: 'task', label: s05.table.task, render: () => staff.none },
        {
          key: 'connection',
          label: s05.table.connection,
          render: (d) => {
            const live = liveOf(d);
            return live ? <ConnectionIndicator state={live.connection_state ?? 'offline'} /> : staff.none;
          },
        },
        {
          key: 'duty',
          label: s05.table.dutyStart,
          sortable: true,
          render: (d) => {
            const at = liveOf(d)?.duty_started_at;
            return at ? (
              <bdi dir="ltr" className="pt-num">
                {formatTime(at)}
              </bdi>
            ) : (
              staff.none
            );
          },
        },
        { key: 'device', label: s05.table.device, render: () => staff.none },
      ]}
    />
  );
}

/** The venue, «منذ 4:10» while available (`available_since`), and the connection of an open duty (02 S-05). */
function RowMeta({ driver, now }: { driver: DriverListItem; now: number }) {
  const live = driver.user.status === 'disabled' ? null : driver.live;
  const onDuty = !!live && live.driver_state !== 'off_duty';
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{driver.active_assignment?.venue_name_ar ?? s05.none}</span>
      {onDuty && live.driver_state === 'available' && live.available_since ? (
        <span>
          {fmt(staff.since, { time: '' })}
          <bdi dir="ltr" className="pt-num">
            {formatClock((now - Date.parse(live.available_since)) / 1000)}
          </bdi>
        </span>
      ) : null}
      {onDuty ? <ConnectionIndicator state={live.connection_state ?? 'offline'} /> : null}
    </span>
  );
}
