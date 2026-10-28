import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { onlyDigits } from '@/lib/digits';
import { FieldError } from './Field';
import { LetterPad, type PlateLetter } from './LetterPad';
import { TextField } from './TextField';

export interface PlateInputProps {
  id?: string;
  digits: string;
  letters: PlateLetter[];
  onDigitsChange: (digits: string) => void;
  onLettersChange: (letters: PlateLetter[]) => void;
  /** «لوحة أخرى»: free text `plate_raw`. */
  other?: boolean;
  onOtherChange?: (other: boolean) => void;
  raw?: string;
  onRawChange?: (raw: string) => void;
  showPad?: boolean;
  error?: ReactNode;
  disabled?: boolean;
}

/** Saudi plate: up to 4 digits (numeric keypad, Mono, LTR) + 3 letters from LetterPad (03 §3.7). */
export function PlateInput({
  id = 'plate',
  digits,
  letters,
  onDigitsChange,
  onLettersChange,
  other,
  onOtherChange,
  raw = '',
  onRawChange,
  showPad = true,
  error,
  disabled,
}: PlateInputProps) {
  if (other) {
    return (
      <div className="pt-plateinput">
        <TextField
          id={`${id}-raw`}
          label={components.plate.other}
          hint={components.plate.otherHint}
          value={raw}
          error={error}
          disabled={disabled}
          onChange={(e) => onRawChange?.(e.target.value)}
        />
        <button type="button" className="pt-link" onClick={() => onOtherChange?.(false)}>
          {components.plate.saudi}
        </button>
      </div>
    );
  }
  return (
    <div className={cx('pt-plateinput', error ? 'has-error' : null, disabled && 'is-disabled')}>
      <span className="pt-field__label" id={`${id}-label`}>
        {components.plate.label}
      </span>
      <div className="pt-plateinput__row" dir="ltr">
        <input
          id={`${id}-digits`}
          className="pt-plateinput__digits"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          value={digits}
          placeholder="1234"
          disabled={disabled}
          aria-labelledby={`${id}-label`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => onDigitsChange(onlyDigits(e.target.value).slice(0, 4))}
        />
        <div className="pt-plateinput__letters" dir="rtl" aria-label={components.plate.selected}>
          {[0, 1, 2].map((i) => {
            const l = letters[i];
            return (
              <span key={i} className={cx('pt-plateinput__slot', !l && 'is-empty')}>
                {l ? l[0] : ''}
                {l ? <small>{l[1]}</small> : null}
              </span>
            );
          })}
        </div>
      </div>
      {error ? <FieldError id={`${id}-err`}>{error}</FieldError> : null}
      {showPad ? <LetterPad value={letters} onChange={onLettersChange} disabled={disabled} /> : null}
      <button type="button" className="pt-link" disabled={disabled} onClick={() => onOtherChange?.(true)}>
        {components.plate.other}
      </button>
    </div>
  );
}
