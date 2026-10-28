import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';

export interface CountdownRingProps {
  /** Seconds left, computed from `expires_at − serverNow` (never a local counter from 30). */
  seconds: number;
  total?: number;
  size?: number;
  stroke?: number;
}

/**
 * Single-offer countdown (03 §3.5): ⌀56, stroke 5, --pt-primary then --pt-warning under 10 s, number in
 * the middle. Linear; the accessible label changes every 10 s only.
 */
export function CountdownRing({ seconds, total = 30, size = 56, stroke = 5 }: CountdownRingProps) {
  const whole = Math.max(0, Math.ceil(seconds));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, seconds / total));
  const announced = Math.ceil(whole / 10) * 10;
  return (
    <span
      className={cx('pt-ring', whole < 10 && 'pt-ring--low')}
      role="timer"
      aria-label={fmt(components.ring.remaining, { n: announced })}
      style={{ inlineSize: size, blockSize: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="pt-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="pt-ring__value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          strokeLinecap="round"
        />
      </svg>
      <span className="pt-ring__num" aria-hidden="true">
        {whole}
      </span>
    </span>
  );
}
