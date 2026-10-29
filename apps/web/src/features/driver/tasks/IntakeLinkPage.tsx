import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Hourglass, Info, Maximize, X, type LucideIcon } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { confirmWhatsAppLink, linkWhatsApp, patchIntake, type IntakePatch } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { TicketDetail, WaLinkStatus } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Header,
  IconButton,
  QrPanel,
  Sheet,
  TextField,
} from '@/components';
import { FieldError } from '@/components/Field';
import { StateChip, type ChipTone } from '@/features/common/StateChip';
import { LoadError } from '@/features/common/QueryView';
import { useCommand } from '@/hooks/useCommand';
import { useServerNow } from '@/hooks/useNow';
import { buttons, d05, d07, d13, live, ui, waLinkStatus } from '@/i18n/ar';
import { fmtNode, Ltr, withTicket } from '@/i18n/fmtNode';
import { formatClock } from '@/lib/format';
import { useCommandGate } from '@/realtime/hooks';
import { useFieldStore } from '@/stores/field';
import { useDriverMe } from '../DriverLayout';
import { driverPaths } from '../fieldModel';
import { linkActions, linkMode, phoneTail, qrRemainingMs, type LinkActions } from '../linkModel';
import { useLinkStore } from '../linkStore';
import { useCachedHome, useRefreshHome } from '../useDriverHome';
import { ChangePhoneSheet } from '../vehicles/actions';
import { vehicleActions } from '../vehicles/model';
import { TaskSkeleton, useStoreTicket, useTicket } from './common';

/**
 * While D-07 waits on the server (the W-01 result, the customer's message, the code's expiry) it reads the
 * ticket again every few seconds besides `ticket.updated` (07 §4.3 «أحداث الواجهة … لا تُعتبر مصدر حقيقة»):
 * a driver who issued the QR of a ticket he did not create gets no event for it (docs/progress/notes/
 * driver-gaps.md).
 */
export const LINK_POLL_MS = 4000;

/**
 * D-07 — ربط واتساب (02 D-07): أ the direct send to the customer's number (status, «إعادة الإرسال», «الربط عبر
 * QR», «تذكرة ورقية»), ب the customer-brand QR panel the customer scans with «هل هو جوال العميل الذي أمامك؟», ج the paper
 * stub. «متابعة إلى الصف» is never blocked; reached again from D-13 «إعادة الربط بواتساب» («العودة» there).
 */
export function IntakeLinkPage() {
  const { ticketId = '' } = useParams();
  const ticket = useTicket(ticketId);
  if (ticket.data) {
    if (ticket.data.status === 'received')
      return <Navigate to={driverPaths.intakeKeyPhotos(ticketId)} replace />;
    return <LinkStep ticket={ticket.data} />;
  }
  if (ticket.error)
    return <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} backTo={paths.driverHome} />;
  return <TaskSkeleton />;
}

const SENDING: readonly WaLinkStatus[] = ['pending_send', 'linked'];

const CHIP: Record<WaLinkStatus, [ChipTone, LucideIcon]> = {
  none: ['neutral', Info],
  pending_send: ['info', Hourglass],
  pending_confirmation: ['warning', Hourglass],
  linked: ['success', CircleCheck],
  failed: ['danger', CircleX],
  opted_out: ['warning', CircleX],
};

/** The link status of 02 D-07 «جارٍ الإرسال…» ← «أُرسلت» ← «تعذر الإرسال» (the other states: canon §8.1). */
function LinkStatusChip({ status }: { status: WaLinkStatus }) {
  const [tone, icon] = CHIP[status];
  const label = (d07.status as Partial<Record<WaLinkStatus, string>>)[status] ?? waLinkStatus[status];
  return <StateChip label={label} tone={tone} icon={icon} />;
}

/** The QR drawn on the device from the reply's `qr_text` (03 §3.13: error correction M, 4-module margin). */
function useQrSvg(text: string | null): string | null {
  const [svg, setSvg] = useState<{ text: string; svg: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let active = true;
    void QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }).then((s) => {
      if (active) setSvg({ text, svg: s });
    });
    return () => {
      active = false;
    };
  }, [text]);
  return text && svg?.text === text ? svg.svg : null;
}

type SheetKind = 'notReceived' | 'changeMethod' | 'paper' | 'phone' | null;

