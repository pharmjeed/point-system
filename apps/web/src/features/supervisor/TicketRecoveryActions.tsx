import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import type { PaymentMethod, TicketDetail, TicketTimeline } from '@/api/types';
import type { LinkCodeQr, ManualReconcileBody, ReconcileTarget } from '@/api/types.staff';
import {
  Banner,
  Button,
  Checkbox,
  FieldError,
  PhoneInput,
  QrPanel,
  Radio,
  Select,
  Sheet,
  TextArea,
  TextField,
} from '@/components';
import { useCountdown } from '@/hooks/useCountdown';
import {
  buttons,
  components,
  d01,
  d13,
  incidentStatus,
  incidentType,
  paymentMethod,
  ticketStatus,
  waLinkStatus,
} from '@/i18n/ar';
import { s03, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatClock, formatHalalas, formatTime } from '@/lib/format';
import { normalizeSaudiMobile } from '@/lib/phone';
import { useUiStore } from '@/stores/ui';
import { reconcileTargets, relinkMethods } from './permissions';
import {
  commands,
  fetchDrivers,
  fetchEvent,
  fetchKeyBoards,
  fetchParkingSpots,
  fetchTicket,
  staffKeys,
} from './staffApi';
import { reasonOk } from './ui';
import { useStaffCommand } from './useStaffCommand';

/**
 * The S-03 recovery actions (GAP-2; 02 S-03 table): «تغيير الجوال» (`PATCH /v1/tickets/{ticketId}/customer-phone`),
 * «إعادة الربط بواتساب» (`POST /v1/tickets/{ticketId}/whatsapp-link` + `/confirm`) and «مطابقة يدوية بعد انقطاع»
 * (`POST /v1/tickets/{ticketId}/manual-reconcile`). One Idempotency-Key session per intent (useStaffCommand), the
 * mandatory inputs checked before sending, the server's `message_ar` after (DEC-80).
 */
export interface RecoveryProps {
  ticket: TicketDetail;
  timeline?: TicketTimeline | null;
  meId: string;
  meName: string;
  onClose: () => void;
}

const invalidateFor = (t: TicketDetail) => [
  staffKeys.ticket(t.id),
  staffKeys.timeline(t.id),
  staffKeys.boards(),
  staffKeys.alerts(),
];

// ---------------------------------------------------------------- «تغيير الجوال»

/**
 * The new number, the field check «تحققت من صاحب المركبة أمامي» (local, not sent), the customer's verbal consent
 * (07: `consent`, DEC-211) and the reason. The consent sentence is D-13's, without the customer brand (canon §1
 * rule 2 keeps it to the S-03 message preview).
 */
