import { LoaderCircle } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { components } from '@/i18n/ar';
import { Field } from './Field';
import { Icon } from './Icon';

export interface PhoneInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'size'> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  loading?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * Saudi mobile (03 §3.8): fixed +966 prefix, the whole field LTR, 16px. Accepts 05XXXXXXXX or 5XXXXXXXX;
 * the caller normalises to E.164 with `normalizeSaudiMobile` and shows `PHONE_INVALID` under the field.
 * No autofill by default: most numbers typed here are someone else's (a customer's, a new driver's), and
 * the browser would offer the device owner's own (05 §14.2); the sign-in pages pass `autoComplete="username"`.
 */
export function PhoneInput({
  id,
  label,
  hint,
  error,
  loading,
  disabled,
  ref,
  ...inputProps
}: PhoneInputProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} disabled={disabled}>
      {(describedBy) => (
        <div className="pt-input pt-phone" dir="ltr">
          <span className="pt-phone__prefix" aria-hidden="true">
            {components.phonePrefix}
          </span>
          <input
            inputMode="tel"
            autoComplete="off"
            {...inputProps}
            ref={ref}
            id={id}
            type="tel"
            dir="ltr"
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
          {loading ? <Icon icon={LoaderCircle} size={20} spin className="pt-input__icon" /> : null}
        </div>
      )}
    </Field>
  );
}
