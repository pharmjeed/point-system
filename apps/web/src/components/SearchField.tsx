import { LoaderCircle, Search, X } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface SearchFieldProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
}

/** Search by plate digits or ticket number, with a 44px clear button (03 §3.9). */
export function SearchField({
  id,
  value,
  onChange,
  placeholder = components.search.placeholder,
  label = components.search.label,
  loading,
  disabled,
  inputMode,
}: SearchFieldProps) {
  return (
    <div className={cx('pt-search', disabled && 'is-disabled')} role="search">
      <Icon icon={Search} size={20} className="pt-input__icon" />
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
      />
      {loading ? <Icon icon={LoaderCircle} size={20} spin className="pt-input__icon" /> : null}
      {value && !disabled ? (
        <button
          type="button"
          className="pt-search__clear"
          aria-label={components.search.clear}
          onClick={() => onChange('')}
        >
          <Icon icon={X} size={20} />
        </button>
      ) : null}
    </div>
  );
}
