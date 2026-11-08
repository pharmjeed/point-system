import { ChevronDown } from 'lucide-react';
import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';
import { Field } from './Field';
import { Icon } from './Icon';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: ReactNode;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  ref?: Ref<HTMLSelectElement>;
}

/** Native select, 48px, 16px, label above (03 §3.9). Long lists (spots, slots, events) use Sheet. */
export function Select({
  id,
  label,
  options,
  placeholder,
  hint,
  error,
  disabled,
  ref,
  ...rest
}: SelectProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} disabled={disabled}>
      {(describedBy) => (
        <div className="pt-select">
          <select
            {...rest}
            ref={ref}
            id={id}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          >
            {placeholder ? <option value="">{placeholder}</option> : null}
            {options.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} size={20} className="pt-select__chev" />
        </div>
      )}
    </Field>
  );
}
