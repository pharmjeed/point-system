import { ArrowRight, SearchX, ShieldX } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, displayMessage } from '@/api/errors';
import { paths } from '@/app/paths';
import { Banner, Dialog, EmptyState, FieldError, Header, Skeleton } from '@/components';
import { buttons, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import './staff.css';

/** Shared building blocks of the staff screens (02 §1.6 states, 03 §3.14 dialogs). */

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/**
 * Tab row for the S-02 / S-03 sections (02 S-02 `[Tabs]`). Not a 03 §3 component: a `role="tablist"` of
 * FilterChips-styled buttons (≥44px, wraps — no horizontal scroll), arrow keys follow the reading direction.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (i: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const step =
      e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')
        ? 1
        : e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={cx('st-tabs', className)} role="tablist" aria-label={label}>
      {items.map((item, i) => {
        const on = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={on ? 0 : -1}
            className={cx('pt-filter', on && 'is-on')}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(i, e)}
          >
            <span>{item.label}</span>
            {item.count !== undefined ? <span className="pt-filter__count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 02 §1.6 «الخطأ»: Banner with the error text, «إعادة المحاولة» and «رمز المتابعة». */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Banner
      kind="error"
      rounded
      message={displayMessage(error)}
      detail={requestId ? fmt(ui.requestId, { id: requestId }) : undefined}
      actionLabel={onRetry ? buttons.retry : undefined}
      onAction={onRetry}
    />
  );
}

/** 02 §1.6 «التحميل الأول»: skeletons shaped like the content, never a spinner. */
export function PageSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="st-stack">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} withAction={i === 0} />
      ))}
    </div>
  );
}

/** 02 §1.6 «عدم الصلاحية»: «لا تملك صلاحية عرض هذه الصفحة.» + «العودة». */
export function ForbiddenState({ backTo = paths.ops }: { backTo?: string }) {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={ShieldX}
      title={ui.forbiddenPage}
      actionLabel={buttons.back}
      actionIcon={ArrowRight}
      onAction={() => navigate(backTo)}
    />
  );
}

/**
 * A whole page the user may not open: its h1 stays (a top-level destination's title, or the `Header` of a
 * sub-page when `onBack` is given), then the forbidden state.
 */
export function ForbiddenPage({
  title,
  backTo,
  onBack,
}: {
  title: string;
  backTo?: string;
  onBack?: () => void;
}) {
  return (
    <div className="st-page">
      {onBack ? (
        <Header title={title} onBack={onBack} />
      ) : (
        <div className="st-head">
          <h1 className="pt-page-title">{title}</h1>
        </div>
      )}
      <ForbiddenState backTo={backTo} />
    </div>
  );
}

/** 02 §1.9 RESOURCE_NOT_FOUND / TICKET_NOT_FOUND: EmptyState + «العودة». */
export function NotFoundState({ backTo = paths.ops }: { backTo?: string }) {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={SearchX}
      title={ui.notFound}
      actionLabel={buttons.back}
      actionIcon={ArrowRight}
      onAction={() => navigate(backTo)}
    />
  );
}

export const isNotFound = (error: unknown) =>
  error instanceof ApiError && ['TICKET_NOT_FOUND', 'RESOURCE_NOT_FOUND'].includes(error.code);
export const isForbidden = (error: unknown) =>
  error instanceof ApiError && ['PERMISSION_DENIED', 'SCOPE_VENUE_DENIED'].includes(error.code);

/** Error/empty handling for a read: not found and forbidden get their own states (02 §1.6, §1.9). */
export function ReadError({
  error,
  onRetry,
  backTo,
}: {
  error: unknown;
  onRetry?: () => void;
  backTo?: string;
}) {
  if (isNotFound(error)) return <NotFoundState backTo={backTo} />;
  if (isForbidden(error)) return <ForbiddenState backTo={backTo} />;
  return <QueryError error={error} onRetry={onRetry} />;
}

/** Minimum reason length (07: `minLength: 3`; 08 §4.16 `REASON_REQUIRED`). */
export const REASON_MIN = 3;
export const reasonOk = (reason: string) => reason.trim().length >= REASON_MIN;

/**
 * Confirmation with the mandatory reason (03 §3.14 Dialog `reasonRequired`). The confirm button stays
 * disabled until the reason has 3+ characters; the server's REASON_REQUIRED / message is shown under it.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  body,
  children,
  confirmLabel,
  destructive,
  pending,
  error,
  reasonError,
  canConfirm = true,
  withReason = true,
  onConfirm,
  id,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  reasonError?: string | null;
  canConfirm?: boolean;
  withReason?: boolean;
  onConfirm: (reason: string) => void | Promise<unknown>;
  id?: string;
}) {
  const auto = useId().replace(/:/g, '');
  const [reason, setReason] = useState('');
  const close = () => {
    setReason('');
    onOpenChange(false);
  };
  return (
    <Dialog
      id={id ?? `dlg-${auto}`}
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      onCancel={close}
      title={title}
      body={body}
      reasonRequired={withReason}
      reason={reason}
      onReasonChange={setReason}
      destructive={destructive}
      confirmLabel={confirmLabel}
      loading={pending}
      disabled={!canConfirm || (withReason && !reasonOk(reason))}
      error={withReason ? (reasonError ?? undefined) : (error ?? undefined)}
      onConfirm={() => onConfirm(reason.trim())}
    >
      {children}
      {withReason && error && !reasonError ? <FieldError role="alert">{error}</FieldError> : null}
    </Dialog>
  );
}

/** A `<dt>/<dd>` pair inside `.st-facts` rows (S-03 rows). */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="st-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Section with a visible title (`.pt-section-title`). */
export function Section({
  title,
  children,
  id,
  className,
  actions,
}: {
  title: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  actions?: ReactNode;
}) {
  const auto = useId().replace(/:/g, '');
  const headingId = `${id ?? auto}-h`;
  return (
    <section className={cx('st-section', className)} aria-labelledby={headingId}>
      <div className="st-head">
        <h2 className="pt-section-title" id={headingId}>
          {title}
        </h2>
        {actions ? <div className="st-head__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
