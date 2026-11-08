import { describe, expect, it } from 'vitest';
import { toLatinDigits, onlyDigits } from '@/lib/digits';
import {
  formatClock,
  formatDate,
  formatHalalas,
  formatNumber,
  formatSinceMinutes,
  formatTime,
  stripBidiMarks,
} from '@/lib/format';

const ARABIC_INDIC = /[٠-٩۰-۹]/;

describe('format (02 §1.2, 03 §2.9, DEC-17)', () => {
  it('formats times in Asia/Riyadh with Western digits and the Gregorian calendar', () => {
    // 16:42Z = 19:42 in Riyadh (UTC+3, no DST)
    expect(stripBidiMarks(formatTime('2026-10-29T16:42:10Z'))).toBe('7:42 م');
    expect(formatTime('2026-10-29T16:42:10Z')).not.toMatch(ARABIC_INDIC);
  });

  it('uses the Riyadh date across UTC midnight', () => {
    expect(stripBidiMarks(formatDate('2026-10-29T22:30:00Z'))).toBe('30/10/2026');
  });

  it('formats numbers and amounts with Latin digits', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatHalalas(2500)).toBe('25.00 ر.س');
    expect(formatHalalas(1999)).toBe('19.99 ر.س');
    expect(formatHalalas(2500)).not.toMatch(ARABIC_INDIC);
  });

  it('formats counters as m:ss and durations as «منذ n د»', () => {
    expect(formatClock(130)).toBe('2:10');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(-4)).toBe('0:00');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatSinceMinutes(3 * 60_000 + 59_000)).toBe('منذ 3 د');
  });

  it('normalises Arabic-Indic and Persian digits typed on Arabic keyboards', () => {
    expect(toLatinDigits('٠٥٥١٢٣٤٥٦٧')).toBe('0551234567');
    expect(toLatinDigits('۰۵۵۱۲۳')).toBe('055123');
    expect(onlyDigits('٥٥ ١٢-٣')).toBe('55123');
  });
});
