import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  CustodyHolderType,
  CustodySubject,
  IncidentSeverity,
  IncidentType,
  Me,
  Payment,
  PaymentMethod,
  TicketDetail,
} from '@/api/types';
import {
  Banner,
  Button,
  Checkbox,
  FieldError,
  Radio,
  Select,
  Sheet,
  TextArea,
  TextField,
} from '@/components';
import {
  buttons,
  components,
  incidentSeverity,
  incidentType,
  onBehalfReason,
  paymentMethod,
} from '@/i18n/ar';
import { custodySubject, s03, s12, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { onlyDigits } from '@/lib/digits';
import { formatHalalas } from '@/lib/format';
import type { TicketAction } from './permissions';
import { commands, fetchDrivers, fetchKeyBoards, fetchParkingSpots, staffKeys } from './staffApi';
import { REASON_MIN, ReasonDialog, reasonOk } from './ui';
import { useStaffCommand } from './useStaffCommand';

/**
 * The S-03 action dialogs (02 S-03 table and the texts under it). Each one is one command with its own
 * Idempotency-Key session (useStaffCommand → useCommand); mandatory inputs are checked before sending and the
 * server's `message_ar` is shown after. Success refreshes the ticket, its timeline and the boards.
 */
export interface ActionProps {
  me: Me;
  ticket: TicketDetail;
  onClose: () => void;
}

const invalidateFor = (t: TicketDetail) => [
  staffKeys.ticket(t.id),
  staffKeys.timeline(t.id),
  staffKeys.boards(),
  staffKeys.alerts(),
];

export function TicketActionDialog({ action, ...props }: ActionProps & { action: TicketAction }) {
  switch (action) {
    case 'reassign':
      return <ReassignSheet {...props} />;
    case 'releaseCustody':
      return <ReleaseCustodyDialog {...props} />;
    case 'cancelRetrieval':
      return <CancelRetrievalDialog {...props} />;
    case 'repark':
      return <SimpleReasonDialog {...props} action="repark" />;
    case 'handoverException':
      return <HandoverExceptionSheet {...props} />;
    case 'resendCode':
      return <ResendCodeDialog {...props} />;
    case 'custodyTransfer':
      return <CustodyTransferSheet {...props} />;
    case 'onBehalf':
      return <OnBehalfDialog {...props} />;
    case 'voidTicket':
      return <VoidDialog {...props} />;
    case 'inspectionException':
      return <SimpleReasonDialog {...props} action="inspectionException" />;
    case 'waiver':
      return <SimpleReasonDialog {...props} action="waiver" />;
    case 'reverse':
      return props.ticket.payment ? <ReverseDialog {...props} payment={props.ticket.payment} /> : null;
    case 'openIncident':
      return <IncidentDialog {...props} />;
    case 'recordPayment':
      return <RecordPaymentDialog {...props} />;
    case 'revealPhone':
      return null; // handled by RevealPhone next to the masked number
    default:
      return null;
  }
}

// ---------------------------------------------------------------- reason-only commands

function SimpleReasonDialog({
  ticket,
  onClose,
  action,
}: ActionProps & { action: 'repark' | 'inspectionException' | 'waiver' }) {
  const send = (reason: string, key: string): Promise<unknown> => {
    if (action === 'repark')
      return commands.repark(ticket.id, { reason, expected_version: ticket.version }, key);
    if (action === 'inspectionException') return commands.inspectionException(ticket.id, { reason }, key);
    return commands.waivePayment(ticket.id, { reason }, key);
  };
  const cmd = useStaffCommand(send, {
    invalidate: invalidateFor(ticket),
    onSuccess: onClose,
    onPermissionDenied: onClose,
  });
  const body =
    action === 'waiver' && ticket.fee_halalas ? (
      <bdi dir="ltr">{formatHalalas(ticket.fee_halalas)}</bdi>
    ) : undefined;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action[action]}
      body={body}
      confirmLabel={buttons.confirm}
      destructive={action === 'repark'}
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
      id={`act-${action}`}
    />
  );
}

function CancelRetrievalDialog({ ticket, onClose }: ActionProps) {
  const cycleId = ticket.active_cycle?.id ?? '';
  const cmd = useStaffCommand(
    (reason: string, key: string) => commands.cancelRetrieval(cycleId, { reason }, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  const moving = ticket.status === 'retrieving' || ticket.status === 'ready';
  const driver = ticket.open_task?.assignee?.full_name ?? '';
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.cancelRetrieval}
      body={moving ? fmt(s03.cancel.afterMovement, { driver, n: ticket.display_number }) : undefined}
      confirmLabel={s03.cancel.confirm}
      destructive
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
      id="act-cancel"
    />
  );
}

