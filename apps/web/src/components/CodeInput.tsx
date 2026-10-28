import { CircleAlert, Lock } from 'lucide-react';
import { useRef, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { onlyDigits } from '@/lib/digits';
import { Icon } from './Icon';

export interface CodeInputProps {
  id?: string;
  label?: ReactNode;
  length?: number;
  value: string;
  onChange: (value: string) => void;
  /** From `details.attempts_left`. */
  attemptsLeft?: number;
  error?: ReactNode;
  /** `HANDOVER_CODE_LOCKED`: cells disabled, «تواصل مع المشرف». */
  locked?: boolean;
  disabled?: boolean;
  /** `off` for the handover code (D-11); `one-time-code` for TOTP (S-01). */
  autoComplete?: 'off' | 'one-time-code';
  autoFocus?: boolean;
}

/**
 * Six numeric cells in IBM Plex Mono 600 24px (03 §3.11). Never pre-filled and never shows a code from the
 * server. Supports paste. No auto-submit when complete: the caller's button sends.
 */
export function CodeInput({
  id = 'code',
  label = components.code.label,
  length = 6,
  value,
  onChange,
  attemptsLeft,
  error,
  locked,
  disabled,
  autoComplete = 'off',
  autoFocus,
}: CodeInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const write = (next: string[]) => onChange(next.join('').slice(0, length));
  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const fill = (start: number, text: string) => {
    const incoming = onlyDigits(text)
      .slice(0, length - start)
      .split('');
    const next = digits.slice();
    incoming.forEach((d, k) => {
      next[start + k] = d;
    });
    write(next);
    focus(start + incoming.length);
  };

  const onInput = (i: number, raw: string) => {
    const v = onlyDigits(raw);
    if (!v) {
      const next = digits.slice();
      next[i] = '';
      write(next);
      return;
    }
    if (v.length > 1) {
      fill(i, v);
      return;
    }
    const next = digits.slice();
    next[i] = v;
    write(next);
    if (i < length - 1) focus(i + 1);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) focus(i - 1);
  };

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    fill(i, e.clipboardData.getData('text'));
  };

  const labelId = `${id}-label`;
  const messageId = `${id}-msg`;
  return (
    <div className={cx('pt-code', error ? 'has-error' : null, locked && 'is-locked')}>
      <span className="pt-field__label" id={labelId}>
        {label}
      </span>
      <div className="pt-code__cells" dir="ltr" role="group" aria-labelledby={labelId}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${id}-${i}`}
            className="pt-code__cell"
            inputMode="numeric"
            autoComplete={i === 0 ? autoComplete : 'off'}
            pattern="[0-9]*"
            maxLength={length}
            value={d}
            disabled={disabled || locked}
            autoFocus={autoFocus && i === 0}
            aria-label={fmt(components.code.digit, { n: i + 1 })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || locked ? messageId : undefined}
            onChange={(e) => onInput(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={(e) => onPaste(i, e)}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
      {locked ? (
        <p className="pt-field-error" id={messageId} role="alert">
          <Icon icon={Lock} size={16} />
          <span>{components.code.locked}</span>
        </p>
      ) : error ? (
        <p className="pt-field-error" id={messageId} role="alert">
          <Icon icon={CircleAlert} size={16} />
          <span>{error}</span>
        </p>
      ) : null}
      {!locked && attemptsLeft != null ? (
        <p className="pt-field__hint">{fmt(components.code.attemptsLeft, { n: attemptsLeft })}</p>
      ) : null}
    </div>
  );
}
