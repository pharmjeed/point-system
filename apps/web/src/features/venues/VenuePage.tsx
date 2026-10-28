import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarPlus, Clock, Pencil, Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, displayMessage } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import {
  cancelEvent,
  closeShift,
  getVenue,
  getVenueSettings,
  listEvents,
  listPools,
  listShifts,
  openEvent,
  openShift,
} from '@/api/setup';
import type { BlockingDriver, DispatchPool, Me, Shift, Venue, VenueEvent, VenueSettings } from '@/api/types';
import { can } from '@/app/permissions';
import { Button, Card, Dialog, EmptyState, FieldError, Header, SegmentedControl } from '@/components';
import { QueryView } from '@/features/common/QueryView';
import { EventStatusChip, ShiftStatusChip } from '@/features/common/StateChip';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { useCommand } from '@/hooks/useCommand';
import { nav, s08, ui } from '@/i18n/ar';
import { paths } from '@/app/paths';
import { todayRiyadh } from '@/lib/riyadh';
import { useUiStore } from '@/stores/ui';
import { BlockingDrivers } from './BlockingList';
import { EventFormSheet } from './EventFormSheet';
import { ShiftFormSheet } from './ShiftFormSheet';
import { VenueFormSheet } from './VenueFormSheet';
import { eventsIn, pricingText, shiftWhenText, whenText, type EventGroup } from './venueModel';

type Tab = 'events' | 'shifts';

/**
 * S-08 venue page (`/venues/:venueId`): «الحفلات» (اليوم · القادمة · المغلقة) and «الورديات», with the
 * create/open/cancel/close actions for whoever holds `event.manage` / `shift.manage`, and the way to S-09.
 */
export function VenuePage() {
  const { venueId = '' } = useParams();
  const me = useStaffMe();
  const navigate = useNavigate();
  const venue = useQuery({
    queryKey: queryKeys.venue(venueId),
    queryFn: ({ signal }) => getVenue(venueId, signal),
  });
  const [editing, setEditing] = useState(false);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="venue-title">
      <QueryView query={venue} backTo={paths.venues}>
        {(v) => (
          <>
            <Header title={v.name_ar} onBack={() => navigate(paths.venues)} />
            <span className="pt-sr" id="venue-title">
              {v.name_ar}
            </span>
            <div className="pt-record__actions">
              <Button
                compact
                variant="secondary"
                iconStart={Settings2}
                onClick={() => navigate(`/venues/${v.id}/setup`)}
              >
                {s08.setup}
              </Button>
              {can(me, 'venue.manage') ? (
                <Button compact variant="ghost" iconStart={Pencil} onClick={() => setEditing(true)}>
                  {s08.editVenue}
                </Button>
              ) : null}
            </div>
            <VenueBody me={me} venue={v} />
            <VenueFormSheet open={editing} onOpenChange={setEditing} venue={v} />
          </>
        )}
      </QueryView>
    </section>
  );
}

