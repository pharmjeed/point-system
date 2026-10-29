import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, KeyRound, LogOut, MapPin, Pencil, UserCheck, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  assignDriver,
  disableDriver,
  enableDriver,
  getDriver,
  listDriverAssignments,
  patchDriver,
  resetDriverSecret,
} from '@/api/drivers';
import { ApiError, displayMessage } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import { listVenues } from '@/api/setup';
import type { CustodyBlockItem, CustodyItem, DriverAssignment, DriverListItem, Me, Venue } from '@/api/types';
import { paths } from '@/app/paths';
import { can } from '@/app/permissions';
import {
  Button,
  Card,
  ConnectionIndicator,
  Dialog,
  DriverStateChip,
  FieldError,
  Header,
  MaskedPhone,
  PhoneInput,
  Select,
  TextArea,
  TextField,
} from '@/components';
import { FormSheet } from '@/features/common/FormSheet';
import { fieldError, NO_ERRORS, toFormErrors, type FormErrors } from '@/features/common/formErrors';
import { QueryView } from '@/features/common/QueryView';
import { UserStatusChip } from '@/features/common/StateChip';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { CustodyChecklist, ticketNumbers, useCustodySnapshot } from '@/features/supervisor/CustodyChecklist';
import { can as canStaff } from '@/features/supervisor/permissions';
import { commands, staffKeys } from '@/features/supervisor/staffApi';
import { staffPaths } from '@/features/supervisor/staffPaths';
import { fromBlockItems, type TransferChecklist } from '@/features/supervisor/transferModel';
import { ReasonDialog } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useCommand } from '@/hooks/useCommand';
import { ui } from '@/i18n/ar';
import { s05, s06 } from '@/i18n/ar.staff';
import { errorMessagesAr } from '@/i18n/errors';
import { fmt } from '@/i18n/fmt';
import { formatDate, formatDateTime } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { useUiStore } from '@/stores/ui';
import { TempSecretDialog } from './TempSecretDialog';

/**
 * S-06 — driver profile (`/drivers/:driverId`): card, current duty, assignment history, and the actions of the
 * 02 S-06 table: «نقل إلى موقع آخر» → S-07 (`driver.transfer`, GAP-5), «تعيين على موقع» (`driver.assign`), the
 * account actions (`driver.manage`) and «إنهاء المناوبة قسرًا» (`duty.force_end`, the supervisor's alone, GAP-6).
 * The confirmations of «تعطيل الحساب» and «إنهاء المناوبة قسرًا» show the custody snapshot (DEC-32).
 */
export function DriverProfilePage() {
  const { driverId = '' } = useParams();
  const me = useStaffMe();
  const navigate = useNavigate();
  const driver = useQuery({
    queryKey: queryKeys.driver(driverId),
    queryFn: ({ signal }) => getDriver(driverId, signal),
  });
  return (
    <section className="flex flex-col gap-3" aria-labelledby="driver-title">
      <QueryView query={driver} backTo={paths.drivers}>
        {(d) => (
          <>
            <Header title={d.user.full_name} onBack={() => navigate(paths.drivers)} />
            <span className="pt-sr" id="driver-title">
              {d.user.full_name}
            </span>
            <Profile me={me} driver={d} />
          </>
        )}
      </QueryView>
    </section>
  );
}

