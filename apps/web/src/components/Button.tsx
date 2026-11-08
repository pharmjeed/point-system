import { Check, CircleAlert, LoaderCircle, type LucideIcon } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'reserve';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  variant?: ButtonVariant;
  /** md 48px · lg 56px (driver operational actions, full width by default) — 03 §3.1. */
  size?: 'md' | 'lg';
  /** Spinner + «جارٍ…» + disabled. Also turned on automatically while `onClick` returns a pending promise. */
  loading?: boolean;
  loadingLabel?: string;
  /** Brief success state after the server confirmed (check icon, 600 ms — the caller times it). */
  done?: boolean;
  /** Message under the button (`--pt-danger-text`); the button stays usable for retry. */
  error?: string;
  iconStart?: LucideIcon;
  fullWidth?: boolean;
  compact?: boolean;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * One primary action per screen (03 §1.2). No optimistic UI: the label changes only after the server
 * answered. Operational commands pass a promise-returning onClick (useCommand) and get the pending state
 * for free; a second press while pending is ignored.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  loadingLabel,
  done,
  error,
  iconStart,
  fullWidth,
  compact,
  disabled,
  className,
  children,
  onClick,
  type = 'button',
  id,
  ref,
  ...rest
}: ButtonProps) {
  const [pending, setPending] = useState(false);
  const busy = Boolean(loading || pending);
  const isDisabled = Boolean(disabled || busy);
  const full = fullWidth ?? size === 'lg';
  const iconSize = size === 'lg' ? 24 : 20;
  const errorId = error && id ? `${id}-err` : undefined;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled || !onClick) return;
    const result = onClick(event);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setPending(true);
      (result as Promise<unknown>).then(
        () => setPending(false),
        () => setPending(false),
      );
    }
  };

  const button = (
    <button
      {...rest}
      ref={ref}
      id={id}
      type={type}
      className={cx(
        'pt-btn',
        `pt-btn--${variant}`,
        `pt-btn--${size}`,
        full && 'pt-btn--full',
        compact && 'pt-btn--compact',
        busy && 'is-loading',
        error && 'has-error',
        className,
      )}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      aria-describedby={errorId ?? rest['aria-describedby']}
      onClick={handleClick}
    >
      {busy ? (
        <>
          <Icon icon={LoaderCircle} size={iconSize} spin />
          <span>{loadingLabel ?? components.loadingLabel}</span>
        </>
      ) : (
        <>
          {done ? (
            <Icon icon={Check} size={iconSize} />
          ) : iconStart ? (
            <Icon icon={iconStart} size={iconSize} />
          ) : null}
          <span>{children}</span>
        </>
      )}
    </button>
  );

  if (!error) return button;
  return (
    <div className={cx('pt-btn-wrap', full && 'pt-btn-wrap--full')}>
      {button}
      <p className="pt-field-error" id={errorId} role="alert">
        <Icon icon={CircleAlert} size={16} />
        <span>{error}</span>
      </p>
    </div>
  );
}
