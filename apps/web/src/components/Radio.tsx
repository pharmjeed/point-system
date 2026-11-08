import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { FieldError } from './Field';

export interface RadioProps {
  name: string;
  legend?: ReactNode;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  value?: string;
  onChange?: (value: string) => void;
  error?: ReactNode;
  disabled?: boolean;
}

/** Single choice inside fieldset + legend (03 §3.10). */
export function Radio({ name, legend, options, value, onChange, error, disabled }: RadioProps) {
  return (
    <fieldset className={cx('pt-radio', error ? 'has-error' : null)} disabled={disabled}>
      {legend ? <legend className="pt-field__label">{legend}</legend> : null}
      {options.map(([optionValue, text]) => {
        const id = `${name}-${optionValue}`;
        return (
          <label key={optionValue} className="pt-radio__row" htmlFor={id}>
            <input
              id={id}
              type="radio"
              name={name}
              value={optionValue}
              checked={value === optionValue}
              onChange={() => onChange?.(optionValue)}
            />
            <span className="pt-radio__dot" aria-hidden="true" />
            <span>{text}</span>
          </label>
        );
      })}
      {error ? <FieldError>{error}</FieldError> : null}
    </fieldset>
  );
}