function Profile({ me, driver }: { me: Me; driver: DriverListItem }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const user = driver.user;
  const history = useQuery({
    queryKey: queryKeys.driverAssignments(user.id),
    queryFn: ({ signal }) => listDriverAssignments(user.id, signal),
  });
  const venues = useQuery({
    queryKey: queryKeys.venues,
    queryFn: ({ signal }) => listVenues(signal),
    enabled: can(me, 'driver.assign'),
  });
  const [sheet, setSheet] = useState<'assign' | 'edit' | null>(null);
  const [disabling, setDisabling] = useState(false);
  /** the duty session «إنهاء المناوبة قسرًا» was opened for (kept while its Dialog is open) */
  const [forceEnding, setForceEnding] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const manage = can(me, 'driver.manage');
  const active = user.status === 'active';

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.drivers });
  };
  const enable = useCommand((_: Record<string, never>, key: string) => enableDriver(user.id, key));
  const reset = useCommand((_: Record<string, never>, key: string) => resetDriverSecret(user.id, key));

  const onEnable = async () => {
    try {
      await enable.run({});
      pushToast({ message: ui.saved, tone: 'success' });
    } catch {
      // shown under the actions
    } finally {
      void refresh();
    }
  };
  // 03 §4.5 (DEC-344): the reset ends the driver's sessions, so it runs only after the confirmation Dialog
  const onReset = async () => {
    try {
      const result = await reset.run({});
      setResetting(false);
      setSecret(result.temporary_secret);
    } catch {
      // shown in the confirmation Dialog
    }
  };

  const live = driver.live;
  const onDuty = !!live && live.driver_state !== 'off_duty';
  const dutySessionId = onDuty ? (live?.duty_session_id ?? null) : null;
  const actionError = enable.error;
  return (
    <>
      <Card className="pt-record">
        <dl className="pt-kv">
          <dt>{s06.status}</dt>
          <dd>
            <UserStatusChip status={user.status} />
          </dd>
          <dt>{s06.employeeCode}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {user.employee_code}
            </bdi>
          </dd>
          <dt>{s06.phone}</dt>
          <dd>
            {user.phone_e164 ? (
              <bdi dir="ltr" className="pt-num">
                {user.phone_e164}
              </bdi>
            ) : user.phone_masked ? (
              <MaskedPhone phone={user.phone_masked} />
            ) : (
              '—'
            )}
          </dd>
          <dt>{s06.current}</dt>
          <dd>{driver.active_assignment?.venue_name_ar ?? s05.none}</dd>
        </dl>
      </Card>

      <h2 className="pt-section-title">{s06.duty}</h2>
      <Card className="pt-record">
        {onDuty && live ? (
          <dl className="pt-kv">
            <dt>{s06.status}</dt>
            <dd>
              <DriverStateChip state={live.driver_state} />
            </dd>
            {live.duty_started_at ? (
              <>
                <dt>{s06.dutyStart}</dt>
                <dd>{formatDateTime(live.duty_started_at)}</dd>
              </>
            ) : null}
            <dt>{s06.connection}</dt>
            <dd>
              <ConnectionIndicator state={live.connection_state ?? 'offline'} />
            </dd>
          </dl>
        ) : (
          <p className="pt-record__meta">{s06.noDuty}</p>
        )}
      </Card>

      <div className="pt-record__actions">
        {can(me, 'driver.transfer') && active && driver.active_assignment ? (
          <Button compact iconStart={ArrowLeftRight} onClick={() => navigate(staffPaths.transfer(user.id))}>
            {s06.transfer}
          </Button>
        ) : null}
        {can(me, 'driver.assign') && active && !driver.active_assignment ? (
          <Button compact iconStart={MapPin} onClick={() => setSheet('assign')}>
            {s06.assign}
          </Button>
        ) : null}
        {manage ? (
          <Button compact variant="secondary" iconStart={Pencil} onClick={() => setSheet('edit')}>
            {s06.edit}
          </Button>
        ) : null}
        {manage && active ? (
          <Button compact variant="secondary" iconStart={KeyRound} onClick={() => setResetting(true)}>
            {s06.resetSecret}
          </Button>
        ) : null}
        {manage && active ? (
          <Button compact variant="ghost" iconStart={UserX} onClick={() => setDisabling(true)}>
            {s06.disable}
          </Button>
        ) : null}
        {manage && !active ? (
          <Button compact iconStart={UserCheck} loading={enable.pending} onClick={onEnable}>
            {s06.enable}
          </Button>
        ) : null}
        {canStaff(me, 'duty.force_end') && dutySessionId ? (
          <Button compact variant="ghost" iconStart={LogOut} onClick={() => setForceEnding(dutySessionId)}>
            {s06.forceEnd}
          </Button>
        ) : null}
      </div>
      {actionError ? <FieldError role="alert">{displayMessage(actionError)}</FieldError> : null}

      <h2 className="pt-section-title">{s06.history}</h2>
      <QueryView query={history}>{(h) => <AssignmentHistory items={h.assignments} />}</QueryView>

      {can(me, 'driver.assign') ? (
        <AssignSheet
          open={sheet === 'assign'}
          onOpenChange={(o) => setSheet(o ? 'assign' : null)}
          driverId={user.id}
          venues={venues.data ?? []}
        />
      ) : null}
      {manage ? (
        <EditDriverSheet
          open={sheet === 'edit'}
          onOpenChange={(o) => setSheet(o ? 'edit' : null)}
          driver={driver}
        />
      ) : null}
      {manage && disabling ? (
        <DisableDialog me={me} driver={driver} onClose={() => setDisabling(false)} />
      ) : null}
      {forceEnding ? (
        <ForceEndDialog
          me={me}
          driver={driver}
          sessionId={forceEnding}
          onClose={() => setForceEnding(null)}
        />
      ) : null}
      {manage && active ? (
        <Dialog
          id="reset-secret"
          open={resetting}
          onOpenChange={setResetting}
          title={s06.resetSecret}
          body={fmt(s06.resetConfirm, { name: user.full_name })}
          destructive
          confirmLabel={s06.resetSecret}
          loading={reset.pending}
          error={reset.error ? displayMessage(reset.error) : undefined}
          onConfirm={onReset}
          onCancel={() => {
            reset.reset();
            setResetting(false);
          }}
        />
      ) : null}
      <TempSecretDialog name={user.full_name} secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

function AssignmentHistory({ items }: { items: DriverAssignment[] }) {
  if (!items.length) return <p className="pt-record__meta">{s06.noHistory}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={s06.history}>
      {[...items]
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
        .map((a) => (
          <li key={a.id}>
            <Card className="pt-record">
              <span className="font-semibold">{a.venue_name_ar ?? '—'}</span>
              <dl className="pt-kv">
                <dt>{s06.from}</dt>
                <dd>{formatDate(a.starts_at)}</dd>
                <dt>{s06.to}</dt>
                <dd>{a.ends_at ? formatDate(a.ends_at) : '—'}</dd>
                {a.reason ? (
                  <>
                    <dt>{s06.reason}</dt>
                    <dd>{a.reason}</dd>
                  </>
                ) : null}
              </dl>
            </Card>
          </li>
        ))}
    </ul>
  );
}