function ResendCodeDialog({ ticket, onClose }: ActionProps) {
  const cmd = useStaffCommand(
    (_: Record<string, never>, key: string) => commands.resendCode(ticket.id, key),
    {
      invalidate: invalidateFor(ticket),
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.resendCode}
      withReason={false}
      confirmLabel={buttons.confirm}
      pending={cmd.pending}
      error={cmd.message}
      onConfirm={() => cmd.run({})}
      id="act-resend"
    />
  );
}

function VoidDialog({ ticket, onClose }: ActionProps) {
  const [checked, setChecked] = useState(false);
  const cmd = useStaffCommand(
    (reason: string, key: string) =>
      commands.voidTicket(
        ticket.id,
        { reason, custody_returned_to_customer: true, expected_version: ticket.version },
        key,
      ),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.voidTicket}
      confirmLabel={buttons.confirm}
      destructive
      canConfirm={checked}
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
      id="act-void"
    >
      <Checkbox
        id="act-void-custody"
        label={s03.void.custodyReturned}
        checked={checked}
        onChange={(e) => setChecked(e.target.checked)}
      />
    </ReasonDialog>
  );
}

/** Reason picked from a list (reveal phone, on-behalf request) — «أخرى» asks for the text (02 S-03). */
function useListedReason<K extends string>(labels: Record<K, string>, other: NoInfer<K>) {
  const [choice, setChoice] = useState<K | ''>('');
  const [text, setText] = useState('');
  const reason = choice === other ? text.trim() : choice ? labels[choice] : '';
  return { choice, setChoice, text, setText, reason, ok: reasonOk(reason) };
}

function OnBehalfDialog({ ticket, onClose }: ActionProps) {
  const listed = useListedReason(onBehalfReason, 'other');
  const cmd = useStaffCommand(
    (reason: string, key: string) => commands.requestOnBehalf(ticket.id, { reason }, key),
    {
      invalidate: invalidateFor(ticket),
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.onBehalf}
      withReason={false}
      canConfirm={listed.ok}
      confirmLabel={buttons.confirm}
      pending={cmd.pending}
      error={cmd.fields.reason ?? cmd.message}
      onConfirm={() => cmd.run(listed.reason)}
      id="act-onbehalf"
    >
      <Radio
        name="act-onbehalf-reason"
        legend={s03.onBehalf.legend}
        options={Object.entries(onBehalfReason) as Array<[string, string]>}
        value={listed.choice}
        onChange={(v) => listed.setChoice(v as keyof typeof onBehalfReason)}
      />
      {listed.choice === 'other' ? (
        <TextArea
          id="act-onbehalf-text"
          label={components.dialog.reason}
          rows={2}
          value={listed.text}
          onChange={(e) => listed.setText(e.target.value)}
        />
      ) : null}
    </ReasonDialog>
  );
}

// ---------------------------------------------------------------- reassign / release custody

