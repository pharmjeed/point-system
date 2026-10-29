import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, fallbackMessageAr } from '@/api/errors';
import { handover, reportIncident, resendHandoverCode, type HandoverInput } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { ClaimCodeState, PaymentMethod, TaskCard as TaskCardData, TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Checkbox,
  CodeInput,
  Icon,
  PlateBadge,
  SegmentedControl,
  Sheet,
  TextArea,
  TextField,
} from '@/components';
import { FieldError } from '@/components/Field';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useServerNow } from '@/hooks/useNow';
import { useCommandGate } from '@/realtime/hooks';
import { buttons, d11, d13, live, paymentMethod, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { withTicket } from '@/i18n/fmtNode';
import { formatHalalas, formatTime } from '@/lib/format';
import { onlyDigits } from '@/lib/digits';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import { driverPaths, findTicketTask, newestClaim, plateValue, vehicleSummary } from '../fieldModel';
import { COMPLETING_WINDOW_MS } from '../promotion';
import { useDriverHome, useRefreshHome } from '../useDriverHome';
import { TaskGone, TaskScreen, TaskSkeleton, useStoreTicket, useTicket } from './common';

/** Shown 2 s before moving on (02 D-11 «بعد ثانيتين»). */
const SUCCESS_MS = 2000;
/** 02 D-11 «مع تعطيل الرابط 30 ث بعد كل إرسال». */
export const RESEND_COOLDOWN_MS = 30_000;
const DESCRIPTION_MIN = 3; // 07 `createIncident.description` minLength

/**
 * D-11 — التسليم والتحصيل: the paper stub number (paper channel) or the six-digit code (WhatsApp, PNT-047),
 * the collection section when the ticket is `due`, then `POST /v1/tickets/{ticketId}/handover` — verification,
 * payment and closing are one server transaction (13). The code is never pre-filled or shown and the cells are
 * cleared after a wrong attempt (DEC-38). «العميل لم يصله الرمز؟ │ إعادة الإرسال (متبقٍ n)» before the expiry:
 * the resend (30 s apart) and a Sheet with «إعادة إرسال الرمز» / «طلب المشرف (تحقق يدوي)» — a
 * `manual_verification` incident the supervisor settles in S-03 (DEC-210); the 14 §5.1 banners: W-05 not
 * sent, the code expired (by server time), locked, the customer who stopped the messages.
 */
export function HandoverPage() {
  const { ticketId = '' } = useParams();
  const home = useDriverHome();
  const ticket = useTicket(ticketId);
  const [delivered, setDelivered] = useState<{ n: number; whatsapp: boolean } | null>(null);
  if (delivered) return <Delivered {...delivered} />;
  if (home.data && ticket.data) {
    const card = findTicketTask(home.data, ticketId);
    if (!card) return <TaskGone />;
    // the task card is the fresh state (D-10 writes each step's reply into it); the detail may lag behind
    if (card.ticket.status !== 'ready') return <Navigate to={driverPaths.task(card.task.id)} replace />;
    return <HandoverForm ticket={ticket.data} card={card} onDelivered={setDelivered} />;
  }
  const error = home.error ?? ticket.error;
  if (error)
    return (
      <LoadError
        error={error}
        onRetry={() => {
          void home.refetch();
          void ticket.refetch();
        }}
        backTo={paths.driverHome}
      />
    );
  return <TaskSkeleton />;
}

function Delivered({ n, whatsapp }: { n: number; whatsapp: boolean }) {
  const navigate = useNavigate();
  useEffect(() => {
    const timer = setTimeout(() => navigate(paths.driverHome, { replace: true }), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [navigate]);
  // 02 D-11 «✓ تم تسليم #125»: a success block (semantic success pair), not an empty state
  return (
    <section className="flex flex-col items-center gap-3 py-8 text-center" role="status" aria-live="polite">
      <span className="grid size-16 place-items-center rounded-full bg-success-subtle text-success-text">
        <Icon icon={CircleCheck} size={32} />
      </span>
      <p className="m-0 text-xl font-bold" id="handover-done">
        {withTicket(d11.delivered, n)}
      </p>
      {whatsapp ? <p className="m-0 text-text-muted">{d11.customerNotified}</p> : null}
    </section>
  );
}

function HandoverForm({
  ticket,
  card,
  onDelivered,
}: {
  ticket: TicketDetail;
  card: TaskCardData;
  onDelivered: (d: { n: number; whatsapp: boolean }) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // 02 §1.6/§1.7, 03 §4.4: no confirmed connection or stale data → commands wait (PNT-065); no handover
  // without the server's check (02 D-11)
  const gate = useCommandGate();
  const online = !gate.unconfirmed;
  const refresh = useRefreshHome();
  const storeTicket = useStoreTicket();
  const pushToast = useUiStore((s) => s.pushToast);
  const setPromotion = useFieldStore((s) => s.setPromotion);
  const setCompleting = useFieldStore((s) => s.setCompleting);
  const paper = ticket.channel === 'paper';
  const due = !!card.payment_due || ticket.payment_status === 'due';
  const amount = card.payment_due?.amount_halalas ?? ticket.fee_halalas ?? 0;
  const methods: PaymentMethod[] = card.payment_due?.allowed_methods?.length
    ? card.payment_due.allowed_methods
    : ['cash', 'pos'];
  const [codeState, setCodeState] = useState<ClaimCodeState | null>(null);
  const claim = newestClaim(ticket.claim_code, codeState, card.claim_code);
  const now = useServerNow(1000);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [sheet, setSheet] = useState(false);

  const [stub, setStub] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? 'cash');
  const [posRef, setPosRef] = useState('');
  const [received, setReceived] = useState(false);
  const [localError, setLocalError] = useState<{
    field: 'stub' | 'code' | 'payment';
    message: string;
  } | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | undefined>(claim?.attempts_left);
  const [locked, setLocked] = useState(!!claim?.locked_at);

  const submit = useCommand((body: HandoverInput, key: string) => handover(ticket.id, body, key));
  const resend = useCommand((_: { ticket: string }, key: string) => resendHandoverCode(ticket.id, key));
  const askSupervisor = useCommand((body: { description: string }, key: string) =>
    reportIncident(
      {
        venue_id: ticket.venue_id,
        event_id: ticket.event_id,
        ticket_id: ticket.id,
        type: 'manual_verification',
        description: body.description,
      },
      key,
    ),
  );

  const send = async (withPayment: boolean) => {
    const body: HandoverInput = {
      verification: paper ? { method: 'paper_stub', paper_serial: stub.trim() } : { method: 'code', code },
      ...(due && withPayment
        ? {
            payment: {
              method,
              amount_halalas: amount,
              ...(method === 'pos' && posRef.trim() ? { pos_reference: posRef.trim() } : {}),
            },
          }
        : {}),
      expected_version: Math.max(card.ticket.version, ticket.version),
    };
    const result = await submit.run(body);
    storeTicket(result.ticket);
    const promoted = result.driver.promoted_next_task;
    // 02 D-11: «بعد ثانيتين» of «تم تسليم #125» the frame shows «مهمتك التالية بدأت الآن» (and next_due)
    if (promoted) setPromotion({ card: promoted, title: d11.promoted, showAt: Date.now() + SUCCESS_MS });
    void refresh();
    onDelivered({ n: ticket.display_number, whatsapp: !paper });
  };

  const submitChecked = async () => {
    setLocalError(null);
    const local =
      paper && !stub.trim()
        ? { field: 'stub' as const, message: ui.validation }
        : !paper && code.length !== 6
          ? { field: 'code' as const, message: ui.validation }
          : due && !received
            ? { field: 'payment' as const, message: fallbackMessageAr('PAYMENT_PENDING') }
            : null;
    if (local) {
      setLocalError(local);
      return;
    }
    try {
      await send(true);
    } catch (error) {
      if (!(error instanceof ApiError)) return;
      if (error.is('HANDOVER_CODE_INVALID')) {
        setCode('');
        const left = Number(error.details.attempts_left);
        if (Number.isFinite(left)) setAttemptsLeft(left);
      } else if (error.is('HANDOVER_CODE_LOCKED')) {
        setCode('');
        setLocked(true);
      } else if (error.is('PAYMENT_ALREADY_RECORDED')) {
        // 02 D-11: silent sync, then the same handover without the collection data (a new intent)
        await qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
        try {
          await send(false);
        } catch {
          // shown by the command state
        }
      } else if (error.is('HANDOVER_NOT_READY')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(driverPaths.task(card.task.id), { replace: true });
      } else if (error.is('NOT_TASK_ASSIGNEE', 'TICKET_CLOSED')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(paths.driverHome, { replace: true });
      } else if (error.is('VERSION_CONFLICT', 'HANDOVER_CODE_CONSUMED', 'PAYMENT_AMOUNT_MISMATCH')) {
        void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
        void refresh();
      }
    }
  };

  const onSubmit = async () => {
    // the promotion this handover causes is announced from the reply (in `send`), not by the frame
    setCompleting(Date.now() + COMPLETING_WINDOW_MS);
    try {
      await submitChecked();
    } finally {
      setCompleting(0);
    }
  };

  const onResend = async () => {
    try {
      const state = await resend.run({ ticket: ticket.id });
      setCodeState(state);
      setAttemptsLeft(state.attempts_left);
      setLocked(!!state.locked_at);
      setCode('');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setSheet(false);
      submit.reset();
      pushToast({ message: d11.resent, tone: 'success' });
      void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
    } catch (error) {
      // shown under the link; a code locked meanwhile disables the input
      if (error instanceof ApiError && error.is('HANDOVER_CODE_LOCKED')) setLocked(true);
      if (error instanceof ApiError && error.is('NOT_TASK_ASSIGNEE')) {
        pushToast({ message: error.message_ar, tone: 'error' });
        void refresh();
        navigate(paths.driverHome, { replace: true });
      }
    }
  };

  const error = submit.error instanceof ApiError ? submit.error : null;
  const errorText = submit.error ? displayMessage(submit.error) : null;
  // paper stub attempts count against `handover.max_attempts` too; the lock then shows under the stub field
  const stubError =
    localError?.field === 'stub'
      ? localError.message
      : error?.is('PAPER_STUB_MISMATCH') || (paper && error?.is('HANDOVER_CODE_LOCKED'))
        ? errorText
        : null;
  const codeError =
    localError?.field === 'code'
      ? localError.message
      : error?.is('HANDOVER_CODE_INVALID', 'HANDOVER_CODE_EXPIRED', 'HANDOVER_CODE_CONSUMED')
        ? errorText
        : null;
  const paymentError =
    localError?.field === 'payment'
      ? localError.message
      : error?.is('PAYMENT_PENDING', 'PAYMENT_METHOD_NOT_ALLOWED', 'PAYMENT_AMOUNT_MISMATCH')
        ? errorText
        : null;
  const formError =
    submit.error && !stubError && !codeError && !paymentError && !error?.is('HANDOVER_CODE_LOCKED')
      ? errorText
      : null;
  const plate = plateValue(card.ticket.plate);
  // 14 §5.1 / 02 D-11 (WhatsApp only): expired by server time, W-05 not sent, the customer stopped the messages
  const expired = !!claim && !locked && Date.parse(claim.expires_at) <= now;
  const sendFailed = claim?.sent_status === 'failed' || claim?.sent_status === 'skipped';
  const optedOut = ticket.wa_link_status === 'opted_out' || !!ticket.customer?.opted_out;
  const resendsLeft = claim?.resends_left;
  const coolingDown = cooldownUntil > Date.now(); // the device clock: 30 s from this press (re-rendered each second)
  const canResend = gate.ready && !locked && !coolingDown && resendsLeft !== 0 && !resend.pending;
  const resendError = resend.error ? displayMessage(resend.error) : undefined;

  return (
    <TaskScreen title={withTicket(d11.title, ticket.display_number)} backTo={driverPaths.task(card.task.id)}>
      <div className="flex flex-wrap items-center gap-3">
        {plate ? <PlateBadge {...plate} /> : null}
        <span>{vehicleSummary(card.ticket.vehicle)}</span>
      </div>

      {paper ? (
        <section className="flex flex-col gap-3" aria-labelledby="verify-title">
          <h2 className="pt-section-title" id="verify-title">
            {d11.askStub}
          </h2>
          <TextField
            id="stub"
            label={d11.stub}
            value={stub}
            maxLength={20}
            autoComplete="off"
            dir="ltr"
            disabled={locked}
            error={stubError ?? undefined}
            onChange={(e) => {
              setStub(e.target.value);
              setLocalError(null);
              if (submit.error && !error?.is('HANDOVER_CODE_LOCKED')) submit.reset();
            }}
          />
        </section>
      ) : (
        <section className="flex flex-col gap-3" aria-labelledby="verify-title">
          <h2 className="pt-section-title" id="verify-title">
            {d11.askCode}
          </h2>
          <p className="m-0 text-sm text-text-muted">{d11.codeHint}</p>
          <CodeInput
            id="handover-code"
            value={code}
            onChange={(v) => {
              setCode(onlyDigits(v));
              setLocalError(null);
              if (submit.error && !error?.is('HANDOVER_CODE_LOCKED')) submit.reset();
            }}
            attemptsLeft={locked ? undefined : attemptsLeft}
            locked={locked}
            error={codeError ?? undefined}
          />
          {claim && !locked ? (
            <p className="m-0 text-sm text-text-muted">
              {fmt(d11.codeMeta, {
                n: attemptsLeft ?? claim.attempts_left,
                time: formatTime(claim.expires_at),
              })}
            </p>
          ) : null}
          {locked ? <Banner kind="error" rounded message={live.codeLocked} /> : null}
          {optedOut ? <Banner kind="warning" rounded message={live.optedOut} /> : null}
          {!locked && (expired || error?.is('HANDOVER_CODE_EXPIRED')) ? (
            <>
              <Banner kind="warning" rounded message={live.codeExpired} />
              <Button
                variant="secondary"
                loading={resend.pending}
                disabled={!canResend && !resend.pending}
                error={resendError}
                onClick={onResend}
              >
                {d11.newCode}
              </Button>
            </>
          ) : null}
          {!locked && !expired && sendFailed ? (
            <Banner kind="error" rounded message={live.codeSendFailed} />
          ) : null}
          {claim && !locked && !expired ? (
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1" data-code-help>
              <button type="button" className="pt-link" onClick={() => setSheet(true)}>
                {d11.notReceived}
              </button>
              <span aria-hidden="true" className="text-text-muted">
                │
              </span>
              <button
                type="button"
                className="pt-link"
                id="code-resend"
                disabled={!canResend}
                aria-busy={resend.pending || undefined}
                onClick={onResend}
              >
                {fmt(d11.resendLeft, { n: resendsLeft ?? 0 })}
              </button>
            </div>
          ) : null}
          {resendError && !expired && !error?.is('HANDOVER_CODE_EXPIRED') ? (
            <FieldError id="resend-error" role="alert">
              {resendError}
            </FieldError>
          ) : null}
        </section>
      )}

      {due ? (
        <section className="flex flex-col gap-3" aria-labelledby="payment-title">
          <h2 className="pt-section-title" id="payment-title">
            {d11.payment}
          </h2>
          <p className="m-0 text-lg font-semibold">{fmt(d11.amountDue, { amount: formatHalalas(amount) })}</p>
          <SegmentedControl
            label={d11.method}
            value={method}
            options={methods.map((m) => ({ value: m, label: paymentMethod[m] }))}
            onChange={(m) => {
              setMethod(m);
              if (submit.error) submit.reset();
            }}
          />
          {method === 'pos' ? (
            <TextField
              id="pos-reference"
              label={d11.posReference}
              hint={d11.posHint}
              value={posRef}
              maxLength={40}
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              onChange={(e) => setPosRef(e.target.value)}
            />
          ) : null}
          <Checkbox
            id="payment-received"
            label={d11.received}
            checked={received}
            error={paymentError ?? undefined}
            onChange={(e) => {
              setReceived(e.target.checked);
              if (localError?.field === 'payment') setLocalError(null);
            }}
          />
        </section>
      ) : null}

      {formError ? <Banner kind="error" rounded message={formError} /> : null}
      {!online ? <Banner kind="offline" rounded message={d11.offline} /> : null}
      <Button
        size="lg"
        id="handover-submit"
        loading={submit.pending}
        disabled={!gate.ready || locked}
        onClick={onSubmit}
      >
        {d11.submit}
      </Button>
      {paper ? null : (
        <CodeHelpSheet
          open={sheet}
          onOpenChange={setSheet}
          canResend={canResend}
          resendLoading={resend.pending}
          onResend={onResend}
          ready={gate.ready}
          request={askSupervisor}
          onReported={() => {
            setSheet(false);
            pushToast({ message: d13.reported, tone: 'success' });
          }}
        />
      )}
    </TaskScreen>
  );
}

/**
 * «العميل لم يصله الرمز؟» (02 D-11): «إعادة إرسال الرمز», or «طلب المشرف (تحقق يدوي)» with a mandatory
 * description → a `manual_verification` incident; the supervisor completes the exceptional handover in S-03.
 */
function CodeHelpSheet({
  open,
  onOpenChange,
  canResend,
  resendLoading,
  onResend,
  ready,
  request,
  onReported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canResend: boolean;
  resendLoading: boolean;
  onResend: () => Promise<void>;
  ready: boolean;
  request: ReturnType<typeof useCommand<{ description: string }, unknown>>;
  onReported: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [description, setDescription] = useState('');
  const send = async () => {
    try {
      await request.run({ description: description.trim() });
      setAsking(false);
      setDescription('');
      onReported();
    } catch {
      // shown under the button
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d11.notReceived}>
      <div className="flex flex-col gap-3">
        <Button
          variant="secondary"
          fullWidth
          loading={resendLoading}
          disabled={!canResend && !resendLoading}
          onClick={onResend}
        >
          {d11.resendCode}
        </Button>
        <Button variant="secondary" fullWidth onClick={() => setAsking(true)} disabled={asking}>
          {d11.askSupervisor}
        </Button>
        {asking ? (
          <>
            <TextArea
              id="manual-verification-description"
              label={d13.reportDescription}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {request.error ? (
              <FieldError id="manual-verification-error" role="alert">
                {displayMessage(request.error)}
              </FieldError>
            ) : null}
            <Button
              fullWidth
              size="lg"
              loading={request.pending}
              disabled={description.trim().length < DESCRIPTION_MIN || !ready}
              onClick={send}
            >
              {buttons.confirm}
            </Button>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
