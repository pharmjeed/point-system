import { CircleCheck, CirclePause, CircleSlash, CircleX, Copy, FlaskConical, Mail } from 'lucide-react';
import type { OperatorContract, OperatorStatus } from '@/api/platform';
import { Button, Dialog } from '@/components';
import { StateChip } from '@/features/common/StateChip';
import { buttons } from '@/i18n/ar';
import { operatorStatus, p02, p03 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatHalalas } from '@/lib/format';
import { useUiStore } from '@/stores/ui';
import { OPERATOR_TONE, bpToPercent } from './platformModel';

const ICON = {
  invited: Mail,
  trial: FlaskConical,
  active: CircleCheck,
  suspended: CirclePause,
  terminated: CircleX,
} as const;

/** Operator status: text + tone + icon, never colour alone (03 §3.3). */
export function OperatorStatusChip({ status }: { status: OperatorStatus }) {
  return (
    <StateChip
      label={operatorStatus[status] ?? status}
      tone={OPERATOR_TONE[status] ?? 'neutral'}
      icon={ICON[status] ?? CircleSlash}
    />
  );
}

/** «500.00 ر.س · شهري · 2.50%» — one contract on a line. */
export function contractLine(c: OperatorContract): string {
  return `${formatHalalas(c.saas_fee_halalas_per_venue)} · ${p03.cycle[c.saas_cycle]} · ${bpToPercent(c.app_payment_commission_bp)}`;
}

/** `[from → to)` in the platform's dates (YYYY-MM-DD, Latin digits). */
export function contractPeriod(c: Pick<OperatorContract, 'starts_on' | 'ends_on'>): string {
  return fmt(p03.period, { from: c.starts_on, to: c.ends_on ?? p03.openEnded });
}

/**
 * The operator owner's temporary password, shown once (DEC-485): it lives in the caller's state only — never in a
 * query cache, the URL or browser storage — and is gone when the dialog closes. A replayed answer carries no
 * password: the dialog then says so and points to the reissue on P-03.
 */
export function OneTimePasswordDialog({
  id,
  open,
  title,
  password,
  owner,
  replayedText,
  actionLabel,
  onAction,
  onClose,
}: {
  id: string;
  open: boolean;
  title: string;
  password: string | null;
  owner: { full_name: string; employee_code: string } | null;
  replayedText: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}) {
  const pushToast = useUiStore((s) => s.pushToast);
  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      pushToast({ message: p02.created.copied, tone: 'success' });
    } catch {
      pushToast({ message: p02.created.copyFailed, tone: 'error' });
    }
  };
  return (
    <Dialog
      id={id}
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      body={
        password
          ? fmt(p02.created.body, { owner: owner?.full_name ?? '', code: owner?.employee_code ?? '' })
          : replayedText
      }
      confirmLabel={actionLabel ?? buttons.gotIt}
      cancelLabel={actionLabel ? buttons.gotIt : undefined}
      hideCancel={!actionLabel}
      onConfirm={onAction ?? onClose}
      onCancel={onClose}
    >
      {password ? (
        <div className="st-row-actions" data-testid={`${id}-password`}>
          <code className="pt-num font-bold" dir="ltr">
            {password}
          </code>
          <Button variant="secondary" compact iconStart={Copy} onClick={() => void copy()}>
            {p02.created.copy}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