export function ChangePhoneSheet({ ticket, onClose }: RecoveryProps) {
  const [phone, setPhone] = useState('');
  const [verified, setVerified] = useState(false);
  const [consent, setConsent] = useState(false);
  const [reason, setReason] = useState('');
  const [localPhoneError, setLocalPhoneError] = useState<string | null>(null);
  const cmd = useStaffCommand(
    (body: Parameters<typeof commands.changeCustomerPhone>[1], key: string) =>
      commands.changeCustomerPhone(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  const consentError = cmd.apiError?.code === 'CONSENT_REQUIRED' ? cmd.apiError.message_ar : undefined;
  const phoneError = localPhoneError ?? cmd.fields.customer_phone;
  const shown = !!(cmd.fields.reason || phoneError || consentError);
  const submit = () => {
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) {
      setLocalPhoneError(d01.phoneInvalid);
      return;
    }
    setLocalPhoneError(null);
    void cmd.run({
      expected_version: ticket.version,
      customer_phone: e164,
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      reason: reason.trim(),
    });
  };
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={s03.action.changePhone}>
      <div className="st-form">
        <PhoneInput
          id="act-phone-new"
          label={d13.newPhone}
          value={phone}
          error={phoneError}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Checkbox
          id="act-phone-verified"
          label={d13.verified}
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
        />
        <Checkbox
          id="act-phone-consent"
          label={d13.consent}
          checked={consent}
          error={consentError}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <TextArea
          id="act-phone-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          error={cmd.fields.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="st-muted m-0">{d13.phoneNote}</p>
        {cmd.message && !shown ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button
          fullWidth
          loading={cmd.pending}
          disabled={!phone.trim() || !verified || !consent || !reasonOk(reason)}
          onClick={submit}
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- «إعادة الربط بواتساب»

type RelinkStep = 'choose' | 'qr' | 'rejected';

/** Last three digits of a masked phone (`05•••••123` → «123», 02 D-07 «من رقم ينتهي بـ 123»). */
export const lastDigits = (masked: string | null | undefined, n = 3) =>
  (masked ?? '').replace(/\D/g, '').slice(-n);

/**
 * 02 D-07's two ways, run by the supervisor from S-03: «إعادة الإرسال» (W-01 again to the recorded number) and
 * «الربط عبر QR» (the customer-facing panel; the supervisor turns the screen to the customer). A QR message waiting
 * for its match is answered here as in D-07 («نعم، اربط التذكرة» / «لا، ليس هو»; venue supervisors may confirm,
 * DEC-198). The ticket is re-read every 5 s while the QR is shown (the realtime `ticket.updated` usually comes first).
 */
export function RelinkWhatsAppSheet({ ticket: initial, onClose }: RecoveryProps) {
  const live = useQuery({
    queryKey: staffKeys.ticket(initial.id),
    queryFn: ({ signal }) => fetchTicket(initial.id, signal),
    initialData: initial,
    refetchInterval: 5_000,
  });
  const ticket = live.data ?? initial;
  const methods = relinkMethods(ticket);
  const pushToast = useUiStore((s) => s.pushToast);
  const [step, setStep] = useState<RelinkStep>('choose');
  const [qr, setQr] = useState<LinkCodeQr | null>(null);
  const [linkedNow, setLinkedNow] = useState(false);

  const link = useStaffCommand(
    (body: { method: 'direct' | 'qr' }, key: string) => commands.linkWhatsApp(ticket.id, body, key),
    {
      invalidate: invalidateFor(ticket),
      successMessage: null,
      onPermissionDenied: onClose,
      onSuccess: (result) => {
        if (result.method === 'qr' && result.qr) {
          setQr(result.qr);
          setStep('qr');
          return;
        }
        // W-01 is queued (`pending_send`); the S-03 row follows `ticket.updated` to «مربوطة» or «تعذر الإرسال»
        pushToast({ message: staff.done, tone: 'success' });
        onClose();
      },
    },
  );
  const confirm = useStaffCommand(
    (body: { link_code_id: string; matches: boolean }, key: string) =>
      commands.confirmWhatsAppLink(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), successMessage: null, onPermissionDenied: onClose },
  );

  const pending = ticket.wa_link_pending ?? null;
  const awaitingMatch = !!pending && ticket.wa_link_status === 'pending_confirmation';
  const answer = async (matches: boolean) => {
    if (!pending) return;
    const result = await confirm.run({ link_code_id: pending.link_code_id, matches });
    if (!result) return;
    if (matches) setLinkedNow(true);
    else {
      setQr(null);
      setStep('rejected');
    }
  };

  const title = s03.action.relinkWhatsApp;
  if (linkedNow)
    return (
      <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={title}>
        <div className="st-form">
          <Banner kind="info" rounded message={s03.relink.linked} />
          <Button fullWidth variant="secondary" onClick={onClose}>
            {buttons.close}
          </Button>
        </div>
      </Sheet>
    );
  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={title}>
      <div className="st-form">
        {awaitingMatch ? (
          <section className="st-form" aria-live="polite" data-testid="relink-confirm">
            <p className="m-0">
              {fmt(s03.relink.arrived, { last3: lastDigits(pending?.inbound_phone_masked) })}
            </p>
            <p className="m-0 font-semibold">{s03.relink.question}</p>
            {confirm.message ? <FieldError role="alert">{confirm.message}</FieldError> : null}
            <Button size="lg" fullWidth loading={confirm.pending} onClick={() => void answer(true)}>
              {s03.relink.yes}
            </Button>
            <Button
              fullWidth
              variant="secondary"
              disabled={confirm.pending}
              onClick={() => void answer(false)}
            >
              {s03.relink.no}
            </Button>
          </section>
        ) : step === 'qr' && qr ? (
          <QrStep qr={qr} onNewCode={() => void link.run({ method: 'qr' })} pending={link.pending} />
        ) : (
          <>
            <p className="st-muted m-0">
              {fmt(s03.relink.status, { status: waLinkStatus[ticket.wa_link_status] })}
            </p>
            <p className="m-0">{s03.relink.hint}</p>
            {methods.direct && step !== 'rejected' ? (
              <Button fullWidth loading={link.pending} onClick={() => void link.run({ method: 'direct' })}>
                {s03.relink.direct}
              </Button>
            ) : null}
            {methods.qr ? (
              <Button
                fullWidth
                variant={methods.direct && step !== 'rejected' ? 'secondary' : 'primary'}
                loading={link.pending}
                onClick={() => void link.run({ method: 'qr' })}
              >
                {step === 'rejected' ? s03.relink.newCode : s03.relink.qr}
              </Button>
            ) : null}
          </>
        )}
        {link.message && !awaitingMatch ? <FieldError role="alert">{link.message}</FieldError> : null}
      </div>
    </Sheet>
  );
}

function QrStep({ qr, onNewCode, pending }: { qr: LinkCodeQr; onNewCode: () => void; pending: boolean }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    void QRCode.toString(qr.qr_text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }).then((s) => {
      if (alive) setSvg(s);
    });
    return () => {
      alive = false;
    };
  }, [qr.qr_text]);
  const left = useCountdown(Date.parse(qr.expires_at));
  const expired = left <= 0;
  return (
    <div className="st-form" data-testid="relink-qr">
      {svg ? <QrPanel qrSvg={svg} ttl={formatClock(left)} expired={expired} /> : null}
      <p className="m-0" aria-live="polite">
        {expired ? s03.relink.expired : s03.relink.waiting}
      </p>
      <Button fullWidth variant={expired ? 'primary' : 'secondary'} loading={pending} onClick={onNewCode}>
        {s03.relink.newCode}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- «مطابقة يدوية بعد انقطاع»

const TARGET_ORDER: ReconcileTarget[] = ['parked', 'delivered', 'voided'];

/**
 * After a full outage the supervisor (or admin) sets the true state from the numbered paper log (02 S-03; 07
 * `manualReconcile`; docs/runbooks/paper-fallback.md §5.4): the state, the log reference and its note, the spot /
 * description / key slot for «متوقفة», the documented collection (method, the collector of the log) for a
 * «مُسلّمة» ticket that is due, an optional linked incident, and the reason. Nothing deferred runs and no customer
 * message goes out (TT-22); the server answers PAYMENT_PENDING, the occupied spot or slot, a closed ticket.
 */
export function ManualReconcileSheet({ ticket, timeline, meId, meName, onClose }: RecoveryProps) {
  const targets = reconcileTargets(ticket);
  const [target, setTarget] = useState<ReconcileTarget | ''>(targets.length === 1 ? (targets[0] ?? '') : '');
  const [paperRef, setPaperRef] = useState('');
  const [note, setNote] = useState('');
  const [spotId, setSpotId] = useState(ticket.current_spot?.id ?? '');
  const [spotNote, setSpotNote] = useState('');
  const [slotId, setSlotId] = useState(ticket.current_key_slot?.id ?? '');
  const [incidentId, setIncidentId] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [pos, setPos] = useState('');
  const [collector, setCollector] = useState('');
  const [reason, setReason] = useState('');

  const parked = target === 'parked';
  const needsPayment = target === 'delivered' && ticket.payment_status === 'due';
  const spots = useQuery({
    queryKey: staffKeys.parkingSpots(ticket.venue_id),
    queryFn: ({ signal }) => fetchParkingSpots(ticket.venue_id, signal),
    enabled: parked,
  });
  const boards = useQuery({
    queryKey: staffKeys.keyBoards(ticket.venue_id),
    queryFn: ({ signal }) => fetchKeyBoards(ticket.venue_id, signal),
    enabled: parked,
  });
  const event = useQuery({
    queryKey: staffKeys.event(ticket.event_id),
    queryFn: ({ signal }) => fetchEvent(ticket.event_id, signal),
    enabled: needsPayment,
  });
  const drivers = useQuery({
    queryKey: staffKeys.venueDrivers(ticket.venue_id),
    queryFn: ({ signal }) => fetchDrivers({ venue_id: ticket.venue_id }, signal),
    enabled: needsPayment,
  });

  const spotOptions = useMemo(() => {
    const out: Array<readonly [string, string]> = [];
    const current = ticket.current_spot;
    if (current) out.push([current.id, [current.zone_name, current.label].filter(Boolean).join(' · ')]);
    for (const s of spots.data?.items ?? [])
      if (s.id !== current?.id) out.push([s.id, s.zone_name ? `${s.zone_name} · ${s.label}` : s.label]);
    return out;
  }, [spots.data, ticket.current_spot]);
  const slotOptions = useMemo(() => {
    const out: Array<readonly [string, string]> = [];
    const current = ticket.current_key_slot;
    if (current) out.push([current.id, `${current.board_name} · ${current.label}`]);
    for (const b of boards.data ?? [])
      for (const s of b.slots)
        if (s.status === 'active' && !s.occupied && s.id !== current?.id)
          out.push([s.id, `${b.board.name} · ${s.label}`]);
    return out;
  }, [boards.data, ticket.current_key_slot]);
  const methods: PaymentMethod[] = event.data?.allowed_payment_methods?.length
    ? event.data.allowed_payment_methods
    : ['cash', 'pos'];
  const collectors: Array<readonly [string, string]> = [
    ...(drivers.data?.items ?? [])
      .filter((d) => d.user.id !== meId)
      .map((d) => [d.user.id, `${d.user.full_name} · ${d.user.employee_code}`] as const),
    [meId, `${meName} (${staff.me})`] as const,
  ];
  const incidents = (timeline?.incidents ?? []).map(
    (i) =>
      [
        i.id,
        `${incidentType[i.type] ?? i.type} · ${incidentStatus[i.status]} · ${formatTime(i.created_at)}`,
      ] as const,
  );

  const cmd = useStaffCommand(
    (body: ManualReconcileBody, key: string) => commands.manualReconcile(ticket.id, body, key),
    { invalidate: invalidateFor(ticket), onSuccess: onClose, onPermissionDenied: onClose },
  );
  const code = cmd.apiError?.code;
  const spotError =
    cmd.fields.parking_spot_id ?? (code === 'PARKING_SPOT_OCCUPIED' ? cmd.apiError?.message_ar : undefined);
  const slotError =
    cmd.fields.key_slot_id ?? (code === 'KEY_SLOT_OCCUPIED' ? cmd.apiError?.message_ar : undefined);
  const paymentError =
    code &&
    [
      'PAYMENT_PENDING',
      'PAYMENT_AMOUNT_MISMATCH',
      'PAYMENT_METHOD_NOT_ALLOWED',
      'PAYMENT_ALREADY_RECORDED',
    ].includes(code)
      ? cmd.apiError?.message_ar
      : (cmd.fields.payment ?? cmd.fields['payment.collected_by']);
  const placed = !!(
    cmd.fields.reason ||
    cmd.fields['evidence.paper_log_ref'] ||
    spotError ||
    slotError ||
    paymentError ||
    cmd.fields['payment.pos_reference'] ||
    cmd.fields['payment.method'] ||
    cmd.fields.incident_id
  );
  const ready =
    !!target &&
    paperRef.trim().length > 0 &&
    reasonOk(reason) &&
    (!needsPayment || (!!method && !!collector));

  const submit = () => {
    if (!target) return;
    const body: ManualReconcileBody = {
      target_status: target,
      reason: reason.trim(),
      evidence: { paper_log_ref: paperRef.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
      expected_version: ticket.version,
      incident_id: incidentId || null,
    };
    if (parked) {
      body.parking_spot_id = spotId || null;
      body.spot_note = spotNote.trim() || null;
      body.key_slot_id = slotId || null;
    }
    if (needsPayment)
      body.payment = {
        method: method as PaymentMethod,
        amount_halalas: ticket.fee_halalas ?? 0,
        pos_reference: method === 'pos' && pos.trim() ? pos.trim() : null,
        collected_by: collector,
      };
    void cmd.run(body);
  };

  return (
    <Sheet open onOpenChange={(o) => (o ? undefined : onClose())} title={s03.action.manualReconcile}>
      <div className="st-form">
        <p className="st-muted m-0">{s03.reconcile.note}</p>
        <Radio
          name="act-reconcile-target"
          legend={s03.reconcile.target}
          options={TARGET_ORDER.filter((x) => targets.includes(x)).map((x) => [x, ticketStatus[x]] as const)}
          value={target}
          onChange={(v) => setTarget(v as ReconcileTarget)}
        />
        {ticket.channel === 'paper' && !ticket.paper_serial ? (
          <p className="st-muted m-0">{s03.reconcile.paperOnlyVoid}</p>
        ) : null}
        {!targets.includes('voided') ? <p className="st-muted m-0">{s03.reconcile.paymentRecorded}</p> : null}
        {cmd.fields.target_status ? <FieldError role="alert">{cmd.fields.target_status}</FieldError> : null}
        <TextField
          id="act-reconcile-ref"
          label={s03.reconcile.paperRef}
          hint={s03.reconcile.paperRefHint}
          dir="ltr"
          maxLength={60}
          autoComplete="off"
          value={paperRef}
          error={cmd.fields['evidence.paper_log_ref']}
          onChange={(e) => setPaperRef(e.target.value)}
        />
        <TextArea
          id="act-reconcile-note"
          label={s03.reconcile.evidenceNote}
          hint={s03.reconcile.evidenceNoteHint}
          rows={2}
          maxLength={500}
          value={note}
          error={cmd.fields['evidence.note']}
          onChange={(e) => setNote(e.target.value)}
        />
        {parked ? (
          <fieldset className="st-form st-fieldset">
            <legend className="pt-section-title">{ticketStatus.parked}</legend>
            <Select
              id="act-reconcile-spot"
              label={s03.reconcile.spot}
              placeholder="—"
              value={spotId}
              options={spotOptions}
              error={spotError}
              onChange={(e) => setSpotId(e.target.value)}
            />
            <TextField
              id="act-reconcile-spot-note"
              label={s03.reconcile.spotNote}
              maxLength={120}
              value={spotNote}
              error={cmd.fields.spot_note}
              onChange={(e) => setSpotNote(e.target.value)}
            />
            <Select
              id="act-reconcile-slot"
              label={s03.reconcile.slot}
              placeholder="—"
              value={slotId}
              options={slotOptions}
              error={slotError}
              onChange={(e) => setSlotId(e.target.value)}
            />
            <p className="st-muted m-0">{s03.reconcile.unknownHolder}</p>
          </fieldset>
        ) : null}
        {needsPayment ? (
          <fieldset className="st-form st-fieldset">
            <legend className="pt-section-title">{s03.exception.paymentSection}</legend>
            <p className="m-0">
              {staff.amount}: <bdi dir="ltr">{formatHalalas(ticket.fee_halalas ?? 0)}</bdi>
            </p>
            <Select
              id="act-reconcile-method"
              label={staff.method}
              placeholder="—"
              value={method}
              options={methods.map((m) => [m, paymentMethod[m]] as const)}
              error={cmd.fields['payment.method']}
              onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}
            />
            {method === 'pos' ? (
              <TextField
                id="act-reconcile-pos"
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
              id="act-reconcile-collector"
              label={s03.exception.collectedBy}
              hint={s03.reconcile.collectorHint}
              placeholder="—"
              value={collector}
              options={collectors}
              onChange={(e) => setCollector(e.target.value)}
            />
            {paymentError ? <FieldError role="alert">{paymentError}</FieldError> : null}
          </fieldset>
        ) : target === 'delivered' && paymentError ? (
          <FieldError role="alert">{paymentError}</FieldError>
        ) : null}
        {incidents.length ? (
          <Select
            id="act-reconcile-incident"
            label={s03.reconcile.incident}
            placeholder="—"
            value={incidentId}
            options={incidents}
            error={cmd.fields.incident_id}
            onChange={(e) => setIncidentId(e.target.value)}
          />
        ) : null}
        <TextArea
          id="act-reconcile-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          error={cmd.fields.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {cmd.message && !placed ? <FieldError role="alert">{cmd.message}</FieldError> : null}
        <Button fullWidth loading={cmd.pending} disabled={!ready} onClick={submit}>
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}
