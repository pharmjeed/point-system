import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { d01 } from '@/i18n/ar';
import { Field } from './Field';
import { Icon } from './Icon';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'id'> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  loading?: boolean;
  icon?: LucideIcon;
  /** Password/PIN with a «إظهار» toggle (D-01). The value stays in component state only. */
  revealable?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * Text field (03 §3.10): 48px, 16px text (iOS zoom rule), label always above, error below with
 * `aria-describedby`. Border --pt-border-strong (≥3:1, DEC-50), --pt-primary + focus ring on focus.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  loading,
  icon,
  revealable,
  disabled,
  type = 'text',
  ref,
  ...inputProps
}: TextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const effectiveType = revealable ? (revealed ? 'text' : 'password') : type;
  return (
    <Field id={id} label={label} hint={hint} error={error} disabled={disabled}>
      {(describedBy) => (
        <div className="pt-input">
          {icon ? <Icon icon={icon} size={20} className="pt-input__icon" /> : null}
          <input
            {...inputProps}
            ref={ref}
            id={id}
            type={effectiveType}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
          {loading ? <Icon icon={LoaderCircle} size={20} spin className="pt-input__icon" /> : null}
          {revealable ? (
            <button
              type="button"
              className="pt-input__reveal"
              aria-pressed={revealed}
              aria-controls={id}
              disabled={disabled}
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? d01.hide : d01.reveal}
            </button>
          ) : null}
        </div>
      )}
    </Field>
  );
}