function VenueBody({ me, venue }: { me: Me; venue: Venue }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'shifts' ? 'shifts' : 'events';
  const pools = useQuery({
    queryKey: queryKeys.pools(venue.id),
    queryFn: ({ signal }) => listPools(venue.id, signal),
  });
  return (
    <>
      <SegmentedControl
        label={nav.venues}
        value={tab}
        onChange={(next) => setParams(next === 'events' ? {} : { tab: next }, { replace: true })}
        options={[
          { value: 'events', label: s08.events, icon: CalendarClock },
          { value: 'shifts', label: s08.shifts, icon: Clock },
        ]}
      />
      {tab === 'events' ? (
        <EventsTab me={me} venue={venue} pools={pools.data ?? []} />
      ) : (
        <ShiftsTab me={me} venue={venue} pools={pools.data ?? []} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- events

function EventsTab({ me, venue, pools }: { me: Me; venue: Venue; pools: DispatchPool[] }) {
  const events = useQuery({
    queryKey: queryKeys.events(venue.id),
    queryFn: ({ signal }) => listEvents(venue.id, signal),
  });
  const settings = useQuery({
    queryKey: queryKeys.venueSettings(venue.id),
    queryFn: ({ signal }) => getVenueSettings(venue.id, signal),
    enabled: can(me, 'venue.read'),
  });
  const [group, setGroup] = useState<EventGroup>('today');
  const [creating, setCreating] = useState(false);
  const manage = can(me, 'event.manage');
  const today = todayRiyadh();
  return (
    <div className="flex flex-col gap-3">
      <div className="pt-pagehead">
        <h2 className="pt-section-title">{s08.events}</h2>
        {manage ? (
          <Button compact iconStart={CalendarPlus} onClick={() => setCreating(true)}>
            {s08.newEvent}
          </Button>
        ) : null}
      </div>
      <SegmentedControl
        label={s08.events}
        value={group}
        onChange={setGroup}
        options={[
          { value: 'today', label: s08.today },
          { value: 'upcoming', label: s08.upcoming },
          { value: 'closed', label: s08.closed },
        ]}
      />
      <QueryView query={events}>
        {(list) => {
          const shown = eventsIn(list, group, today);
          return shown.length === 0 ? (
            <EmptyState icon={CalendarClock} title={s08.emptyEvents} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={s08.events}>
              {shown.map((event) => (
                <li key={event.id}>
                  <EventCard
                    event={event}
                    manage={manage}
                    venueId={venue.id}
                    pools={pools}
                    settings={settings.data?.settings}
                  />
                </li>
              ))}
            </ul>
          );
        }}
      </QueryView>
      {manage ? (
        <EventFormSheet
          open={creating}
          onOpenChange={setCreating}
          venueId={venue.id}
          pools={pools}
          settings={settings.data?.settings}
        />
      ) : null}
    </div>
  );
}

function EventCard({
  event,
  manage,
  venueId,
  pools,
  settings,
}: {
  event: VenueEvent;
  manage: boolean;
  venueId: string;
  pools: DispatchPool[];
  settings?: VenueSettings;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [editing, setEditing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const open = useCommand((body: { expected_version: number }, key: string) =>
    openEvent(event.id, body, key),
  );
  const cancel = useCommand((body: { reason: string; expected_version: number }, key: string) =>
    cancelEvent(event.id, body, key),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.events(venueId) });

  const onOpen = async () => {
    try {
      await open.run({ expected_version: event.version });
      pushToast({ message: ui.saved, tone: 'success' });
    } catch {
      // shown under the actions
    } finally {
      void refresh();
    }
  };

  const onCancel = async () => {
    if (reason.trim().length < 3) {
      setCancelError(ui.reasonRequired);
      return;
    }
    setCancelError(null);
    try {
      await cancel.run({ reason: reason.trim(), expected_version: event.version });
      pushToast({ message: ui.saved, tone: 'success' });
      setCanceling(false);
      setReason('');
    } catch (error) {
      setCancelError(displayMessage(error));
    } finally {
      void refresh();
    }
  };

  const editable = manage && (event.status === 'draft' || event.status === 'open');
  return (
    <Card as="article" className="pt-record" aria-label={event.name_ar} data-event-id={event.id}>
      <div className="pt-record__head">
        <h3 className="pt-record__title">{event.name_ar}</h3>
        <EventStatusChip status={event.status} />
      </div>
      <p className="pt-record__meta">{whenText(event)}</p>
      {event.host_name ? <p className="pt-record__meta">{event.host_name}</p> : null}
      <p className="pt-record__meta">{pricingText(event)}</p>
      {editable ? (
        <div className="pt-record__actions">
          {event.status === 'draft' ? (
            <Button compact loading={open.pending} onClick={onOpen}>
              {s08.open}
            </Button>
          ) : null}
          <Button compact variant="secondary" onClick={() => setEditing(true)}>
            {s08.edit}
          </Button>
          <Button compact variant="ghost" onClick={() => setCanceling(true)}>
            {s08.cancel}
          </Button>
        </div>
      ) : null}
      {open.error ? <FieldError role="alert">{displayMessage(open.error)}</FieldError> : null}
      {editable ? (
        <>
          <EventFormSheet
            open={editing}
            onOpenChange={setEditing}
            venueId={venueId}
            event={event}
            pools={pools}
            settings={settings}
          />
          <Dialog
            id={`cancel-${event.id}`}
            open={canceling}
            onOpenChange={setCanceling}
            title={s08.cancelEvent}
            body={event.name_ar}
            reasonRequired
            reason={reason}
            onReasonChange={setReason}
            destructive
            confirmLabel={s08.cancelEvent}
            loading={cancel.pending}
            error={cancelError ?? undefined}
            onConfirm={onCancel}
            onCancel={() => {
              setCanceling(false);
              setCancelError(null);
            }}
          />
        </>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- shifts

function ShiftsTab({ me, venue, pools }: { me: Me; venue: Venue; pools: DispatchPool[] }) {
  const shifts = useQuery({
    queryKey: queryKeys.shifts(venue.id),
    queryFn: ({ signal }) => listShifts(venue.id, signal),
  });
  const [creating, setCreating] = useState(false);
  const manage = can(me, 'shift.manage');
  return (
    <div className="flex flex-col gap-3">
      <div className="pt-pagehead">
        <h2 className="pt-section-title">{s08.shifts}</h2>
        {manage ? (
          <Button compact iconStart={Plus} onClick={() => setCreating(true)}>
            {s08.newShift}
          </Button>
        ) : null}
      </div>
      <QueryView query={shifts}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={Clock} title={s08.emptyShifts} />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={s08.shifts}>
              {[...list]
                .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
                .map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard shift={shift} manage={manage} venueId={venue.id} pools={pools} />
                  </li>
                ))}
            </ul>
          )
        }
      </QueryView>
      {manage ? (
        <ShiftFormSheet open={creating} onOpenChange={setCreating} venueId={venue.id} pools={pools} />
      ) : null}
    </div>
  );
}

function ShiftCard({
  shift,
  manage,
  venueId,
  pools,
}: {
  shift: Shift;
  manage: boolean;
  venueId: string;
  pools: DispatchPool[];
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<{ message: string; drivers: BlockingDriver[] } | null>(null);
  const open = useCommand((body: { expected_version: number }, key: string) =>
    openShift(shift.id, body, key),
  );
  const close = useCommand((body: { expected_version: number }, key: string) =>
    closeShift(shift.id, body, key),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.shifts(venueId) });
  const pool = pools.length > 1 ? pools.find((p) => p.id === shift.dispatch_pool_id) : undefined;

  const onOpen = async () => {
    try {
      await open.run({ expected_version: shift.version });
      pushToast({ message: ui.saved, tone: 'success' });
    } catch {
      // shown under the actions
    } finally {
      void refresh();
    }
  };

  const onClose = async () => {
    setCloseError(null);
    try {
      await close.run({ expected_version: shift.version });
      pushToast({ message: ui.saved, tone: 'success' });
      setClosing(false);
    } catch (error) {
      const drivers =
        error instanceof ApiError && Array.isArray(error.details.blocking_drivers)
          ? (error.details.blocking_drivers as BlockingDriver[])
          : [];
      setCloseError({ message: displayMessage(error), drivers });
    } finally {
      void refresh();
    }
  };

  const title = shift.name || s08.shifts;
  return (
    <Card as="article" className="pt-record" aria-label={title} data-shift-id={shift.id}>
      <div className="pt-record__head">
        <h3 className="pt-record__title">{title}</h3>
        <ShiftStatusChip status={shift.status} />
      </div>
      <p className="pt-record__meta">{shiftWhenText(shift)}</p>
      {pool ? <p className="pt-record__meta">{pool.name}</p> : null}
      {manage && shift.status !== 'closed' ? (
        <div className="pt-record__actions">
          {shift.status === 'scheduled' ? (
            <Button compact loading={open.pending} onClick={onOpen}>
              {s08.openShift}
            </Button>
          ) : (
            <Button compact variant="secondary" onClick={() => setClosing(true)}>
              {s08.closeShift}
            </Button>
          )}
        </div>
      ) : null}
      {open.error ? <FieldError role="alert">{displayMessage(open.error)}</FieldError> : null}
      {manage && shift.status === 'open' ? (
        <Dialog
          id={`close-${shift.id}`}
          open={closing}
          onOpenChange={setClosing}
          title={s08.closeShift}
          body={s08.closeShiftBody}
          destructive
          confirmLabel={s08.closeShift}
          loading={close.pending}
          error={closeError?.message}
          onConfirm={onClose}
          onCancel={() => {
            setClosing(false);
            setCloseError(null);
          }}
        >
          {closeError?.drivers.length ? <BlockingDrivers drivers={closeError.drivers} /> : null}
        </Dialog>
      ) : null}
    </Card>
  );
}
