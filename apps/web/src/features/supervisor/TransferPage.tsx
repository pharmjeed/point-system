import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { queryKeys } from '@/api/queryClient';
import type { CustodyBlockItem, DriverListItem, DriverTransfer, Me, Venue } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Card,
  FieldError,
  Header,
  SegmentedControl,
  Select,
  Stepper,
  TextArea,
  TextField,
} from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { buttons, transferStatus } from '@/i18n/ar';
import { s07, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { formatDateTime, formatTime } from '@/lib/format';
import { serverNow } from '@/lib/serverClock';
import { CustodyChecklist, useCustodySnapshot } from './CustodyChecklist';
import { can } from './permissions';
import { useVenues } from './selection';
import { commands, fetchDriver, fetchDriverAssignments, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { fromBlockItems, riyadhLocalToUtcIso, utcIsoToRiyadhLocal } from './transferModel';
import { ForbiddenPage, PageSkeleton, ReadError, ReasonDialog, reasonOk, Section } from './ui';
import { useStaffCommand } from './useStaffCommand';
import './staff.css';
import { useOnline } from '@/hooks/useOnline';

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
  // S-06 «نقل إلى موقع آخر» leads here (GAP-5): back in history, else the driver's profile
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(staffPaths.driver(driverId)));
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
  const online = useOnline(); // offline only: a resync does not hold staff commands (DEC-380)
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
  const { snapshot } = useCustodySnapshot(me, driverId, fromVenueId, item.live);
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
      // S-05 / S-06 read `queryKeys.drivers` (outside ['staff']): back on S-06 the new assignment shows at once
      invalidate: [
        staffKeys.driver(driverId),
        staffKeys.driverAssignments(driverId),
        staffKeys.boards(),
        queryKeys.drivers,
      ],
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
        <CustodyChecklist checklist={checklist} fromName={fromName} />
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
      invalidate: [staffKeys.driverAssignments(driverId), staffKeys.driver(driverId), queryKeys.drivers],
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
