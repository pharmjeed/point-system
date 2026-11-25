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

/** The Latin letter of each Saudi plate letter (02 D-05 pad; «هـ» is the pad's spelling of «ه»). */
const LATIN: Record<string, string> = {
  ا: 'A',
  ب: 'B',
  ح: 'J',
  د: 'D',
  ر: 'R',
  س: 'S',
  ص: 'X',
  ط: 'T',
  ع: 'E',
  ق: 'G',
  ك: 'K',
  ل: 'L',
  م: 'Z',
  ن: 'N',
  ه: 'H',
  هـ: 'H',
  و: 'U',
  ى: 'V',
};

const arabicIndic = (d: string) => String.fromCharCode(0x0660 + Number(d));

/**
 * Saudi plate as it is on the car (03 §3.7, DEC-642): digits on the left and letters on the right, the Arabic row
 * above the Latin one, and the «KSA» band on the right edge, inside `dir="ltr"`. The Arabic row shows the plate's own
 * Arabic-Indic digits (a picture of the physical plate), one element each so the layout never reverses them.
 * Read as «لوحة: ب ح د، 1234» (02 §7.16).
 */
export function PlateBadge({ digits, letters, lettersEn, size = 'md' }: PlateBadgeProps) {
  const latin = lettersEn?.length ? lettersEn : letters.map((l) => LATIN[l] ?? '');
  return (
    <span
      className={cx('pt-plate', size === 'lg' && 'pt-plate--lg')}
      dir="ltr"
      role="img"
      aria-label={fmt(components.plate.aria, { letters: letters.join(' '), digits })}
    >
      <span className="pt-plate__half">
        <span className="pt-plate__ar" aria-hidden="true">
          {[...digits].map((d, i) => (
            <span key={i}>{arabicIndic(d)}</span>
          ))}
        </span>
        <span className="pt-plate__en pt-plate__digits">{digits}</span>
      </span>
      <span className="pt-plate__half">
        <span className="pt-plate__ar" lang="ar" dir="rtl">
          {letters.join(' ')}
        </span>
        <span className="pt-plate__en">{latin.join(' ')}</span>
      </span>
      <span className="pt-plate__band" aria-hidden="true">
        KSA
      </span>
    </span>
  );
}
