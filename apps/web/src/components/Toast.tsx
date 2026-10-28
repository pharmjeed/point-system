import { CircleCheck, CircleX, Info } from 'lucide-react';
import { useEffect } from 'react';
import { cx } from '@/lib/cx';
import { useUiStore, type ToastItem, type ToastTone } from '@/stores/ui';
import { Icon } from './Icon';

const TONE_ICON = { success: CircleCheck, error: CircleX, info: Info } as const;

export interface ToastProps {
  message: string;
  tone?: ToastTone;
}

/** Transient message (03 §3.14): inverse surface, never vibrates. */
export function Toast({ message, tone = 'success' }: ToastProps) {
  return (
    <div className={cx('pt-toast', `pt-toast--${tone}`)} data-tone={tone}>
      <Icon icon={TONE_ICON[tone]} />
      <span>{message}</span>
    </div>
  );
}

function TimedToast({ toast }: { toast: ToastItem }) {
  const dismiss = useUiStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismiss]);
  return <Toast message={toast.message} tone={toast.tone} />;
}

/**
 * The polite live region for toasts, bottom of the screen above BottomNav (03 §3.14). Always mounted so
 * screen readers pick up new messages.
 */
export function ToastViewport({ aboveNav = false }: { aboveNav?: boolean }) {
  const toasts = useUiStore((s) => s.toasts);
  return (
    <div
      className={cx('pt-toastlayer', aboveNav && 'pt-toastlayer--above-nav')}
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <TimedToast key={t.id} toast={t} />
      ))}
    </div>
  );
}
