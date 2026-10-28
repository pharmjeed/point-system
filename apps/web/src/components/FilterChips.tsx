import { Check } from 'lucide-react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

export interface FilterChipsProps {
  options: FilterOption[];
  value: string[];
  onChange: (value: string[]) => void;
  label?: string;
  disabled?: boolean;
}

/** Status filters with counts (03 §3.9); selected = --pt-primary-subtle + --pt-primary border + check. */
export function FilterChips({
  options,
  value,
  onChange,
  label = components.filters,
  disabled,
}: FilterChipsProps) {
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="pt-filters" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={cx('pt-filter', on && 'is-on')}
            aria-pressed={on}
            disabled={disabled || o.disabled}
            onClick={() => toggle(o.value)}
          >
            {on ? <Icon icon={Check} size={16} /> : null}
            <span>{o.label}</span>
            {o.count !== undefined ? <span className="pt-filter__count">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