/** «تعيين على موقع» for a driver without an active assignment (`POST /v1/drivers/{driverId}/assignments`). */
function AssignSheet({
  open,
  onOpenChange,
  driverId,
  venues,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverId: string;
  venues: Venue[];
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const [venue, setVenue] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setVenue('');
      setReason('');
      setErrors(NO_ERRORS);
    }
  }, [open]);
  const assign = useCommand((body: { venue_id: string; reason: string | null }, key: string) =>
    assignDriver(driverId, body, key),
  );
  const submit = async () => {
    if (!venue) {
      setErrors({ form: null, requestId: null, fields: { venue_id: ui.validation } });
      return;
    }
    setErrors(NO_ERRORS);
    try {
      await assign.run({ venue_id: venue, reason: reason.trim() || null });
      pushToast({ message: ui.saved, tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error));
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.drivers });
    }
  };
  return (
    <FormSheet
      id="assign-form"
      open={open}
      onOpenChange={onOpenChange}
      title={s06.assign}
      submitLabel={s06.assign}
      onSubmit={submit}
      pending={assign.pending}
      errors={errors}
    >
      <Select
        id="assign-venue"
        label={s06.venue}
        value={venue}
        placeholder="—"
        options={venues.filter((v) => v.status === 'active').map((v) => [v.id, v.name_ar] as const)}
        error={fieldError(errors, 'venue_id')}
        onChange={(e) => setVenue(e.target.value)}
      />
      <TextArea
        id="assign-reason"
        label={s06.assignReason}
        rows={2}
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
      />
    </FormSheet>
  );
}

