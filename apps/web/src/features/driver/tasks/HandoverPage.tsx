import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, fallbackMessageAr } from '@/api/errors';
import { handover, resendHandoverCode, type HandoverInput } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { PaymentMethod, TaskCard as TaskCardData, TicketDetail } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Checkbox,
  CodeInput,
  Icon,
  PlateBadge,
  SegmentedControl,
  TextField,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useOnline } from '@/hooks/useOnline';
import { d11, paymentMethod, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { withTicket } from '@/i18n/fmtNode';
import { formatHalalas, formatTime } from '@/lib/format';
import { onlyDigits } from '@/lib/digits';
import { useFieldStore } from '@/stores/field';
import { useUiStore } from '@/stores/ui';
import { driverPaths, findTicketTask, plateValue, vehicleSummary } from '../fieldModel';
import { useDriverHome, useRefreshHome } from '../useDriverHome';
import { TaskGone, TaskScreen, TaskSkeleton, useStoreTicket, useTicket } from './common';

/** Shown 2 s before moving on (02 D-11 «بعد ثانيتين»). */
const SUCCESS_MS = 2000;

/**
 * D-11 — التسليم والتحصيل: the paper stub number (paper channel) or the six-digit code (WhatsApp, PNT-047),
 * the collection section when the ticket is `due`, then `POST /v1/tickets/{ticketId}/handover` — verification,
 * payment and closing are one server transaction (13). The code is never pre-filled or shown and the cells are
 * cleared after a wrong attempt (DEC-38).
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
  const online = useOnline();
  const refresh = useRefreshHome();
  const storeTicket = useStoreTicket();
  const pushToast = useUiStore((s) => s.pushToast);
  const setPromotion = useFieldStore((s) => s.setPromotion);
  const paper = ticket.channel === 'paper';
  const due = !!card.payment_due || ticket.payment_status === 'due';
  const amount = card.payment_due?.amount_halalas ?? ticket.fee_halalas ?? 0;
  const methods: PaymentMethod[] = card.payment_due?.allowed_methods?.length
    ? card.payment_due.allowed_methods
    : ['cash', 'pos'];
  const claim = card.claim_code ?? ticket.claim_code ?? null;

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
    if (promoted) setPromotion({ card: promoted, title: d11.promoted });
    void refresh();
    onDelivered({ n: ticket.display_number, whatsapp: !paper });
  };

  const onSubmit = async () => {
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

  const onResend = async () => {
    try {
      const state = await resend.run({ ticket: ticket.id });
      setAttemptsLeft(state.attempts_left);
      setLocked(false);
      submit.reset();
      pushToast({ message: d11.resent, tone: 'success' });
    } catch {
      // shown under the button
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
          {error?.is('HANDOVER_CODE_EXPIRED') ? (
            <Button
              variant="secondary"
              loading={resend.pending}
              error={resend.error ? displayMessage(resend.error) : undefined}
              onClick={onResend}
            >
              {d11.newCode}
            </Button>
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
        disabled={!online || locked}
        onClick={onSubmit}
      >
        {d11.submit}
      </Button>
    </TaskScreen>
  );
}