function LinkStep({ ticket }: { ticket: TicketDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useDriverMe();
  const home = useCachedHome();
  const refresh = useRefreshHome();
  const gate = useCommandGate();
  const storeTicket = useStoreTicket();
  const chosen = useLinkStore((s) => s.method[ticket.id]);
  const qr = useLinkStore((s) => s.qr[ticket.id]);
  const notedPending = useLinkStore((s) => s.pending[ticket.id]);
  const now = useServerNow(1000);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [confirmedHere, setConfirmedHere] = useState(false);
  const [stubGiven, setStubGiven] = useState(false);
  /** A pending confirmation the server refused to settle here (expired, not this driver's code). */
  const [dismissed, setDismissed] = useState<string | null>(null);

  const status = ticket.wa_link_status;
  const mode = linkMode(ticket, chosen, !!qr);
  const actions = linkActions(ticket);
  const qrLeft = qr ? qrRemainingMs(qr, now) : 0;
  const qrLive = !!qr && qr.status === 'active' && qrLeft > 0;
  const waiting =
    mode === 'qr'
      ? status === 'pending_confirmation' || qrLive
      : mode === 'direct' && status === 'pending_send';
  useTicket(ticket.id, { poll: waiting ? LINK_POLL_MS : false });

  const pending = ticket.wa_link_pending ?? notedPending ?? null;
  const pendingCodeId =
    status === 'pending_confirmation' ? (pending?.link_code_id ?? qr?.link_code_id ?? null) : null;
  const confirmOpen = !!pendingCodeId && pendingCodeId !== dismissed;
  // this screen shows the send state itself: the frame's «تعذر إرسال تذكرة #n» notice goes (02 D-07)
  useEffect(() => {
    useFieldStore.getState().dismissNotice(`waFailed:${ticket.id}`);
  }, [ticket.id, ticket.version]);
  // the panel never keeps a code the server already moved on from (confirmed, rejected, revoked)
  useEffect(() => {
    if (qr && (status === 'linked' || status === 'pending_send' || ticket.channel === 'paper'))
      useLinkStore.getState().setQr(ticket.id, null);
  }, [qr, status, ticket.channel, ticket.id]);

  const parkTask =
    ticket.open_task && (ticket.open_task.type === 'park' || ticket.open_task.type === 'repark')
      ? ticket.open_task.id
      : home?.current_task?.ticket.id === ticket.id
        ? home.current_task.task.id
        : null;
  const onward = parkTask
    ? { label: d07.toParking, go: () => navigate(driverPaths.park(parkTask)) }
    : { label: buttons.back, go: () => navigate(`${paths.driverVehicles}/${ticket.id}`) };

  const afterCommand = (updated?: TicketDetail) => {
    if (updated) storeTicket(updated);
    else void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
    void refresh();
  };
  const onCommandError = (error: unknown) => {
    if (isApiError(error, 'VERSION_CONFLICT', 'INVALID_STATE_TRANSITION', 'WA_NOT_LINKED'))
      void qc.invalidateQueries({ queryKey: queryKeys.ticket(ticket.id) });
  };

  const direct = useCommand((body: { method: 'direct' }, key: string) => linkWhatsApp(ticket.id, body, key));
  const issue = useCommand((body: { method: 'qr' }, key: string) => linkWhatsApp(ticket.id, body, key));
  const confirm = useCommand((body: { link_code_id: string; matches: boolean }, key: string) =>
    confirmWhatsAppLink(ticket.id, body, key),
  );
  const commandError = [direct.error, issue.error].find(Boolean);

  const resend = async () => {
    setSheet(null);
    issue.reset();
    try {
      await direct.run({ method: 'direct' });
      useLinkStore.getState().setMethod(ticket.id, 'direct');
      setConfirmedHere(false);
      afterCommand(); // pending_send: version + 1 — the ticket is read again
    } catch (error) {
      onCommandError(error);
    }
  };
  const newQr = async () => {
    setSheet(null);
    direct.reset();
    try {
      const result = await issue.run({ method: 'qr' });
      const links = useLinkStore.getState();
      if (result.qr) links.setQr(ticket.id, result.qr);
      links.setMethod(ticket.id, 'qr');
      setDismissed(null);
    } catch (error) {
      onCommandError(error);
    }
  };
  const answer = async (matches: boolean) => {
    if (!pendingCodeId) return;
    try {
      const updated = await confirm.run({ link_code_id: pendingCodeId, matches });
      useLinkStore.getState().setQr(ticket.id, null); // used (yes) or revoked (no): «رمز جديد» next
      useLinkStore.getState().notePending(ticket.id, null);
      setConfirmedHere(matches);
      afterCommand(updated);
    } catch (error) {
      // the code expired, is not this driver's, or is gone: the dialog closes, the message stays on screen
      if (isApiError(error, 'WA_LINK_CODE_EXPIRED', 'RESOURCE_NOT_FOUND', 'PERMISSION_DENIED'))
        setDismissed(pendingCodeId);
      onCommandError(error);
      afterCommand();
    }
  };

  const optionButtons = (
    <LinkOptions
      actions={actions}
      disabled={!gate.ready}
      resendLoading={direct.pending}
      qrLoading={issue.pending}
      onResend={resend}
      onQr={newQr}
      onPaper={() => setSheet('paper')}
    />
  );
  const canChangePhone = vehicleActions(me, ticket).changePhone;
  const digits = phoneTail(ticket.customer?.phone_masked);

  let body: ReactNode;
  if (mode === 'paper') {
    body = (
      <>
        <p className="m-0 text-lg">
          {fmtNode(d07.paperText, { serial: <Ltr>{ticket.paper_serial ?? ''}</Ltr> })}
        </p>
        <Checkbox
          id="stub-given"
          label={d07.stubGiven}
          checked={stubGiven}
          onChange={(e) => setStubGiven(e.target.checked)}
        />
      </>
    );
  } else if (mode === 'direct' || SENDING.includes(status)) {
    // الوضع أ — and the QR mode once the customer was confirmed (W-01 on its way)
    body = (
      <>
        <LinkStatusChip status={status} />
        {SENDING.includes(status) ? (
          <>
            <p className="m-0 text-lg" data-link-sent>
              {confirmedHere || mode === 'qr'
                ? d07.linked
                : digits
                  ? fmtNode(d07.sentTo, { digits: <Ltr>{digits}</Ltr> })
                  : null}
            </p>
            <p className="m-0 text-text-muted">{d07.sentHint}</p>
          </>
        ) : null}
        {status === 'failed' ? <Banner kind="error" rounded message={d07.failed} /> : null}
        {status === 'opted_out' ? <Banner kind="warning" rounded message={live.optedOut} /> : null}
        {!SENDING.includes(status) ? optionButtons : null}
      </>
    );
  } else {
    // الوضع ب — the customer panel, then the driver area
    body = (
      <>
        {status === 'failed' ? <Banner kind="error" rounded message={d07.failed} /> : null}
        {status === 'opted_out' ? <Banner kind="warning" rounded message={live.optedOut} /> : null}
        <QrArea
          ticketNumber={ticket.display_number}
          venue={ticket.venue_name_ar ?? home?.venue?.name_ar ?? ''}
          qrText={qr && qr.status === 'active' ? qr.qr_text : null}
          left={qrLeft}
          fullscreen={fullscreen}
          onExitFullscreen={() => setFullscreen(false)}
        />
        <div className="flex flex-wrap gap-2" data-driver-area>
          {actions.qr ? (
            <Button
              variant={qrLive ? 'secondary' : 'primary'}
              loading={issue.pending}
              disabled={!gate.ready}
              onClick={newQr}
            >
              {d07.newCode}
            </Button>
          ) : null}
          {actions.paper || canChangePhone ? (
            <Button variant="secondary" onClick={() => setSheet('changeMethod')}>
              {d07.changeMethod}
            </Button>
          ) : null}
          {qrLive ? (
            <Button variant="secondary" iconStart={Maximize} onClick={() => setFullscreen(true)}>
              {d07.fullscreen}
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <section className="flex flex-col gap-4" data-link-mode={mode} data-link-status={status}>
      <Header title={withTicket(mode === 'paper' ? d07.paperTitle : d07.title, ticket.display_number)} />
      {body}
      {commandError ? (
        <FieldError id="link-error" role="alert">
          {displayMessage(commandError)}
        </FieldError>
      ) : null}
      {confirm.error && !confirmOpen ? (
        <FieldError id="confirm-error" role="alert">
          {displayMessage(confirm.error)}
        </FieldError>
      ) : null}
      <Button size="lg" id="to-parking" onClick={onward.go}>
        {onward.label}
      </Button>
      {mode === 'direct' && SENDING.includes(status) ? (
        <button type="button" className="pt-link self-center" onClick={() => setSheet('notReceived')}>
          {d07.notReceived}
        </button>
      ) : null}

      <Sheet
        open={sheet === 'notReceived'}
        onOpenChange={(o) => setSheet(o ? 'notReceived' : null)}
        title={d07.notReceived}
      >
        <div className="flex flex-col gap-4">
          <p className="m-0">{d07.notReceivedHint}</p>
          {optionButtons}
          {canChangePhone ? (
            <Button variant="secondary" fullWidth onClick={() => setSheet('phone')}>
              {d13.changePhone}
            </Button>
          ) : null}
        </div>
      </Sheet>
      <Sheet
        open={sheet === 'changeMethod'}
        onOpenChange={(o) => setSheet(o ? 'changeMethod' : null)}
        title={d07.changeMethod}
      >
        <div className="flex flex-col gap-3">
          {canChangePhone ? (
            <Button variant="secondary" fullWidth onClick={() => setSheet('phone')}>
              {d05.methods.direct}
            </Button>
          ) : null}
          {actions.paper ? (
            <Button variant="secondary" fullWidth onClick={() => setSheet('paper')}>
              {d07.paper}
            </Button>
          ) : null}
        </div>
      </Sheet>
      <PaperSheet
        ticket={ticket}
        open={sheet === 'paper'}
        onOpenChange={(o) => setSheet(o ? 'paper' : null)}
        onDone={(updated) => {
          useLinkStore.getState().setQr(ticket.id, null);
          setFullscreen(false);
          afterCommand(updated);
        }}
      />
      {sheet === 'phone' ? (
        <ChangePhoneSheet
          ticket={ticket}
          open
          onOpenChange={(o) => setSheet(o ? 'phone' : null)}
          onDone={(updated) => {
            const links = useLinkStore.getState();
            links.setQr(ticket.id, null);
            links.setMethod(ticket.id, 'direct');
            setConfirmedHere(false);
            setFullscreen(false);
            afterCommand(updated);
          }}
        />
      ) : null}

      <Dialog
        open={confirmOpen}
        id="wa-confirm"
        title={
          phoneTail(pending?.inbound_phone_masked)
            ? fmtNode(d07.confirmTitle, { digits: <Ltr>{phoneTail(pending?.inbound_phone_masked)}</Ltr> })
            : d07.confirmTitleUnknown
        }
        body={d07.confirmQuestion}
        hideCancel
        error={confirm.error ? displayMessage(confirm.error) : undefined}
        onDismiss={() => undefined}
      >
        <div className="pt-dialog__actions">
          <Button
            size="lg"
            fullWidth
            loading={confirm.pending}
            disabled={!gate.ready}
            onClick={() => answer(true)}
          >
            {d07.confirmYes}
          </Button>
          <Button
            variant="secondary"
            fullWidth
            disabled={!gate.ready || confirm.pending}
            onClick={() => answer(false)}
          >
            {d07.confirmNo}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/** «إعادة الإرسال │ الربط عبر QR │ تذكرة ورقية» — the ones the server takes now (07 `linkWhatsApp`, DEC-40). */
function LinkOptions({
  actions,
  disabled,
  resendLoading,
  qrLoading,
  onResend,
  onQr,
  onPaper,
}: {
  actions: LinkActions;
  disabled: boolean;
  resendLoading: boolean;
  qrLoading: boolean;
  onResend: () => void;
  onQr: () => void;
  onPaper: () => void;
}) {
  if (!actions.resend && !actions.qr && !actions.paper) return null;
  return (
    <div className="flex flex-wrap gap-2" data-link-options>
      {actions.resend ? (
        <Button variant="secondary" loading={resendLoading} disabled={disabled} onClick={onResend}>
          {d07.resend}
        </Button>
      ) : null}
      {actions.qr ? (
        <Button variant="secondary" loading={qrLoading} disabled={disabled} onClick={onQr}>
          {d07.viaQr}
        </Button>
      ) : null}
      {actions.paper ? (
        <Button variant="secondary" disabled={disabled} onClick={onPaper}>
          {d07.paper}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The customer panel (02 D-07 ب): the code with its countdown, «بانتظار رسالتك…», «انتهت صلاحية الرمز.» at
 * zero; «ملء الشاشة» shows the panel alone, «إغلاق» in the corner or a long press brings the driver area back.
 */
function QrArea({
  ticketNumber,
  venue,
  qrText,
  left,
  fullscreen,
  onExitFullscreen,
}: {
  ticketNumber: number;
  venue: string;
  qrText: string | null;
  left: number;
  fullscreen: boolean;
  onExitFullscreen: () => void;
}) {
  const svg = useQrSvg(qrText);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expired = !!qrText && left <= 0;
  useEffect(() => {
    if (expired && fullscreen) onExitFullscreen();
  }, [expired, fullscreen, onExitFullscreen]);
  if (!qrText || !svg) {
    return (
      <p className="m-0 text-text-muted" data-qr-none>
        {qrText ? ui.loading : d07.noCode}
      </p>
    );
  }
  const ttl = formatClock(left / 1000);
  const panel = (
    <QrPanel
      qrSvg={svg}
      expired={expired}
      meta={fmtNode(d07.qrMeta, { venue, n: ticketNumber, ttl: <Ltr>{ttl}</Ltr> })}
      status={d07.waiting}
    />
  );
  const endPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border" data-qr-panel>
        {panel}
      </div>
      {expired ? <Banner kind="warning" rounded message={d07.expired} /> : null}
      {fullscreen ? (
        <div
          className="pt-qr-full"
          role="dialog"
          aria-modal="true"
          aria-label={d07.fullscreen}
          data-qr-fullscreen
          onPointerDown={() => {
            endPress();
            press.current = setTimeout(onExitFullscreen, 800);
          }}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onPointerCancel={endPress}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onExitFullscreen();
          }}
        >
          <IconButton
            icon={X}
            label={buttons.close}
            className="pt-qr-full__close"
            autoFocus
            onClick={onExitFullscreen}
          />
          {panel}
        </div>
      ) : null}
    </>
  );
}

/**
 * «تذكرة ورقية» from D-07 (DEC-40): the stub number → `PATCH …/intake {channel: paper, paper_serial}` while
 * the ticket is `parking` and not linked; the earlier messages' buttons stop working (link_version + 1).
 */
function PaperSheet({
  ticket,
  open,
  onOpenChange,
  onDone,
}: {
  ticket: TicketDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (updated?: TicketDetail) => void;
}) {
  const gate = useCommandGate();
  const [serial, setSerial] = useState('');
  const [checked, setChecked] = useState(false);
  const cmd = useCommand((body: IntakePatch, key: string) => patchIntake(ticket.id, body, key));
  const inUse = isApiError(cmd.error, 'PAPER_SERIAL_IN_USE') ? displayMessage(cmd.error) : undefined;
  const other = cmd.error && !inUse ? displayMessage(cmd.error) : undefined;
  const submit = async () => {
    setChecked(true);
    if (!serial.trim()) return;
    try {
      const updated = await cmd.run({
        expected_version: ticket.version,
        channel: 'paper',
        paper_serial: serial.trim(),
      });
      onOpenChange(false);
      onDone(updated);
    } catch (error) {
      if (error instanceof ApiError && error.is('VERSION_CONFLICT', 'INVALID_STATE_TRANSITION')) onDone();
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d07.paper}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          id="convert-paper-serial"
          label={d05.paperSerial}
          hint={d05.paperHint}
          placeholder={d05.paperSerialPlaceholder}
          value={serial}
          maxLength={20}
          autoComplete="off"
          dir="ltr"
          error={checked && !serial.trim() ? ui.validation : inUse}
          onChange={(e) => {
            setSerial(e.target.value);
            if (cmd.error) cmd.reset();
          }}
        />
        {other ? (
          <FieldError id="convert-paper-error" role="alert">
            {other}
          </FieldError>
        ) : null}
        <Button type="submit" fullWidth size="lg" loading={cmd.pending} disabled={!gate.ready}>
          {buttons.confirm}
        </Button>
      </form>
    </Sheet>
  );
}