/** «تعديل البيانات» (`PATCH /v1/drivers/{driverId}` with `expected_version`). */
function EditDriverSheet({
  open,
  onOpenChange,
  driver,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: DriverListItem;
}) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const user = driver.user;
  const [form, setForm] = useState({ full_name: '', phone: '', employee_code: '' });
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  useEffect(() => {
    if (open) {
      setForm({ full_name: user.full_name, phone: user.phone_e164 ?? '', employee_code: user.employee_code });
      setErrors(NO_ERRORS);
    }
  }, [open]); // deliberately not on the user record
  const patch = useCommand((body: Parameters<typeof patchDriver>[1], key: string) =>
    patchDriver(user.id, body, key),
  );
  const submit = async () => {
    const local: Record<string, string> = {};
    if (!form.full_name.trim()) local.full_name = ui.validation;
    const phone = form.phone.trim() ? normalizeSaudiMobile(form.phone) : null;
    if (form.phone.trim() && !phone) local.phone = errorMessagesAr.PHONE_INVALID;
    if (Object.keys(local).length) {
      setErrors({ form: null, requestId: null, fields: local });
      return;
    }
    setErrors(NO_ERRORS);
    const body: Parameters<typeof patchDriver>[1] = { expected_version: user.version };
    if (form.full_name.trim() !== user.full_name) body.full_name = form.full_name.trim();
    if (phone && phone !== user.phone_e164) body.phone = phone;
    if (form.employee_code.trim() && form.employee_code.trim() !== user.employee_code)
      body.employee_code = form.employee_code.trim();
    try {
      await patch.run(body);
      pushToast({ message: ui.saved, tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      setErrors(toFormErrors(error, { PHONE_INVALID: 'phone' }));
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.drivers });
    }
  };
  return (
    <FormSheet
      id="edit-driver-form"
      open={open}
      onOpenChange={onOpenChange}
      title={s06.edit}
      submitLabel={s06.edit}
      onSubmit={submit}
      pending={patch.pending}
      errors={errors}
    >
      <TextField
        id="edit-driver-name"
        label={s05.fullName}
        value={form.full_name}
        maxLength={80}
        error={fieldError(errors, 'full_name')}
        onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
      />
      <PhoneInput
        id="edit-driver-phone"
        label={s05.phone}
        value={form.phone}
        error={fieldError(errors, 'phone')}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
      />
      <TextField
        id="edit-driver-code"
        label={s05.employeeCode}
        value={form.employee_code}
        dir="ltr"
        maxLength={20}
        error={fieldError(errors, 'employee_code')}
        onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
      />
    </FormSheet>
  );
}

/** «مفتاح #125، مركبة #125» — the items of `details.items` (08 §4) as one line. */
function itemsText(items: readonly CustodyItem[]): string {
  return items
    .map((i) => {
      const label = (s06.itemType as Record<string, string>)[i.type] ?? i.type;
      return i.display_number ? `${label} #${i.display_number}` : label;
    })
    .join('، ');
}

/** `details.items` of a custody refusal (CUSTODY_OPEN, DUTY_END_BLOCKED_CUSTODY), or null. */
function custodyRefusal(error: unknown, code: string): CustodyItem[] | null {
  return error instanceof ApiError && error.code === code && Array.isArray(error.details.items)
    ? (error.details.items as CustodyItem[])
    : null;
}

/**
 * The DEC-32 part of both confirmations (02 S-06): from the snapshot, what blocks the action (a vehicle or a key
 * held, a movement in progress, an active park/repark) with «فتح» on each item to transfer it officially first, and
 * what happens automatically. The server's `details.items` replace the snapshot; the server stays the judge
 * (the confirm stays enabled: a stale snapshot never blocks a valid command, a refusal lists the items).
 */
function CustodyPreview({ checklist, known }: { checklist: TransferChecklist; known: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {known ? <CustodyChecklist checklist={checklist} scope="blocking" testId="custody-checklist" /> : null}
      <p className="pt-record__meta m-0">
        {fmt(s06.autoRelease, { next: ticketNumbers(checklist.nextTask) }).replace(/\s{2,}/g, ' ')}
      </p>
    </div>
  );
}

/**
 * «تعطيل الحساب» with a mandatory reason (02 S-06, DEC-32). `CUSTODY_OPEN` lists what the driver holds
 * (`details.items`) in place of the snapshot, with the S-06 text; the server decides, there is no override.
 */
