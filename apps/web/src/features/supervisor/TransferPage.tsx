import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, Info, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type {
  CustodyBlockItem,
  DriverListItem,
  DriverTransfer,
  Me,
  OperationsBoard,
  Venue,
} from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Card,
  FieldError,
  Header,
  Icon,
  SegmentedControl,
  Select,
  Stepper,
  TextArea,
  TextField,
} from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { useOnline } from '@/hooks/useOnline';
import { buttons, transferStatus } from '@/i18n/ar';
import { s07, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { formatDateTime, formatTime } from '@/lib/format';
import { serverNow } from '@/lib/serverClock';
import { can } from './permissions';
import { LIVE_EVENT_STATUSES, useVenues } from './selection';
import {
  commands,
  fetchBoard,
  fetchDriver,
  fetchDriverAssignments,
  fetchVenueEvents,
  staffKeys,
} from './staffApi';
import { staffPaths } from './staffPaths';
import {
  checklistFrom,
  fromBlockItems,
  riyadhLocalToUtcIso,
  utcIsoToRiyadhLocal,
  type TransferChecklist,
} from './transferModel';
import { ForbiddenPage, PageSkeleton, ReadError, ReasonDialog, reasonOk, Section } from './ui';
import { useStaffCommand } from './useStaffCommand';
import './staff.css';

/**
 * S-07 — نقل سائق (02 §4 S-07, PNT-086, DEC-32): destination among the venues of the scope, now or at a set
 * time, the custody checklist from the snapshot (driver + the boards of the venue's open events), the mandatory
 * reason, `POST /v1/drivers/{driverId}/transfers`. An immediate transfer with a ✗ is disabled; the server's
 * TRANSFER_BLOCKED_CUSTODY `details.items` replaces the checklist; TRANSFER_ALREADY_PENDING shows the open
 * transfer with «إلغاء النقل المجدول» (`POST /v1/transfers/{transferId}/cancel`).
 */
export function TransferPage() {
  const me = useStaffMe();
  const { driverId = '' } = useParams();
  const navigate = useNavigate();
  const driver = useQuery({
    queryKey: staffKeys.driver(driverId),
    queryFn: ({ signal }) => fetchDriver(driverId, signal),
    enabled: can(me, 'driver.read'),
  });
  if (!can(me, 'driver.transfer')) return <ForbiddenPage title={s07.screen} backTo={paths.drivers} />;
  // S-06 (driver detail) belongs to the driver-screens stream: back in history, else the drivers list
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(paths.drivers));
  if (driver.isPending)
    return (
      <div className="st-page">
        <Header title={s07.screen} onBack={back} />
        <PageSkeleton />
      </div>
    );
  if (!driver.data)
    return (
      <div className="st-page">
        <Header title={s07.screen} onBack={back} />
        <ReadError error={driver.error} onRetry={() => void driver.refetch()} backTo={paths.drivers} />
      </div>
    );
  return <TransferForm me={me} item={driver.data} onBack={back} />;
}

