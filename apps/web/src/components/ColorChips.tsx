import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { components, vehicleColor } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { FieldError } from './Field';
import { Icon } from './Icon';

/**
 * Vehicle paint swatches from primitive tokens — the single exception to "semantic roles only" because they
 * depict paint, not UI (DEC-49d). Keys and order: 02 §8.4. navy/yellow/orange are not in the design
 * system's map; they use the nearest existing primitives (see docs/progress/notes/pnt-021.md).
 */
export const VEHICLE_COLOR_SWATCH: Record<keyof typeof vehicleColor, string | null> = {
  white: '--pt-ink-0',
  black: '--pt-ink-950',
  silver: '--pt-ink-300',
  gray: '--pt-ink-500',
  red: '--pt-red-600',
  blue: '--pt-blue-600',
  navy: '--pt-blue-900',
  green: '--pt-green-600',
  beige: '--pt-amber-100',
  brown: '--pt-amber-800',
  gold: '--pt-amber-500',
  yellow: '--pt-amber-400',
  orange: '--pt-orange-400',
  other: null,
};

export type VehicleColorKey = keyof typeof vehicleColor;

export interface ColorChipsProps {
  value?: VehicleColorKey;
  onChange: (value: VehicleColorKey) => void;
  error?: ReactNode;
  disabled?: boolean;
  label?: string;
}

export function ColorChips({ value, onChange, error, disabled, label = components.colors }: ColorChipsProps) {
  const keys = Object.keys(vehicleColor) as VehicleColorKey[];
  return (
    <div className={cx('pt-colors', error ? 'has-error' : null)} role="radiogroup" aria-label={label}>
      {keys.map((key) => {
        const on = key === value;
        const swatch = VEHICLE_COLOR_SWATCH[key];
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            className={cx('pt-color', on && 'is-on')}
            disabled={disabled}
            onClick={() => onChange(key)}
          >
            <span
              className={cx('pt-color__swatch', !swatch && 'pt-color__swatch--other')}
              style={swatch ? { background: `var(${swatch})` } : undefined}
            >
              {on ? <Icon icon={Check} size={20} /> : null}
            </span>
            <span className="pt-color__label">{vehicleColor[key]}</span>
          </button>
        );
      })}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
