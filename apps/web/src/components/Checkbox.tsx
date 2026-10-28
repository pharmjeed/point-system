import { Check } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '@/lib/cx';
import { FieldError } from './Field';
import { Icon } from './Icon';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** 24px box inside a 44px target, label beside it (03 §3.10). */
export function Checkbox({ id, label, hint, error, disabled, ref, ...rest }: CheckboxProps) {
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cx('pt-check', error ? 'has-error' : null, disabled && 'is-disabled')}>
      <label className="pt-check__row" htmlFor={id}>
        <input
          {...rest}
          ref={ref}
          id={id}
          type="checkbox"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <span className="pt-check__box" aria-hidden="true">
          <Icon icon={Check} size={16} />
        </span>
        <span className="pt-check__label">{label}</span>
      </label>
      {hint && !error ? (
        <p className="pt-field__hint pt-check__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <div className="pt-check__hint">
          <FieldError id={`${id}-err`}>{error}</FieldError>
        </div>
      ) : null}
    </div>
  );
}
