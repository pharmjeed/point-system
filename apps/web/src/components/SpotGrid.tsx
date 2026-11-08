import { Car, Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { onlyDigits } from '@/lib/digits';
import { FieldError } from './Field';
import { Icon } from './Icon';
import { SearchField } from './SearchField';

export interface Spot {
  code: string;
  occupied?: boolean;
}

export interface SpotGridProps {
  spots: Spot[];
  selected?: string;
  onSelect: (code: string) => void;
  label?: string;
  search?: boolean;
  /** When `parking.mode` allows a free-text note instead of a spot (03 §3.15). */
  allowNote?: boolean;
  onNote?: () => void;
  error?: ReactNode;
  disabled?: boolean;
}

/** Spot / key-slot picker (D-08): occupied = grey, disabled, struck through and labelled «مشغول». */
export function SpotGrid({
  spots,
  selected,
  onSelect,
  label = components.spot.choose,
  search = true,
  allowNote,
  onNote,
  error,
  disabled,
}: SpotGridProps) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const visible = q
    ? spots.filter((s) => s.code.includes(q) || onlyDigits(s.code).includes(onlyDigits(q)))
    : spots;
  return (
    <div className={cx('pt-spots', error ? 'has-error' : null)}>
      {search ? (
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={components.spot.search}
          label={components.spot.searchLabel}
        />
      ) : null}
      <div className="pt-spots__grid" role="radiogroup" aria-label={label}>
        {visible.map((s) => {
          const on = s.code === selected;
          return (
            <button
              key={s.code}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={s.occupied || disabled}
              className={cx('pt-spot', on && 'is-on', s.occupied && 'is-occupied')}
              aria-label={s.occupied ? `${s.code} ${components.spot.occupied}` : s.code}
              onClick={() => onSelect(s.code)}
            >
              {on ? <Icon icon={Check} size={16} /> : s.occupied ? <Icon icon={Car} size={16} /> : null}
              <bdi dir="ltr">{s.code}</bdi>
            </button>
          );
        })}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      {allowNote ? (
        <button type="button" className="pt-link" onClick={onNote}>
          {components.spot.note}
        </button>
      ) : null}
    </div>
  );
}