function DisableDialog({ me, driver, onClose }: { me: Me; driver: DriverListItem; onClose: () => void }) {
  const qc = useQueryClient();
  const pushToast = useUiStore((s) => s.pushToast);
  const user = driver.user;
  const { snapshot, known } = useCustodySnapshot(
    me,
    user.id,
    driver.active_assignment?.venue_id ?? null,
    driver.live,
  );
  const [reason, setReason] = useState('');
  /** under the reason field: the local check and the server's REASON_REQUIRED */
  const [reasonError, setReasonError] = useState<string | null>(null);
  /** under the list: the refusal (CUSTODY_OPEN with its items, or the server's text) */
  const [failure, setFailure] = useState<{ message: string; items: CustodyItem[] } | null>(null);
  const disable = useCommand((body: { reason: string }, key: string) => disableDriver(user.id, body, key));
  const confirm = async () => {
    if (reason.trim().length < 3) {
      setReasonError(ui.reasonRequired);
      return;
    }
    setReasonError(null);
    setFailure(null);
    try {
      await disable.run({ reason: reason.trim() });
      pushToast({ message: ui.saved, tone: 'success' });
      onClose();
    } catch (e) {
      const items = custodyRefusal(e, 'CUSTODY_OPEN');
      if (e instanceof ApiError && e.code === 'REASON_REQUIRED') setReasonError(e.message_ar);
      else
        setFailure(
          items?.length
            ? { message: fmt(s06.custodyOpen, { items: itemsText(items) }), items }
            : { message: displayMessage(e), items: [] },
        );
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.drivers });
      void qc.invalidateQueries({ queryKey: staffKeys.boards() });
    }
  };
  const checklist = failure?.items.length
    ? fromBlockItems(failure.items as CustodyBlockItem[], snapshot)
    : snapshot;
  return (
    <Dialog
      id="disable-driver"
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s06.disable}
      body={user.full_name}
      reasonRequired
      reason={reason}
      onReasonChange={setReason}
      destructive
      confirmLabel={s06.disable}
      loading={disable.pending}
      error={reasonError ?? undefined}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <CustodyPreview checklist={checklist} known={known || !!failure?.items.length} />
      {failure ? <FieldError role="alert">{failure.message}</FieldError> : null}
    </Dialog>
  );
}

/**
 * «إنهاء المناوبة قسرًا» (02 S-06; `POST /v1/duty-sessions/{sessionId}/force-end`, `duty.force_end` is the
 * supervisor's alone; 10 §9.5): mandatory reason and the DEC-32 snapshot; DUTY_END_BLOCKED_CUSTODY lists
 * `details.items` with the S-06 text. The reserved next task and a retrieval accepted before the key pickup go
 * back to the queue with their priority and the single offers are withdrawn (server side).
 */
function ForceEndDialog({
  me,
  driver,
  sessionId,
  onClose,
}: {
  me: Me;
  driver: DriverListItem;
  sessionId: string;
  onClose: () => void;
}) {
  const user = driver.user;
  const { snapshot, known } = useCustodySnapshot(
    me,
    user.id,
    driver.active_assignment?.venue_id ?? null,
    driver.live,
  );
  const cmd = useStaffCommand(
    (reason: string, key: string) => commands.forceEndDuty(sessionId, { reason }, key),
    {
      invalidate: [queryKeys.drivers, staffKeys.driver(user.id), ['staff', 'drivers'], staffKeys.boards()],
      onSuccess: onClose,
      onPermissionDenied: onClose,
    },
  );
  const items = custodyRefusal(cmd.error, 'DUTY_END_BLOCKED_CUSTODY');
  const checklist = items?.length ? fromBlockItems(items as CustodyBlockItem[], snapshot) : snapshot;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      id="force-end-duty"
      title={s06.forceEnd}
      body={user.full_name}
      destructive
      confirmLabel={s06.forceEnd}
      pending={cmd.pending}
      error={items?.length ? fmt(s06.custodyOpen, { items: itemsText(items) }) : cmd.message}
      reasonError={cmd.fields.reason}
      onConfirm={(reason) => cmd.run(reason)}
    >
      <CustodyPreview checklist={checklist} known={known || !!items?.length} />
    </ReasonDialog>
  );
}
