import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface FieldProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
  className?: string;
}

/** Shared field frame (03 §3.10): label above, hint, error below with icon, `aria-describedby` wiring. */
export function Field({ id, label, hint, error, disabled, children, className }: FieldProps) {
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = cx(error ? errorId : null, hint && !error ? hintId : null) || undefined;
  return (
    <div className={cx('pt-field', error ? 'has-error' : null, disabled && 'is-disabled', className)}>
      {label ? (
        <label className="pt-field__label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {children(describedBy)}
      {hint && !error ? (
        <p className="pt-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export function FieldError({ id, children, role }: { id?: string; children: ReactNode; role?: 'alert' }) {
  return (
    <p className="pt-field-error" id={id} role={role}>
      <Icon icon={CircleAlert} size={16} />
      <span>{children}</span>
    </p>
  );
}