function TransferForm({ me, item, onBack }: { me: Me; item: DriverListItem; onBack: () => void }) {
  const online = useOnline();
  const driverId = item.user.id;
  const fromVenueId = item.active_assignment?.venue_id ?? null;
  const venues = useVenues();
  const venueList = venues.data?.items ?? [];
  const venueName = (id: string | null | undefined) =>
    (id &&
      (venueList.find((v) => v.id === id)?.name_ar ??
        (id === fromVenueId ? item.active_assignment?.venue_name_ar : null))) ||
    staff.none;
  const fromName = venueName(fromVenueId);
  const history = useQuery({
    queryKey: staffKeys.driverAssignments(driverId),
    queryFn: ({ signal }) => fetchDriverAssignments(driverId, signal),
  });
  const events = useQuery({
    queryKey: staffKeys.venueEvents(fromVenueId ?? '-', LIVE_EVENT_STATUSES),
    queryFn: ({ signal }) => fetchVenueEvents(fromVenueId as string, LIVE_EVENT_STATUSES, signal),
    enabled: !!fromVenueId && can(me, 'event.manage'),
  });
  const boards = useQueries({
    queries: (events.data?.items ?? []).map((e) => ({
      queryKey: staffKeys.board(e.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBoard(e.id, signal),
      enabled: can(me, 'alert.read'),
    })),
  });
  const stamp = boards.map((b) => b.dataUpdatedAt).join('|');
  const snapshot = useMemo(
    () =>
      checklistFrom(
        driverId,
        item.live,
        boards.filter((b) => b.data).map((b) => b.data as OperationsBoard),
      ),
    [driverId, item.live, stamp], // boards data changes with dataUpdatedAt
  );
  const [serverItems, setServerItems] = useState<CustodyBlockItem[] | null>(null);
  const checklist = serverItems ? fromBlockItems(serverItems, snapshot) : snapshot;

  const [toVenue, setToVenue] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() => utcIsoToRiyadhLocal(new Date(serverNow() + 60 * 60_000).toISOString()));
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<DriverTransfer | null>(null);
  const scheduledIso = when === 'later' ? riyadhLocalToUtcIso(at) : null;

  const cmd = useStaffCommand(
    (body: { to_venue_id: string; scheduled_at: string | null; reason: string }, key: string) =>
      commands.transferDriver(driverId, body, key),
    {
      successMessage: null,
      invalidate: [staffKeys.driver(driverId), staffKeys.driverAssignments(driverId), staffKeys.boards()],
      onSuccess: (t) => setDone(t),
    },
  );
  const blockedItems =
    cmd.apiError?.code === 'TRANSFER_BLOCKED_CUSTODY' && Array.isArray(cmd.apiError.details.items)
      ? (cmd.apiError.details.items as CustodyBlockItem[])
      : null;
  useEffect(() => {
    if (blockedItems) setServerItems(blockedItems);
  }, [blockedItems]);

  const pendingTransfer =
    (history.data?.transfers ?? []).find((t) => t.status === 'pending' || t.status === 'blocked') ?? null;
  const destinations = venueList.filter((v: Venue) => v.id !== fromVenueId);
  const step = !toVenue ? 0 : when === 'later' && !scheduledIso ? 1 : 2;
  const ready =
    !!toVenue &&
    reasonOk(reason) &&
    (when === 'now' ? !checklist.blocked : !!scheduledIso) &&
    item.user.status === 'active';

  const doneText = done
    ? done.status === 'completed'
      ? fmt(s07.successNow, { name: item.user.full_name, venue: venueName(done.to_venue_id), from: fromName })
      : fmt(s07.successScheduled, {
          name: item.user.full_name,
          venue: venueName(done.to_venue_id),
          time: formatTime(done.scheduled_at),
        })
    : null;

  return (
    <div className="st-page">
      <Header
        title={fmt(s07.title, { name: item.user.full_name, code: item.user.employee_code })}
        onBack={onBack}
      />
      {doneText ? (
        <Banner kind="info" rounded message={doneText} actionLabel={buttons.back} onAction={onBack} />
      ) : null}
      {pendingTransfer && !done ? (
        <PendingTransfer transfer={pendingTransfer} venueName={venueName} driverId={driverId} />
      ) : null}
      <Stepper
        current={step as 0 | 1 | 2}
        steps={[
          { label: s07.steps.destination },
          { label: s07.steps.schedule },
          { label: s07.steps.confirm },
        ]}
      />
      {!fromVenueId ? <Banner kind="info" rounded message={s07.noAssignment} /> : null}
      <Card as="section" aria-label={s07.steps.destination}>
        <div className="st-form">
          <p className="m-0">{fmt(s07.from, { venue: fromName })}</p>
          <Select
            id="transfer-to"
            label={s07.to}
            hint={s07.toHint}
            placeholder="—"
            value={toVenue}
            options={destinations.map((v) => [v.id, v.name_ar] as const)}
            error={cmd.fields.to_venue_id}
            onChange={(e) => setToVenue(e.target.value)}
          />
          <SegmentedControl
            label={s07.schedule}
            value={when}
            onChange={setWhen}
            options={[
              { value: 'now', label: s07.now },
              { value: 'later', label: s07.later },
            ]}
          />
          {when === 'later' ? (
            <TextField
              id="transfer-at"
              type="datetime-local"
              label={s07.at}
              value={at}
              dir="ltr"
              error={!scheduledIso ? s07.timeRequired : cmd.fields.scheduled_at}
              onChange={(e) => setAt(e.target.value)}
            />
          ) : null}
        </div>
      </Card>
      <Section
        title={s07.checklist}
        className={cx(checklist.blocked && when === 'now' && 'pt-card st-flagged')}
      >
        <Checklist
          checklist={checklist}
          fromName={fromName}
          blockedByServer={!!serverItems}
          items={serverItems}
        />
        <p className="st-muted">{fmt(s07.after, { venue: fromName })}</p>
      </Section>
      <TextArea
        id="transfer-reason"
        label={s07.reason}
        rows={2}
        value={reason}
        error={cmd.fields.reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {cmd.message && !cmd.fields.reason ? <FieldError role="alert">{cmd.message}</FieldError> : null}
      <Button
        size="lg"
        loading={cmd.pending}
        disabled={!online || !ready || !!done}
        onClick={() => cmd.run({ to_venue_id: toVenue, scheduled_at: scheduledIso, reason: reason.trim() })}
      >
        {s07.confirm}
      </Button>
    </div>
  );
}

function Mark({ state }: { state: 'ok' | 'bad' | 'info' }) {
  const icon = state === 'ok' ? Check : state === 'bad' ? X : Info;
  return (
    <span className={cx('st-check__mark', `is-${state}`)}>
      <Icon icon={icon} size={20} label={state === 'ok' ? '✓' : state === 'bad' ? '✗' : undefined} />
    </span>
  );
}

const nums = (list: number[]) =>
  list
    .filter((n) => n > 0)
    .map((n) => `#${n}`)
    .join('، ');

function Checklist({
  checklist,
  fromName,
  items,
}: {
  checklist: TransferChecklist;
  fromName: string;
  blockedByServer: boolean;
  items: CustodyBlockItem[] | null;
}) {
  const navigate = useNavigate();
  const link = (displayNumber: number) => {
    const found = items?.find((i) => i.display_number === displayNumber && i.ticket_id);
    return found?.ticket_id ? (
      <Button variant="ghost" compact onClick={() => navigate(staffPaths.ticket(found.ticket_id as string))}>
        {buttons.open}
      </Button>
    ) : null;
  };
  const yesNo = (list: number[]) => (list.length ? `${staff.yes} ${nums(list)}`.trim() : staff.no);
  return (
    <ul className="st-checklist" data-testid="transfer-checklist">
      <li className="st-check">
        <Mark state={checklist.vehicles.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.vehicles, { n: checklist.vehicles.length })}</span>
        {checklist.vehicles.map((n) => (
          <span key={`v${n}`} className="st-inline-list">
            {n > 0 ? fmt(s07.mustRelease, { n }) : null}
            {link(n)}
          </span>
        ))}
      </li>
      <li className="st-check">
        <Mark state={checklist.keys.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.keys, { n: checklist.keys.length })}</span>
        {checklist.keys.map((n) => (
          <span key={`k${n}`} className="st-inline-list">
            {n > 0 ? fmt(s07.mustRelease, { n }) : null}
            {link(n)}
          </span>
        ))}
      </li>
      <li className="st-check">
        <Mark state={checklist.movement.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.movement, { v: yesNo(checklist.movement) })}</span>
      </li>
      <li className="st-check">
        <Mark state="info" />
        <span>{fmt(s07.acceptedBeforeKey, { v: yesNo(checklist.acceptedBeforeKey) })}</span>
        <span className="st-muted">{s07.acceptedNote}</span>
      </li>
      <li className="st-check">
        <Mark state="info" />
        <span>
          {fmt(s07.nextTask, { v: checklist.nextTask.length ? nums(checklist.nextTask) : staff.no })}
        </span>
        {checklist.nextTask.length ? (
          <span className="st-muted">{fmt(s07.nextNote, { venue: fromName })}</span>
        ) : null}
      </li>
      <li className="st-check">
        <Mark state="info" />
        <span>{s07.offers}</span>
        <span className="st-muted">{s07.offersNote}</span>
      </li>
    </ul>
  );
}

function PendingTransfer({
  transfer,
  venueName,
  driverId,
}: {
  transfer: DriverTransfer;
  venueName: (id: string) => string;
  driverId: string;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useStaffCommand(
    (reason: string, key: string) => commands.cancelTransfer(transfer.id, { reason }, key),
    {
      invalidate: [staffKeys.driverAssignments(driverId), staffKeys.driver(driverId)],
      onSuccess: () => setOpen(false),
      onPermissionDenied: () => setOpen(false),
    },
  );
  return (
    <>
      <Banner
        kind="info"
        rounded
        message={fmt(s07.pending, {
          status: transferStatus[transfer.status],
          venue: venueName(transfer.to_venue_id),
          time: formatDateTime(transfer.scheduled_at),
        })}
        actionLabel={s07.cancelPending}
        onAction={() => setOpen(true)}
      />
      {open ? (
        <ReasonDialog
          open
          onOpenChange={setOpen}
          title={s07.cancelPending}
          destructive
          confirmLabel={buttons.confirm}
          pending={cancel.pending}
          error={cancel.message}
          reasonError={cancel.fields.reason}
          onConfirm={(reason) => cancel.run(reason)}
          id="transfer-cancel"
        />
      ) : null}
    </>
  );
}
