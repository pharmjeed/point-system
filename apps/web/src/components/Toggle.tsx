import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface ToggleProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** On/off `role="switch"`, 52×32 track inside a 44px target (03 §3.10) — e.g. «استراحة» in D-14. */
export function Toggle({ id, label, hint, checked, onChange, disabled }: ToggleProps) {
  return (
    <label className={cx('pt-toggle', disabled && 'is-disabled')} htmlFor={id}>
      <span className="pt-toggle__text">
        <span className="pt-toggle__label">{label}</span>
        {hint ? <span className="pt-field__hint">{hint}</span> : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="pt-toggle__track" aria-hidden="true">
        <span className="pt-toggle__thumb" />
      </span>
    </label>
  );
}
