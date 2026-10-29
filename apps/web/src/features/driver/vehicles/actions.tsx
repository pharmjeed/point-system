import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import {
  cancelRetrieval,
  changeCustomerPhone,
  getMediaUrl,
  reportIncident,
  requestOnBehalf,
} from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { Media, TicketDetail } from '@/api/types';
import { Button, Checkbox, Dialog, PhoneInput, Radio, Sheet, Skeleton, TextArea } from '@/components';
import { FieldError } from '@/components/Field';
import { useCommand } from '@/hooks/useCommand';
import { buttons, components, d01, d13, mediaKind, onBehalfReason } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { normalizeSaudiMobile } from '@/lib/phone';
import { useCommandGate } from '@/realtime/hooks';
import { useUiStore } from '@/stores/ui';

/**
 * The D-13 actions (02 D-13; PNT-069). Each one is one command with its own Idempotency-Key session
 * (useCommand); the mandatory inputs are checked before sending, the server's 08 text (`message_ar`) is shown
 * after, and every command waits while the data is stale or offline (PNT-065).
 */
const REASON_MIN = 3; // 07: `reason` minLength 3 (REASON_REQUIRED otherwise)
const reasonOk = (reason: string) => reason.trim().length >= REASON_MIN;

interface ActionProps {
  ticket: TicketDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a success: refresh the ticket, the lists and the home snapshot. */
  onDone: (ticket?: TicketDetail) => void;
}

type OnBehalfKey = keyof typeof onBehalfReason;

