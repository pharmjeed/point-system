import { ArrowRight } from 'lucide-react';
import { components } from '@/i18n/ar';
import { Icon } from './Icon';

/**
 * The 17 plate letters with their Latin counterpart (03 §3.7, 07 §1.8). `plate_letters_ar` and
 * `plate_letters_en` are stored together. To be re-checked against the official reference (03 §3.7).
 */
export const PLATE_LETTERS = [
  ['ا', 'A'],
  ['ب', 'B'],
  ['ح', 'J'],
  ['د', 'D'],
  ['ر', 'R'],
  ['س', 'S'],
  ['ص', 'X'],
  ['ط', 'T'],
  ['ع', 'E'],
  ['ق', 'G'],
  ['ك', 'K'],
  ['ل', 'L'],
  ['م', 'Z'],
  ['ن', 'N'],
  ['هـ', 'H'],
  ['و', 'U'],
  ['ى', 'V'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export type PlateLetter = readonly [ar: string, en: string];

export interface LetterPadProps {
  value: PlateLetter[];
  onChange: (value: PlateLetter[]) => void;
  max?: number;
  disabled?: boolean;
}

/** 52px keys; disabled once 3 letters are chosen; a delete key removes the last one. */
export function LetterPad({ value, onChange, max = 3, disabled }: LetterPadProps) {
  return (
    <div className="pt-letterpad" role="group" aria-label={components.plate.letters}>
      {PLATE_LETTERS.map((letter) => (
        <button
          key={letter[0]}
          type="button"
          className="pt-letter"
          disabled={disabled || value.length >= max}
          aria-label={`${letter[0]} ${letter[1]}`}
          onClick={() => onChange([...value, letter])}
        >
          <span className="pt-letter__ar">{letter[0]}</span>
          <span className="pt-letter__en">{letter[1]}</span>
        </button>
      ))}
      <button
        type="button"
        className="pt-letter pt-letter--del"
        disabled={disabled || value.length === 0}
        aria-label={components.plate.deleteLast}
        onClick={() => onChange(value.slice(0, -1))}
      >
        <Icon icon={ArrowRight} size={20} />
        <span className="pt-letter__en">{components.plate.delete}</span>
      </button>
    </div>
  );
}
