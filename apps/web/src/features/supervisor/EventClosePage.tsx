import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, FileExclamationPoint, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type {
  IncidentType,
  Me,
  Reconciliation,
  Settlement,
  TicketSummary,
  UserRef,
  VenueEvent,
} from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Card,
  Dialog,
  FieldError,
  Header,
  Icon,
  ListItem,
  Sheet,
  StatusChip,
  Stepper,
  TextArea,
  TextField,
} from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { buttons, eventStatus, taskStatus, taskType } from '@/i18n/ar';
import { s10, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { formatHalalas } from '@/lib/format';
import {
  cashDrivers,
  cashOutstandingHalalas,
  openBlockers,
  riyalsToHalalas,
  withBlockers,
} from './closeModel';
import { can } from './permissions';
import {
  commands,
  fetchEvent,
  fetchReconciliation,
  fetchSettlement,
  LIVE_REFETCH_MS,
  staffKeys,
} from './staffApi';
import { staffPaths } from './staffPaths';
import { IncidentDialog } from './TicketActions';
import { ForbiddenPage, PageSkeleton, ReadError, Section } from './ui';
import { useStaffCommand } from './useStaffCommand';
import './staff.css';
import { useStaffCommandsReady } from './commandReady';

/**
 * S-10 — إغلاق الحفل والمطابقة (02 §4 S-10, PNT-087, 13 §10–§12): step 1 «بدء الإغلاق» (`start-closing`), step 2
 * the reconciliation (`GET …/reconciliation` + `GET …/settlement`, refreshed every 15 s: «القوائم تتحدث مع
 * ticket.updated»), «استلام نقد» (`POST /v1/cash-handovers`), «فتح واقعة», step 3 «إغلاق الحفل» (`close`).
 * EVENT_CLOSE_BLOCKED replaces the lists with `details.blockers` and flags them.
 */
export function EventClosePage() {
  const me = useStaffMe();
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const event = useQuery({
    queryKey: staffKeys.event(eventId),
    queryFn: ({ signal }) => fetchEvent(eventId, signal),
    enabled: can(me, 'event.manage'),
  });
  if (!can(me, 'event.manage')) return <ForbiddenPage title={s10.close} backTo={paths.venues} />;
  const back = () => navigate(paths.venues);
  if (event.isPending)
    return (
      <div className="st-page">
        <Header title={s10.close} onBack={back} />
        <PageSkeleton rows={3} />
      </div>
    );
  if (!event.data)
    return (
      <div className="st-page">
        <Header title={s10.close} onBack={back} />
        <ReadError error={event.error} onRetry={() => void event.refetch()} backTo={paths.venues} />
      </div>
    );
  // back to the venue page the event card led here from (S-08, GAP-4)
  const venuePage = `${paths.venues}/${encodeURIComponent(event.data.venue_id)}`;
  return <CloseFlow me={me} event={event.data} onBack={() => navigate(venuePage)} />;
}

function CloseFlow({ me, event, onBack }: { me: Me; event: VenueEvent; onBack: () => void }) {
  const online = useStaffCommandsReady(); // online, confirmed and synced (A-SHELL-2)
  const navigate = useNavigate();
  const qc = useQueryClient();
  const closingOrDone = event.status === 'closing' || event.status === 'closed';
  const rec = useQuery({
    queryKey: staffKeys.reconciliation(event.id),
    queryFn: ({ signal }) => fetchReconciliation(event.id, signal),
    enabled: closingOrDone || event.status === 'open',
    refetchInterval: event.status === 'closed' ? false : LIVE_REFETCH_MS,
  });
  const settlement = useQuery({
    queryKey: staffKeys.settlement(event.id),
    queryFn: ({ signal }) => fetchSettlement(event.id, signal),
    enabled: can(me, 'report.read'),
    refetchInterval: event.status === 'closed' ? false : LIVE_REFETCH_MS,
  });
  const invalidate = [
    staffKeys.event(event.id),
    staffKeys.reconciliation(event.id),
    staffKeys.settlement(event.id),
  ];
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const [closedNow, setClosedNow] = useState(false);
  const start = useStaffCommand(
    (_: Record<string, never>, key: string) =>
      commands.startClosing(event.id, { expected_version: event.version }, key),
    { invalidate, onSuccess: () => setConfirmStart(false), onPermissionDenied: () => setConfirmStart(false) },
  );
  const close = useStaffCommand(
    (_: Record<string, never>, key: string) =>
      commands.closeEvent(event.id, { expected_version: event.version }, key),
    { invalidate, successMessage: null, onSuccess: () => setClosedNow(true) },
  );
  const closeBlocked = close.apiError?.code === 'EVENT_CLOSE_BLOCKED' ? close.apiError : null;
  // a refused close carries the blockers: show them at once, flagged (02 S-10)
  const recData: Reconciliation | undefined =
    rec.data && closeBlocked ? withBlockers(rec.data, closeBlocked.details) : rec.data;
  const onClose = async () => {
    const result = await close.run({});
    setConfirmClose(false);
    if (!result) {
      setFlagged(true);
      void qc.invalidateQueries({ queryKey: staffKeys.reconciliation(event.id) });
    }
  };
  const current = event.status === 'open' ? 0 : event.status === 'closing' ? (recData?.can_close ? 2 : 1) : 3;
  const blockers = recData ? openBlockers(recData.blockers) : [];

  return (
    <div className="st-page">
      <Header title={fmt(s10.title, { name: event.name_ar })} onBack={onBack} />
      <div className="st-inline-list">
        <span className="st-muted">{eventStatus[event.status]}</span>
      </div>
      <Stepper
        current={current as 0 | 1 | 2 | 3}
        steps={[{ label: s10.steps.start }, { label: s10.steps.reconcile }, { label: s10.steps.close }]}
      />
      {closedNow || event.status === 'closed' ? (
        <Banner
          kind="info"
          rounded
          message={s10.closed}
          actionLabel={s10.viewReport}
          onAction={() => navigate(staffPaths.reportsFor(event.id))}
        />
      ) : null}
      {event.status === 'open' ? (
        <Card as="section" aria-label={s10.steps.start}>
          <p className="m-0">{s10.startBody}</p>
          <Button fullWidth disabled={!online} onClick={() => setConfirmStart(true)}>
            {s10.steps.start}
          </Button>
        </Card>
      ) : null}
      {rec.isPending && rec.fetchStatus !== 'idle' ? <PageSkeleton rows={2} /> : null}
      {rec.isError && !rec.data ? <ReadError error={rec.error} onRetry={() => void rec.refetch()} /> : null}
      {recData ? (
        <Reconcile
          me={me}
          event={event}
          rec={recData}
          settlement={settlement.data ?? null}
          // «لا يمكن الإغلاق قبل حل البنود المظللة»: blockers are highlighted while closing is blocked
          flagged={flagged || (event.status === 'closing' && blockers.length > 0)}
          online={online}
        />
      ) : null}
      {event.status === 'closing' ? (
        <div className="st-section">
          {closeBlocked || (recData && !recData.can_close) ? (
            <FieldError role="alert">{closeBlocked ? closeBlocked.message_ar : s10.blockedHint}</FieldError>
          ) : null}
          {close.message && !closeBlocked ? <FieldError role="alert">{close.message}</FieldError> : null}
          <Button
            size="lg"
            loading={close.pending}
            disabled={!online || !recData || blockers.length > 0}
            onClick={() => setConfirmClose(true)}
          >
            {s10.close}
          </Button>
        </div>
      ) : null}
      <Dialog
        id="close-start"
        open={confirmStart}
        onOpenChange={setConfirmStart}
        onCancel={() => setConfirmStart(false)}
        title={s10.steps.start}
        body={s10.startBody}
        confirmLabel={buttons.confirm}
        loading={start.pending}
        error={start.message ?? undefined}
        onConfirm={() => start.run({})}
      />
      {/* 03 §4.5: «إغلاق الحفل» needs a confirmation — `closed` is final (11 §6.4, 13 §12); a refusal closes the
          dialog and shows the blockers or the message under the button */}
      <Dialog
        id="close-confirm"
        open={confirmClose}
        onOpenChange={setConfirmClose}
        onCancel={() => setConfirmClose(false)}
        title={s10.close}
        body={s10.closeConfirmBody}
        confirmLabel={s10.close}
        destructive
        loading={close.pending}
        onConfirm={() => void onClose()}
      />
    </div>
  );
}

function Mark({ bad }: { bad: boolean }) {
  return (
    <span className={cx('st-check__mark', bad ? 'is-bad' : 'is-ok')}>
      <Icon icon={bad ? X : Check} size={20} label={bad ? '✗' : '✓'} />
    </span>
  );
}

function Reconcile({
  me,
  event,
  rec,
  settlement,
  flagged,
  online,
}: {
  me: Me;
  event: VenueEvent;
  rec: Reconciliation;
  settlement: Settlement | null;
  flagged: boolean;
  online: boolean;
}) {
  const navigate = useNavigate();
  const [cashFor, setCashFor] = useState<{ driver: UserRef; expected: number } | null>(null);
  const [incidentFor, setIncidentFor] = useState<{
    type: IncidentType;
    ticket?: Pick<TicketSummary, 'id' | 'display_number' | 'venue_id' | 'event_id'>;
  } | null>(null);
  const b = rec.blockers;
  const outstanding = cashOutstandingHalalas(b);
  const flag = (bad: boolean) => cx(flagged && bad && 'pt-card st-flagged');
  const ticketRow = (t: {
    id: string;
    display_number: number;
    status: Parameters<typeof StatusChip>[0]['status'];
  }) => (
    <li key={t.id}>
      <ListItem
        title={<span className="pt-ticketno">#{t.display_number}</span>}
        trailing={<StatusChip status={t.status} size="sm" />}
        to={staffPaths.ticket(t.id)}
      />
    </li>
  );
  return (
    <>
      <Card as="section" aria-label={s10.steps.reconcile}>
        <ul className="st-checklist" data-testid="close-summary">
          <li className="st-check">
            <Mark bad={b.open_tickets.length > 0} />
            <span>{fmt(s10.openTickets, { n: b.open_tickets.length })}</span>
          </li>
          <li className="st-check">
            <Mark bad={b.open_requests.length > 0} />
            <span>{fmt(s10.pendingRequests, { n: b.open_requests.length })}</span>
          </li>
          <li className="st-check">
            <Mark bad={b.open_tasks.length > 0} />
            <span>{fmt(s10.openTasks, { n: b.open_tasks.length })}</span>
          </li>
          <li className="st-check">
            <Mark bad={b.keys_not_in_slots.length > 0} />
            <span>{fmt(s10.driverCustody, { n: b.keys_not_in_slots.length })}</span>
          </li>
          <li className="st-check">
            <Mark bad={b.unsettled_payments.length > 0} />
            <span>{fmt(s10.unsettled, { n: b.unsettled_payments.length })}</span>
          </li>
          <li className="st-check">
            <Mark bad={outstanding > 0} />
            <span>
              {fmt(s10.cashOutstanding, { amount: '' })}
              <bdi dir="ltr">{formatHalalas(outstanding)}</bdi>
            </span>
          </li>
          {b.payment_integrity.length ? (
            <li className="st-check">
              <Mark bad />
              <span>{fmt(s10.integrity, { n: b.payment_integrity.length })}</span>
            </li>
          ) : null}
        </ul>
        {!openBlockers(b).length ? <p className="st-muted m-0">{s10.allClear}</p> : null}
      </Card>

      {b.open_tickets.length ? (
        <Section title={s10.openTicketsHeading} className={flag(true)}>
          <ul className="pt-list">{b.open_tickets.map(ticketRow)}</ul>
        </Section>
      ) : null}

      {b.open_requests.length || b.open_tasks.length ? (
        <Section title={s10.requestsHeading} className={flag(true)}>
          <ul className="pt-list">
            {b.open_requests.map((q) =>
              ticketRow({
                id: q.ticket.id,
                display_number: q.ticket.display_number,
                status: q.ticket.status,
              }),
            )}
            {b.open_tasks.map((t) => (
              <li key={t.id}>
                <ListItem
                  title={`${taskType[t.type]} · ${taskStatus[t.status]}`}
                  meta={t.assignee?.full_name}
                  to={staffPaths.ticket(t.ticket_id)}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {b.keys_not_in_slots.length ? (
        <Section title={s10.custodyHeading} className={flag(true)}>
          {/* 02 S-10 «مفتاح #141 │ [نقل عهدة] [فتح]», and «فتح واقعة» (key_missing) for a key not found */}
          <ul className="pt-list">
            {b.keys_not_in_slots.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 p-3">
                <span className="font-semibold">{fmt(s10.keyOf, { n: t.display_number })}</span>
                <div className="st-row-actions">
                  {can(me, 'ticket.custody_transfer') ? (
                    <Button
                      variant="secondary"
                      compact
                      disabled={!online}
                      onClick={() => navigate(staffPaths.ticket(t.id, 'custodyTransfer'))}
                    >
                      {s10.transferCustody}
                    </Button>
                  ) : null}
                  <Button variant="ghost" compact onClick={() => navigate(staffPaths.ticket(t.id))}>
                    {buttons.open}
                  </Button>
                  {can(me, 'incident.create') ? (
                    <Button
                      variant="ghost"
                      compact
                      disabled={!online}
                      onClick={() => setIncidentFor({ type: 'key_missing', ticket: t })}
                    >
                      {s10.openIncident}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {b.unsettled_payments.length ? (
        <Section title={s10.unsettledHeading} className={flag(true)}>
          <ul className="pt-list">{b.unsettled_payments.map(ticketRow)}</ul>
        </Section>
      ) : null}

      {settlement && cashDrivers(settlement).length ? (
        <Section title={s10.cashByDriver} className={flag(outstanding > 0)}>
          <ul className="pt-list">
            {cashDrivers(settlement).map((d) => (
              <li key={d.driver.id}>
                <ListItem
                  icon={Banknote}
                  title={d.driver.full_name}
                  meta={
                    <span className="st-inline-list">
                      <span>{fmt(s10.collected, { amount: formatHalalas(d.cash.collected_halalas) })}</span>
                      <span>{fmt(s10.handed, { amount: formatHalalas(d.cash.handed_over_halalas) })}</span>
                      <span>
                        {fmt(s10.outstanding, { amount: formatHalalas(d.cash.outstanding_halalas) })}
                      </span>
                      {d.cash.difference_adjusted_halalas ? (
                        <span>
                          {fmt(s10.difference, { amount: formatHalalas(d.cash.difference_adjusted_halalas) })}
                        </span>
                      ) : null}
                    </span>
                  }
                  trailing={
                    can(me, 'cash.handover_confirm') &&
                    d.cash.outstanding_halalas > 0 &&
                    d.driver.id !== me.user.id ? (
                      <Button
                        variant="secondary"
                        compact
                        disabled={!online || event.status === 'closed'}
                        onClick={() => setCashFor({ driver: d.driver, expected: d.cash.outstanding_halalas })}
                      >
                        {s10.receiveCash}
                      </Button>
                    ) : (
                      <Mark bad={d.cash.outstanding_halalas > 0} />
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Discrepancies
        me={me}
        rec={rec}
        settlement={settlement}
        onIncident={(type) => setIncidentFor({ type })}
      />

      {cashFor ? (
        <CashHandoverSheet
          event={event}
          driver={cashFor.driver}
          expected={cashFor.expected}
          onClose={() => setCashFor(null)}
        />
      ) : null}
      {incidentFor ? (
        <IncidentDialog
          ticket={incidentFor.ticket}
          venueId={event.venue_id}
          eventId={event.id}
          presetType={incidentFor.type}
          onClose={() => setIncidentFor(null)}
        />
      ) : null}
    </>
  );
}

function Discrepancies({
  me,
  rec,
  settlement,
  onIncident,
}: {
  me: Me;
  rec: Reconciliation;
  settlement: Settlement | null;
  onIncident: (type: 'payment_discrepancy' | 'custody_mismatch' | 'key_missing') => void;
}) {
  const navigate = useNavigate();
  const diffs = rec.warnings.cash_discrepancies.filter((d) => d.difference_halalas);
  const w = rec.warnings;
  if (!diffs.length && !w.open_incidents.length && !w.failed_messages.length) return null;
  const incidentFor = (handoverId?: string) =>
    settlement?.discrepancies.find((d) => d.cash_handover_id === handoverId && d.incident_id)?.incident_id ??
    null;
  return (
    <Section title={s10.discrepancies}>
      <p className="st-muted m-0">{s10.warnings}</p>
      <ul className="pt-list">
        {diffs.map((d, i) => {
          const incidentId = incidentFor(d.cash_handover_id);
          return (
            <li key={d.cash_handover_id ?? i}>
              <ListItem
                icon={FileExclamationPoint}
                title={fmt(s10.cashDiffOf, {
                  name: d.driver?.full_name ?? staff.none,
                  amount: formatHalalas(d.difference_halalas ?? 0),
                })}
                trailing={
                  incidentId ? (
                    <Button variant="ghost" compact onClick={() => navigate(staffPaths.incident(incidentId))}>
                      {buttons.open}
                    </Button>
                  ) : can(me, 'incident.create') ? (
                    <Button variant="ghost" compact onClick={() => onIncident('payment_discrepancy')}>
                      {s10.openIncident}
                    </Button>
                  ) : undefined
                }
              />
            </li>
          );
        })}
        {w.open_incidents.length ? (
          <li>
            <ListItem
              icon={FileExclamationPoint}
              title={fmt(s10.openIncidents, { n: w.open_incidents.length })}
              to={staffPaths.incidentsFor({ event: rec.event_id })}
            />
          </li>
        ) : null}
        {w.failed_messages.length ? (
          <li>
            <ListItem
              icon={FileExclamationPoint}
              title={fmt(s10.failedMessages, { n: w.failed_messages.length })}
            />
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/** «استلام نقد» (02 S-10, 13 §10): السائق، المبلغ المتوقع (للعرض)، المبلغ المستلم، ملاحظة. */
function CashHandoverSheet({
  event,
  driver,
  expected,
  onClose,
}: {
  event: VenueEvent;
  driver: UserRef;
  expected: number;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const halalas = riyalsToHalalas(amount);
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.cashHandover>[0], key: string) => commands.cashHandover(body, key),
    {
      invalidate: [staffKeys.reconciliation(event.id), staffKeys.settlement(event.id)],
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={s10.receiveCash}>
      <div className="st-form">
        <p className="m-0">
          {staff.driver}: {driver.full_name}
        </p>
        <p className="m-0">
          {s10.expected}: <bdi dir="ltr">{formatHalalas(expected)}</bdi>
        </p>
        <TextField
          id="cash-amount"
          label={s10.received}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={amount}
          error={cmd.fields.amount_halalas}
          onChange={(e) => setAmount(e.target.value)}
        />
        {halalas != null && halalas !== expected ? (
          <p className="st-muted m-0">
            {fmt(s10.differencePreview, { amount: '' })}
            <bdi dir="ltr">{formatHalalas(halalas - expected)}</bdi>
          </p>
        ) : null}
        <TextArea
          id="cash-note"
          label={staff.note}
          rows={2}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {cmd.message && !cmd.fields.amount_halalas ? (
          <FieldError role="alert">{cmd.message}</FieldError>
        ) : null}
        <Button
          fullWidth
          loading={cmd.pending}
          disabled={halalas == null}
          onClick={() =>
            cmd.run({
              event_id: event.id,
              driver_id: driver.id,
              amount_halalas: halalas ?? 0,
              note: note.trim() || null,
            })
          }
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}