function ReassignSheet({ me, ticket, onClose }: ActionProps) {
  const task = ticket.open_task;
  const mustPickDriver = task?.status === 'offered' || task?.status === 'broadcast';
  const [dest, setDest] = useState<'queue' | 'driver'>(mustPickDriver ? 'driver' : 'queue');
  const [driverId, setDriverId] = useState('');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const drivers = useQuery({
    queryKey: staffKeys.availableDrivers(ticket.venue_id),
    queryFn: ({ signal }) => fetchDrivers({ venue_id: ticket.venue_id, driver_state: 'available' }, signal),
    enabled: dest === 'driver',
  });
  const cmd = useStaffCommand(
    (body: { reason: string; target_driver_id: string | null; override_priority: boolean }, key: string) =>
      commands.reassignTask(task?.id ?? '', { ...body, expected_version: task?.version }, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  const olderPending = cmd.apiError?.code === 'OLDER_REQUEST_PENDING';
  const keyHolder = task?.key_picked_up_at ? (task.assignee?.full_name ?? '') : null;
  const ready = reasonOk(reason) && (dest === 'queue' || !!driverId) && !keyHolder;
  const options = (drivers.data?.items ?? [])
    .filter((d) => d.user.id !== task?.assignee?.id)
    .map((d) => [d.user.id, `${d.user.full_name} · ${d.user.employee_code}`] as const);
  if (releasing) return <ReleaseCustodyDialog me={me} ticket={ticket} onClose={() => setReleasing(false)} />;
  return (
    <Sheet
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={fmt(s03.reassign.title, { n: ticket.display_number })}
    >
      <div className="st-form">
        <Radio
          name="act-reassign-dest"
          legend={s03.reassign.destination}
          options={[
            ['queue', s03.reassign.toQueue],
            ['driver', s03.reassign.toDriver],
          ]}
          value={dest}
          onChange={(v) => setDest(v as 'queue' | 'driver')}
          disabled={mustPickDriver}
        />
        {dest === 'driver' ? (
          options.length || drivers.isPending ? (
            <Select
              id="act-reassign-driver"
              label={staff.driver}
              placeholder="—"
              value={driverId}
              options={options}
              onChange={(e) => setDriverId(e.target.value)}
              error={cmd.fields.target_driver_id}
            />
          ) : (
            <p className="st-muted">{s03.reassign.noAvailable}</p>
          )
        ) : null}
        {keyHolder !== null ? (
          <Banner
            kind="info"
            rounded
            message={fmt(s03.reassign.keyHeld, { name: keyHolder })}
            actionLabel={s03.action.releaseCustody}
            onAction={() => setReleasing(true)}
          />
        ) : null}
        <TextArea
          id="act-reassign-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          error={cmd.fields.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {olderPending || override ? (
          <Checkbox
            id="act-reassign-override"
            label={s03.reassign.overridePriority}
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
        ) : null}
        {cmd.message && !cmd.fields.reason ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button
          fullWidth
          loading={cmd.pending}
          disabled={!ready}
          onClick={() =>
            cmd.run({
              reason: reason.trim(),
              target_driver_id: dest === 'driver' ? driverId : null,
              override_priority: dest === 'driver' && override,
            })
          }
        >
          {s03.reassign.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

function ReleaseCustodyDialog({ ticket, onClose }: ActionProps) {
  const task = ticket.open_task;
  const [slotId, setSlotId] = useState('');
  const boards = useQuery({
    queryKey: staffKeys.keyBoards(ticket.venue_id),
    queryFn: ({ signal }) => fetchKeyBoards(ticket.venue_id, signal),
  });
  const slots = (boards.data ?? []).flatMap((b) =>
    b.slots
      .filter((s) => s.status === 'active' && !s.occupied)
      .map((s) => [s.id, `${b.board.name} · ${s.label}`] as const),
  );
  const cmd = useStaffCommand(
    (body: { key_slot_id: string; reason: string }, key: string) =>
      commands.releaseCustody(task?.id ?? '', body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.releaseCustody}
      canConfirm={!!slotId}
      confirmLabel={s03.action.releaseCustody}
      pending={cmd.pending}
      error={cmd.fields.key_slot_id ? undefined : cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run({ key_slot_id: slotId, reason })}
      id="act-release"
    >
      <Select
        id="act-release-slot"
        label={s03.release.slot}
        placeholder="—"
        value={slotId}
        options={slots}
        error={
          cmd.fields.key_slot_id ?? (cmd.apiError?.code === 'KEY_SLOT_OCCUPIED' ? cmd.message : undefined)
        }
        onChange={(e) => setSlotId(e.target.value)}
      />
    </ReasonDialog>
  );
}

// ---------------------------------------------------------------- handover exception (07: identity_checks)

function HandoverExceptionSheet({ me, ticket, onClose }: ActionProps) {
  const [usePhone, setUsePhone] = useState(false);
  const [last4, setLast4] = useState('');
  const [useDoc, setUseDoc] = useState(false);
  const [docNote, setDocNote] = useState('');
  const [useContents, setUseContents] = useState(false);
  const [reason, setReason] = useState('');
  const due = ticket.payment_status === 'due';
  const methods: PaymentMethod[] = ['cash', 'pos'];
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [pos, setPos] = useState('');
  const assignee = ticket.open_task?.assignee ?? null;
  const [collector, setCollector] = useState<string>(assignee?.id ?? me.user.id);
  const checks = [usePhone && last4.length === 4, useDoc && docNote.trim().length > 0, useContents].filter(
    Boolean,
  ).length;
  const ready = checks >= 2 && reasonOk(reason) && (!due || !!method);
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.handoverException>[1], key: string) =>
      commands.handoverException(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  const submit = () =>
    cmd.run({
      reason: reason.trim(),
      identity_checks: {
        ...(usePhone ? { phone_last4: last4 } : {}),
        ...(useDoc ? { document_note: docNote.trim() } : {}),
        ...(useContents ? { vehicle_description_confirmed: true } : {}),
      },
      payment: due
        ? {
            method: method as PaymentMethod,
            amount_halalas: ticket.fee_halalas ?? 0,
            pos_reference: method === 'pos' && pos.trim() ? pos.trim() : null,
            collected_by: collector,
          }
        : null,
      expected_version: ticket.version,
    });
  const collectors: Array<readonly [string, string]> = [
    ...(assignee && assignee.id !== me.user.id ? [[assignee.id, assignee.full_name] as const] : []),
    [me.user.id, `${me.user.full_name} (${staff.me})`] as const,
  ];
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={s03.exception.title}>
      <div className="st-form">
        <p className="st-muted">{s03.exception.minTwo}</p>
        <Checkbox
          id="act-exc-phone"
          label={s03.exception.phoneLast4}
          checked={usePhone}
          onChange={(e) => setUsePhone(e.target.checked)}
        />
        {usePhone ? (
          <TextField
            id="act-exc-last4"
            label={s03.exception.last4}
            inputMode="numeric"
            dir="ltr"
            maxLength={4}
            autoComplete="off"
            value={last4}
            error={cmd.fields['identity_checks.phone_last4']}
            onChange={(e) => setLast4(onlyDigits(e.target.value).slice(0, 4))}
          />
        ) : null}
        <Checkbox
          id="act-exc-doc"
          label={s03.exception.document}
          checked={useDoc}
          onChange={(e) => setUseDoc(e.target.checked)}
        />
        {useDoc ? (
          <TextField
            id="act-exc-docnote"
            label={s03.exception.documentNote}
            hint={s03.exception.documentHint}
            maxLength={200}
            value={docNote}
            onChange={(e) => setDocNote(e.target.value)}
          />
        ) : null}
        <Checkbox
          id="act-exc-contents"
          label={s03.exception.contents}
          checked={useContents}
          onChange={(e) => setUseContents(e.target.checked)}
        />
        {cmd.fields.identity_checks ? (
          <FieldError role="alert">{cmd.fields.identity_checks}</FieldError>
        ) : null}
        {due ? (
          <fieldset className="st-form st-fieldset">
            <legend className="pt-section-title">{s03.exception.paymentSection}</legend>
            <p className="m-0">
              {staff.amount}: <bdi dir="ltr">{formatHalalas(ticket.fee_halalas ?? 0)}</bdi>
            </p>
            <Select
              id="act-exc-method"
              label={staff.method}
              placeholder="—"
              value={method}
              options={methods.map((m) => [m, paymentMethod[m]] as const)}
              error={cmd.fields['payment.method']}
              onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}
            />
            {method === 'pos' ? (
              <TextField
                id="act-exc-pos"
                label={s03.exception.posReference}
                hint={s03.exception.posHint}
                dir="ltr"
                maxLength={40}
                autoComplete="off"
                value={pos}
                error={cmd.fields['payment.pos_reference']}
                onChange={(e) => setPos(e.target.value)}
              />
            ) : null}
            <Select
              id="act-exc-collector"
              label={s03.exception.collectedBy}
              value={collector}
              options={collectors}
              onChange={(e) => setCollector(e.target.value)}
            />
          </fieldset>
        ) : null}
        <TextArea
          id="act-exc-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          error={cmd.fields.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {cmd.message && !cmd.fields.reason ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button variant="success" fullWidth loading={cmd.pending} disabled={!ready} onClick={submit}>
          {s03.exception.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- official custody transfer

function CustodyTransferSheet({ me, ticket, onClose }: ActionProps) {
  const [subject, setSubject] = useState<CustodySubject>('key');
  const [holderType, setHolderType] = useState<CustodyHolderType | ''>('');
  const [holderId, setHolderId] = useState('');
  const [reason, setReason] = useState('');
  const drivers = useQuery({
    queryKey: staffKeys.venueDrivers(ticket.venue_id),
    queryFn: ({ signal }) => fetchDrivers({ venue_id: ticket.venue_id }, signal),
    enabled: holderType === 'driver',
  });
  const keyBoards = useQuery({
    queryKey: staffKeys.keyBoards(ticket.venue_id),
    queryFn: ({ signal }) => fetchKeyBoards(ticket.venue_id, signal),
    enabled: holderType === 'key_slot',
  });
  const spots = useQuery({
    queryKey: staffKeys.parkingSpots(ticket.venue_id),
    queryFn: ({ signal }) => fetchParkingSpots(ticket.venue_id, signal),
    enabled: holderType === 'spot',
  });
  const holderTypes: CustodyHolderType[] =
    subject === 'key' ? ['driver', 'supervisor', 'key_slot'] : ['driver', 'supervisor', 'spot'];
  const targetOptions: Array<readonly [string, string]> =
    holderType === 'driver'
      ? (drivers.data?.items ?? [])
          .filter((d) => d.live && d.live.driver_state !== 'off_duty')
          .map((d) => [d.user.id, `${d.user.full_name} · ${d.user.employee_code}`] as const)
      : holderType === 'key_slot'
        ? (keyBoards.data ?? []).flatMap((b) =>
            b.slots
              .filter((s) => s.status === 'active' && !s.occupied)
              .map((s) => [s.id, `${b.board.name} · ${s.label}`] as const),
          )
        : holderType === 'spot'
          ? (spots.data?.items ?? []).map(
              (s) => [s.id, s.zone_name ? `${s.zone_name} · ${s.label}` : s.label] as const,
            )
          : [];
  const resolvedHolderId = holderType === 'supervisor' ? me.user.id : holderId;
  const ready = !!holderType && !!resolvedHolderId && reasonOk(reason);
  const cmd = useStaffCommand(
    (
      body: {
        subject: CustodySubject;
        to_holder_type: CustodyHolderType;
        to_holder_id: string | null;
        reason: string;
      },
      key: string,
    ) => commands.custodyTransfer(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={s03.action.custodyTransfer}>
      <div className="st-form">
        <Radio
          name="act-custody-subject"
          legend={s03.transfer.subject}
          options={[
            ['key', custodySubject.key],
            ['vehicle', custodySubject.vehicle],
          ]}
          value={subject}
          onChange={(v) => {
            setSubject(v as CustodySubject);
            setHolderType('');
            setHolderId('');
          }}
        />
        <Radio
          name="act-custody-holder"
          legend={s03.transfer.holder}
          options={holderTypes.map(
            (h) => [h, s03.transfer.holderType[h as keyof typeof s03.transfer.holderType]] as const,
          )}
          value={holderType}
          onChange={(v) => {
            setHolderType(v as CustodyHolderType);
            setHolderId('');
          }}
        />
        {holderType && holderType !== 'supervisor' ? (
          <Select
            id="act-custody-target"
            label={s03.transfer.target}
            placeholder="—"
            value={holderId}
            options={targetOptions}
            error={cmd.fields.to_holder_id}
            onChange={(e) => setHolderId(e.target.value)}
          />
        ) : null}
        <TextArea
          id="act-custody-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          error={cmd.fields.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {cmd.message && !cmd.fields.reason ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button
          fullWidth
          loading={cmd.pending}
          disabled={!ready}
          onClick={() =>
            cmd.run({
              subject,
              to_holder_type: holderType as CustodyHolderType,
              to_holder_id: resolvedHolderId,
              reason: reason.trim(),
            })
          }
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- payments (13 §5–§7)

function ReverseDialog({ ticket, payment, onClose }: ActionProps & { payment: Payment }) {
  const [withReplacement, setWithReplacement] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>(payment.method === 'cash' ? 'pos' : 'cash');
  const [pos, setPos] = useState('');
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.reversePayment>[1], key: string) =>
      commands.reversePayment(payment.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.reverse}
      body={s03.reverse.warning}
      confirmLabel={buttons.confirm}
      destructive
      pending={cmd.pending}
      error={cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) =>
        cmd.run({
          reason,
          replacement: withReplacement
            ? {
                method,
                amount_halalas: payment.amount_halalas,
                pos_reference: method === 'pos' && pos.trim() ? pos.trim() : null,
              }
            : null,
        })
      }
      id="act-reverse"
    >
      <p className="m-0">
        {paymentMethod[payment.method]} · <bdi dir="ltr">{formatHalalas(payment.amount_halalas)}</bdi>
      </p>
      <Checkbox
        id="act-reverse-replacement"
        label={s03.reverse.withReplacement}
        checked={withReplacement}
        onChange={(e) => setWithReplacement(e.target.checked)}
      />
      {withReplacement ? (
        <>
          <Select
            id="act-reverse-method"
            label={staff.method}
            value={method}
            options={(['cash', 'pos'] as const).map((m) => [m, paymentMethod[m]] as const)}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          />
          {method === 'pos' ? (
            <TextField
              id="act-reverse-pos"
              label={s03.exception.posReference}
              hint={s03.exception.posHint}
              dir="ltr"
              maxLength={40}
              autoComplete="off"
              value={pos}
              error={cmd.fields['replacement.pos_reference']}
              onChange={(e) => setPos(e.target.value)}
            />
          ) : null}
        </>
      ) : null}
    </ReasonDialog>
  );
}

function RecordPaymentDialog({ ticket, onClose }: ActionProps) {
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [pos, setPos] = useState('');
  const cmd = useStaffCommand(
    (body: { method: PaymentMethod; amount_halalas: number; pos_reference?: string | null }, key: string) =>
      commands.recordPayment(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.recordPayment}
      body={<bdi dir="ltr">{formatHalalas(ticket.fee_halalas ?? 0)}</bdi>}
      withReason={false}
      canConfirm={!!method}
      confirmLabel={buttons.confirm}
      pending={cmd.pending}
      error={cmd.message}
      onConfirm={() =>
        cmd.run({
          method: method as PaymentMethod,
          amount_halalas: ticket.fee_halalas ?? 0,
          pos_reference: method === 'pos' && pos.trim() ? pos.trim() : null,
        })
      }
      id="act-record"
    >
      <Select
        id="act-record-method"
        label={staff.method}
        placeholder="—"
        value={method}
        options={(['cash', 'pos'] as const).map((m) => [m, paymentMethod[m]] as const)}
        error={cmd.fields.method}
        onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}
      />
      {method === 'pos' ? (
        <TextField
          id="act-record-pos"
          label={s03.exception.posReference}
          hint={s03.exception.posHint}
          dir="ltr"
          maxLength={40}
          autoComplete="off"
          value={pos}
          error={cmd.fields.pos_reference}
          onChange={(e) => setPos(e.target.value)}
        />
      ) : null}
    </ReasonDialog>
  );
}

// ---------------------------------------------------------------- incidents (S-12 create from S-03)

export function IncidentDialog({
  ticket,
  onClose,
  venueId,
  eventId,
  presetType,
  onCreated,
}: {
  ticket?: TicketDetail | null;
  onClose: () => void;
  venueId?: string;
  eventId?: string | null;
  presetType?: IncidentType;
  onCreated?: (id: string) => void;
  me?: Me;
}) {
  const [type, setType] = useState<IncidentType | ''>(presetType ?? '');
  const [severity, setSeverity] = useState<IncidentSeverity>('medium');
  const [description, setDescription] = useState('');
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.createIncident>[0], key: string) => commands.createIncident(body, key),
    {
      invalidate: [staffKeys.incidents(), ...(ticket ? [staffKeys.timeline(ticket.id)] : [])],
      onSuccess: (incident) => {
        onCreated?.(incident.id);
        onClose();
      },
      onPermissionDenied: onClose,
    },
  );
  const venue = ticket?.venue_id ?? venueId ?? '';
  const ready = !!type && description.trim().length >= REASON_MIN && !!venue;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.incident.title}
      body={ticket ? `#${ticket.display_number}` : undefined}
      withReason={false}
      canConfirm={ready}
      confirmLabel={buttons.confirm}
      pending={cmd.pending}
      error={cmd.fields.description ? undefined : cmd.message}
      onConfirm={() =>
        cmd.run({
          venue_id: venue,
          event_id: ticket?.event_id ?? eventId ?? null,
          ticket_id: ticket?.id ?? null,
          type: type as IncidentType,
          severity,
          description: description.trim(),
        })
      }
      id="act-incident"
    >
      <Select
        id="act-incident-type"
        label={staff.type}
        placeholder="—"
        value={type}
        options={(Object.keys(incidentType) as IncidentType[]).map((t) => [t, incidentType[t]] as const)}
        error={cmd.fields.type}
        onChange={(e) => setType(e.target.value as IncidentType | '')}
      />
      <Radio
        name="act-incident-severity"
        legend={staff.severity}
        options={(Object.keys(incidentSeverity) as IncidentSeverity[]).map(
          (s) => [s, incidentSeverity[s]] as const,
        )}
        value={severity}
        onChange={(v) => setSeverity(v as IncidentSeverity)}
      />
      <TextArea
        id="act-incident-description"
        label={s12.description}
        rows={3}
        maxLength={2000}
        value={description}
        error={cmd.fields.description}
        hint={description.trim().length < REASON_MIN ? s12.descriptionRequired : undefined}
        onChange={(e) => setDescription(e.target.value)}
      />
    </ReasonDialog>
  );
}