/** «طلب الإحضار نيابة عن العميل»: a reason from the 02 §8.4 list, «أخرى» with its text. */
export function OnBehalfSheet({ ticket, open, onOpenChange, onDone }: ActionProps) {
  const gate = useCommandGate();
  const pushToast = useUiStore((s) => s.pushToast);
  const [choice, setChoice] = useState<OnBehalfKey | ''>('');
  const [other, setOther] = useState('');
  const reason = choice === 'other' ? other.trim() : choice ? onBehalfReason[choice] : '';
  const cmd = useCommand((body: { reason: string }, key: string) => requestOnBehalf(ticket.id, body, key));
  const submit = async () => {
    try {
      await cmd.run({ reason });
      pushToast({ message: fmt(d13.onBehalfDone, { n: ticket.display_number }), tone: 'success' });
      onOpenChange(false);
      onDone();
    } catch {
      // the 08 text stays under the button (RETRIEVAL_ALREADY_ACTIVE, TICKET_NOT_PARKED, TICKET_CLOSED…)
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d13.onBehalf}>
      <div className="flex flex-col gap-4">
        <Radio
          name="onbehalf-reason"
          legend={components.dialog.reason}
          options={Object.entries(onBehalfReason) as Array<[string, string]>}
          value={choice}
          onChange={(v) => setChoice(v as OnBehalfKey)}
        />
        {choice === 'other' ? (
          <TextArea
            id="onbehalf-other"
            label={components.dialog.reason}
            rows={2}
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
        ) : null}
        {cmd.error ? (
          <FieldError id="onbehalf-error" role="alert">
            {displayMessage(cmd.error)}
          </FieldError>
        ) : null}
        <Button
          fullWidth
          size="lg"
          loading={cmd.pending}
          disabled={!reasonOk(reason) || !gate.ready}
          onClick={submit}
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * «إلغاء طلب الإحضار» before the assignment; after it the server refuses with INVALID_STATE_TRANSITION
 * (`details.reason = driver_cancel_after_assignment`), shown with its `message_ar` like every server answer
 * (DEC-80: no 02 screen text for a server code; docs/progress/notes/s5-web.md DEC-PROPOSED-16).
 */
export function CancelRetrievalDialog({
  ticket,
  cycleId,
  open,
  onOpenChange,
  onDone,
}: ActionProps & { cycleId: string }) {
  const gate = useCommandGate();
  const [reason, setReason] = useState('');
  const cmd = useCommand((body: { reason: string }, key: string) => cancelRetrieval(cycleId, body, key));
  const error = cmd.error ? displayMessage(cmd.error) : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      id="cancel-retrieval"
      title={fmt(d13.cancelTitle, { n: ticket.display_number })}
      reasonRequired
      reason={reason}
      onReasonChange={setReason}
      destructive
      confirmLabel={d13.cancel}
      cancelLabel={buttons.back}
      loading={cmd.pending}
      disabled={!reasonOk(reason) || !gate.ready}
      error={error}
      onConfirm={async () => {
        try {
          await cmd.run({ reason: reason.trim() });
          onOpenChange(false);
          onDone();
        } catch {
          // shown in the dialog
        }
      }}
      onCancel={() => onOpenChange(false)}
    />
  );
}

/**
 * «تغيير رقم الجوال» (02 D-13): the new number, «تحققت من صاحب المركبة أمامي» (a local check, not sent), the
 * customer's consent and a reason → `PATCH /v1/tickets/{ticketId}/customer-phone` with `expected_version`.
 */
export function ChangePhoneSheet({ ticket, open, onOpenChange, onDone }: ActionProps) {
  const gate = useCommandGate();
  const [phone, setPhone] = useState('');
  const [verified, setVerified] = useState(false);
  const [consent, setConsent] = useState(false);
  const [reason, setReason] = useState('');
  const [localPhoneError, setLocalPhoneError] = useState<string | null>(null);
  const cmd = useCommand(
    (
      body: {
        expected_version: number;
        customer_phone: string;
        consent: { method: 'verbal_staff_confirmed'; confirmed: true };
        reason: string;
      },
      key: string,
    ) => changeCustomerPhone(ticket.id, body, key),
  );
  const fieldError = (code: string) =>
    cmd.error instanceof ApiError && cmd.error.code === code ? cmd.error.message_ar : undefined;
  const otherError =
    cmd.error && !['PHONE_INVALID', 'CONSENT_REQUIRED', 'REASON_REQUIRED'].some((c) => fieldError(c))
      ? displayMessage(cmd.error)
      : undefined;
  const submit = async () => {
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) {
      setLocalPhoneError(d01.phoneInvalid);
      return;
    }
    setLocalPhoneError(null);
    try {
      const updated = await cmd.run({
        expected_version: ticket.version,
        customer_phone: e164,
        consent: { method: 'verbal_staff_confirmed', confirmed: true },
        reason: reason.trim(),
      });
      onOpenChange(false);
      onDone(updated);
    } catch (error) {
      if (isApiError(error, 'VERSION_CONFLICT')) onDone(); // re-read; the driver reviews and sends again
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d13.changePhone}>
      <div className="flex flex-col gap-4">
        <PhoneInput
          id="new-phone"
          label={d13.newPhone}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={localPhoneError ?? fieldError('PHONE_INVALID')}
        />
        <Checkbox
          id="phone-verified"
          label={d13.verified}
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
        />
        <Checkbox
          id="phone-consent"
          label={d13.consent}
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          error={fieldError('CONSENT_REQUIRED')}
        />
        <TextArea
          id="phone-reason"
          label={components.dialog.reason}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={fieldError('REASON_REQUIRED')}
        />
        <p className="m-0 text-sm text-text-muted">{d13.phoneNote}</p>
        {otherError ? (
          <FieldError id="phone-error" role="alert">
            {otherError}
          </FieldError>
        ) : null}
        <Button
          fullWidth
          size="lg"
          loading={cmd.pending}
          disabled={!phone.trim() || !verified || !consent || !reasonOk(reason) || !gate.ready}
          onClick={submit}
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

type ReportType = keyof typeof d13.reportTypes;

/** «إبلاغ عن واقعة» — the D-10 Sheet: a type and a mandatory description → `POST /v1/incidents`. */
export function ReportSheet({ ticket, open, onOpenChange }: Omit<ActionProps, 'onDone'>) {
  const gate = useCommandGate();
  const pushToast = useUiStore((s) => s.pushToast);
  const [type, setType] = useState<ReportType | ''>('');
  const [description, setDescription] = useState('');
  const cmd = useCommand((body: { type: ReportType; description: string }, key: string) =>
    reportIncident(
      {
        venue_id: ticket.venue_id,
        event_id: ticket.event_id,
        ticket_id: ticket.id,
        type: body.type,
        description: body.description,
      },
      key,
    ),
  );
  const submit = async () => {
    if (!type) return;
    try {
      await cmd.run({ type, description: description.trim() });
      pushToast({ message: d13.reported, tone: 'success' });
      setType('');
      setDescription('');
      onOpenChange(false);
    } catch {
      // shown under the button
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d13.report}>
      <div className="flex flex-col gap-4">
        <Radio
          name="report-type"
          options={Object.entries(d13.reportTypes) as Array<[string, string]>}
          value={type}
          onChange={(v) => setType(v as ReportType)}
        />
        <TextArea
          id="report-description"
          label={d13.reportDescription}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {cmd.error ? (
          <FieldError id="report-error" role="alert">
            {displayMessage(cmd.error)}
          </FieldError>
        ) : null}
        <Button
          fullWidth
          size="lg"
          loading={cmd.pending}
          disabled={!type || description.trim().length < REASON_MIN || !gate.ready}
          onClick={submit}
        >
          {buttons.confirm}
        </Button>
      </div>
    </Sheet>
  );
}

/** «[الصور]» for the assignee and the creator (09 §5.1): signed URLs of ≤ 5 minutes, in memory only. */
export function PhotosSheet({
  media,
  open,
  onOpenChange,
}: {
  media: Media[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d13.photos}>
      <div className="pt-photogrid">
        {open ? media.map((m) => <SignedPhoto key={m.id} media={m} />) : null}
      </div>
    </Sheet>
  );
}

function SignedPhoto({ media }: { media: Media }) {
  const url = useQuery({
    queryKey: queryKeys.mediaUrl(media.id),
    queryFn: ({ signal }) => getMediaUrl(media.id, signal),
    staleTime: 240_000,
    gcTime: 240_000,
  });
  const angle = mediaKind[media.kind];
  if (!url.data) return <Skeleton />;
  return (
    <figure className="m-0 flex flex-col gap-1">
      <img
        src={url.data.url}
        alt={fmt(components.photo.photoOf, { angle })}
        className="block aspect-[4/3] w-full rounded-md border border-border object-cover"
      />
      <figcaption className="text-sm text-text-muted">{angle}</figcaption>
    </figure>
  );
}
