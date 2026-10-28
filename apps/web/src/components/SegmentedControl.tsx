import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name. */
  label: string;
  disabled?: boolean;
}

/**
 * Two or three exclusive options, each ≥44px (03 §3.9): «واتساب / تذكرة ورقية» (D-05), the theme switch
 * (D-14). A radiogroup with roving focus; arrow keys follow the reading direction.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (index: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number;
    if (e.key === forward) next = (index + 1) % options.length;
    else if (e.key === backward) next = (index - 1 + options.length) % options.length;
    else return;
    e.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={cx('pt-seg', disabled && 'is-disabled')} role="radiogroup" aria-label={label}>
      {options.map((option, i) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx('pt-seg__opt', on && 'is-on')}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
          >
            {option.icon ? <Icon icon={option.icon} size={20} /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
