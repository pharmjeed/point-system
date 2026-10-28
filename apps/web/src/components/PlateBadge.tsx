import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';

export interface PlateValue {
  digits: string;
  /** Arabic letters, in plate order. */
  letters: string[];
  lettersEn?: string[];
}

export interface PlateBadgeProps extends PlateValue {
  size?: 'md' | 'lg';
}

/**
 * Saudi plate: 2px frame, digits on the left and letters on the right like the real plate, inside
 * `dir="ltr"` (03 §3.7). Read as «لوحة: ب ح د، 1234» (02 §7.16).
 */
export function PlateBadge({ digits, letters, lettersEn, size = 'md' }: PlateBadgeProps) {
  return (
    <span
      className={cx('pt-plate', size === 'lg' && 'pt-plate--lg')}
      dir="ltr"
      role="img"
      aria-label={fmt(components.plate.aria, { letters: letters.join(' '), digits })}
    >
      <span className="pt-plate__digits">{digits}</span>
      <span className="pt-plate__letters">
        <span lang="ar" dir="rtl">
          {letters.join(' ')}
        </span>
        {lettersEn?.length ? <span className="pt-plate__en">{lettersEn.join(' ')}</span> : null}
      </span>
    </span>
  );
}
