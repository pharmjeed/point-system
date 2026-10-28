import { Phone } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TicketDetail } from '@/api/types';
import { Button, MaskedPhone, Radio, TextArea } from '@/components';
import { buttons, components, s03 } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { useServerNow } from '@/hooks/useNow';
import { serverNow } from '@/lib/serverClock';
import { commands } from './staffApi';
import { ReasonDialog, reasonOk } from './ui';
import { useStaffCommand } from './useStaffCommand';

/** How long the full number stays visible (02 S-03: «يظهر الرقم كاملًا 60 ثانية مع رابط اتصال ثم يعود مقنّعًا»). */
export const REVEAL_MS = 60_000;

type ReasonKey = keyof typeof s03.reveal.reasons;

/**
 * «الجوال: 05•••••123 │ [إظهار الرقم]» (02 S-03, PNT-077). The reveal asks for a reason from the 02 list
 * («أخرى» → free text) with «يُسجّل هذا الإجراء في سجل التدقيق.», sends `POST /v1/tickets/{id}/reveal-phone`
 * (Idempotency-Key; audited server-side, rate limited), then shows the number for 60 s with a call link.
 * The number lives in this component's state only: never in React Query's cache, the URL, a toast or any
 * browser storage (09 §5.1 rule 2), and it is dropped on unmount or after the 60 s.
 */
export function RevealPhone({ ticket, allowed }: { ticket: TicketDetail; allowed: boolean }) {
  const masked = ticket.customer?.phone_masked ?? null;
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ phone: string; until: number } | null>(null);
  const now = useServerNow(1000);

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  if (!masked) return <span>—</span>;
  if (revealed) {
    const left = Math.max(0, Math.ceil((revealed.until - now) / 1000));
    return (
      <span className="st-reveal" data-testid="revealed-phone">
        <bdi dir="ltr" className="st-reveal__number">
          {revealed.phone}
        </bdi>
        <a className="pt-link" href={`tel:${revealed.phone}`}>
          <Phone size={20} aria-hidden="true" />
          {s03.reveal.call}
        </a>
        <span className="st-muted">{fmt(s03.reveal.remaining, { s: Math.min(left, REVEAL_MS / 1000) })}</span>
      </span>
    );
  }
  return (
    <span className="st-reveal">
      <MaskedPhone phone={masked} />
      {allowed ? (
        <Button variant="ghost" compact onClick={() => setOpen(true)}>
          {s03.revealPhone}
        </Button>
      ) : null}
      {open ? (
        <RevealDialog
          ticketId={ticket.id}
          onClose={() => setOpen(false)}
          onRevealed={(phone) => {
            setOpen(false);
            setRevealed({ phone, until: serverNow() + REVEAL_MS });
          }}
        />
      ) : null}
    </span>
  );
}

function RevealDialog({
  ticketId,
  onClose,
  onRevealed,
}: {
  ticketId: string;
  onClose: () => void;
  onRevealed: (phone: string) => void;
}) {
  const [choice, setChoice] = useState<ReasonKey | ''>('');
  const [text, setText] = useState('');
  const reason = choice === 'other' ? text.trim() : choice ? s03.reveal.reasons[choice] : '';
  const cmd = useStaffCommand(
    (body: { reason: string }, key: string) => commands.revealPhone(ticketId, body, key),
    {
      successMessage: null,
      onSuccess: (r) => onRevealed(r.phone_e164),
      onPermissionDenied: onClose,
    },
  );
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={s03.action.revealPhone}
      body={s03.reveal.audit}
      withReason={false}
      canConfirm={reasonOk(reason)}
      confirmLabel={buttons.confirm}
      pending={cmd.pending}
      error={cmd.fields.reason ?? cmd.message}
      onConfirm={() => cmd.run({ reason })}
      id="reveal"
    >
      <Radio
        name="reveal-reason"
        legend={s03.reveal.reasonLegend}
        options={(Object.keys(s03.reveal.reasons) as ReasonKey[]).map(
          (k) => [k, s03.reveal.reasons[k]] as const,
        )}
        value={choice}
        onChange={(v) => setChoice(v as ReasonKey)}
      />
      {choice === 'other' ? (
        <TextArea
          id="reveal-other"
          label={components.dialog.reason}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
    </ReasonDialog>
  );
}
