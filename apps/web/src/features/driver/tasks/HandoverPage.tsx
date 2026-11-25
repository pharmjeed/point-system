import { useQueryClient } from '@tanstack/react-query';
import { useBrand } from '@/hooks/useMe';
import { CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  EntitlementChip,
  Icon,
  PlateBadge,
  SegmentedControl,
  Sheet,
  TextArea,
  TextField,
} from '@/components';
import { FieldError } from '@/components/Field';
import { entitlementBadgeOf } from '@/features/common/entitlement';
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
import { CarCard } from '@/components/CarGlyph';

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
  const brand = useBrand(); // V2-033: «مشترك {brand}»
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
  const badge = entitlementBadgeOf(
    card.ticket.entitlement ?? ticket.entitlement,
    due ? { amountHalalas: amount } : null,
    brand.staffNameAr,
  );
  const methods: PaymentMethod[] = card.payment_due?.allowed_methods?.length
    ? card.payment_due.allowed_methods
    : ['cash', 'pos'];
  const [codeState, setCodeState] = useState<ClaimCodeState | null>(null);
  // the newest code state wins: this screen's resend reply until the ticket catches up, then the server's —
  // also a code the supervisor reissued (DEC-207) or the first one of a ticket linked after `ready`
  const claim = newestClaim(ticket.claim_code, codeState, card.claim_code);
  const now = useServerNow(1000);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [sheet, setSheet] = useState<'help' | 'supervisor' | null>(null);

  const [stub, setStub] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? 'cash');
  const [posRef, setPosRef] = useState('');
  const [received, setReceived] = useState(false);
  const [localError, setLocalError] = useState<{
    field: 'stub' | 'code' | 'payment';
    message: string;
  } | null>(null);
  // what this screen's own attempts learned, for the code they were made on: a newer code starts afresh
  const [attempt, setAttempt] = useState<{ issuedAt: string | null; left?: number; locked?: boolean }>({
    issuedAt: null,
  });
  const issuedAt = claim?.issued_at ?? null;
  const mine = attempt.issuedAt === issuedAt ? attempt : null;
  const attemptsLeft =
    mine?.left !== undefined && claim
      ? Math.min(mine.left, claim.attempts_left)
      : (mine?.left ?? claim?.attempts_left);
  const locked = !!mine?.locked || !!claim?.locked_at;
  // 14 §3.4 handover.code_issued «أُرسل الرمز للعميل» for a code this screen did not ask for
  const ownCodes = useRef(new Set<string>());
  const seenCode = useRef(issuedAt);
  useEffect(() => {
    if (!issuedAt || issuedAt === seenCode.current) return;
    const newer = !seenCode.current || Date.parse(issuedAt) > Date.parse(seenCode.current);
    seenCode.current = issuedAt;
    if (newer && !ownCodes.current.has(issuedAt)) pushToast({ message: live.codeIssued, tone: 'info' });
  }, [issuedAt, pushToast]);

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
        if (Number.isFinite(left)) setAttempt({ issuedAt, left });
        void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
      } else if (error.is('HANDOVER_CODE_LOCKED')) {
        setCode('');
        setAttempt({ issuedAt, locked: true });
        void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
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
      ownCodes.current.add(state.issued_at);
      setCodeState(state);
      setCode('');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setSheet(null);
      submit.reset();
      pushToast({ message: d11.resent, tone: 'success' });
      void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
    } catch (error) {
      // shown under the link; a code locked meanwhile disables the input
      if (error instanceof ApiError && error.is('HANDOVER_CODE_LOCKED'))
        setAttempt({ issuedAt, locked: true });
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
  // no code for this retrieval: the server issues one at `ready` only for a linked ticket (07 ready); a ticket
  // linked since gets its first code from the resend, any other is verified by the supervisor (DEC-210)
  const linked = ticket.wa_link_status === 'linked';
  const noCode = !claim;
  const resendsLeft = claim?.resends_left;
  const exhausted = resendsLeft === 0;
  const coolingDown = cooldownUntil > Date.now(); // the device clock: 30 s from this press (re-rendered each second)
  const canResend =
    gate.ready && !locked && !coolingDown && !exhausted && !resend.pending && (!noCode || linked);
  const resendError = resend.error ? displayMessage(resend.error) : undefined;
  const resendButton = (
    <Button
      variant="secondary"
      loading={resend.pending}
      disabled={!canResend && !resend.pending}
      error={resendError}
      onClick={onResend}
    >
      {d11.newCode}
    </Button>
  );
  // the way to the supervisor stays open whenever the code cannot settle it — except a locked code, which
  // already raised `handover_code_locked` for him (02 D-11 «العميل لم يصله الرمز؟», DEC-210)
  const helpTrigger = (
    <button type="button" className="pt-link" onClick={() => setSheet('help')}>
      {d11.notReceived}
    </button>
  );

  return (
    <TaskScreen title={withTicket(d11.title, ticket.display_number)} backTo={driverPaths.task(card.task.id)}>
      {/* DEC-643: the car as its «بطاقة السيارة» */}
      <CarCard {...card.ticket.vehicle} caption={vehicleSummary(card.ticket.vehicle)}>
        {plate ? <PlateBadge {...plate} size="lg" /> : null}
        {/* O-02 (V2-014): «مشمول» / «يدفع X» */}
        {badge ? <EntitlementChip badge={badge} size="sm" /> : null}
      </CarCard>

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
      ) : noCode ? (
        // no code reached the customer for this retrieval (07 ready: linked tickets only)
        <section className="flex flex-col gap-3" aria-labelledby="verify-title" data-code-none>
          <h2 className="pt-section-title" id="verify-title">
            {d11.askCode}
          </h2>
          {optedOut ? (
            <Banner kind="warning" rounded message={live.optedOut} />
          ) : linked ? null : (
            <Banner kind="warning" rounded message={fallbackMessageAr('WA_NOT_LINKED')} />
          )}
          {linked ? (
            // linked after `ready`: the resend issues the first code (07 «دورة بلا رمز تأخذ أول رمز لها»)
            <>
              {resendButton}
              <div className="flex justify-center" data-code-help>
                {helpTrigger}
              </div>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setSheet('supervisor')}>
              {d11.askSupervisor}
            </Button>
          )}
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
          {!locked ? (
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
              {resendButton}
            </>
          ) : null}
          {!locked && !expired && sendFailed ? (
            <Banner kind="error" rounded message={live.codeSendFailed} />
          ) : null}
          {!locked && exhausted ? (
            // 08 RESEND_LIMIT_REACHED: no resend left — the supervisor (the Sheet below)
            <p className="m-0 text-sm text-text-muted" data-resend-limit>
              {fallbackMessageAr('RESEND_LIMIT_REACHED')}
            </p>
          ) : null}
          {!locked ? (
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1" data-code-help>
              {helpTrigger}
              {expired || error?.is('HANDOVER_CODE_EXPIRED') ? null : (
                <>
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
                </>
              )}
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
        disabled={!gate.ready || locked || (!paper && noCode)}
        onClick={onSubmit}
      >
        {d11.submit}
      </Button>
      {paper ? null : (
        <CodeHelpSheet
          open={sheet !== null}
          onOpenChange={(open) => setSheet(open ? (sheet ?? 'help') : null)}
          supervisorOnly={sheet === 'supervisor'}
          canResend={canResend}
          resendLoading={resend.pending}
          onResend={onResend}
          ready={gate.ready}
          request={askSupervisor}
          onReported={() => {
            setSheet(null);
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
 * Without a code to resend (a ticket not linked at `ready`) it opens on the supervisor request alone.
 */
function CodeHelpSheet({
  open,
  onOpenChange,
  supervisorOnly,
  canResend,
  resendLoading,
  onResend,
  ready,
  request,
  onReported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supervisorOnly: boolean;
  canResend: boolean;
  resendLoading: boolean;
  onResend: () => Promise<void>;
  ready: boolean;
  request: ReturnType<typeof useCommand<{ description: string }, unknown>>;
  onReported: () => void;
}) {
  const [opened, setAsking] = useState(false);
  const asking = opened || supervisorOnly;
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
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={supervisorOnly ? d11.askSupervisor : d11.notReceived}
    >
      <div className="flex flex-col gap-3">
        {supervisorOnly ? null : (
          <>
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
          </>
        )}
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
