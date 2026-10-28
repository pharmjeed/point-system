import { describe, expect, it } from 'vitest';
import { addDays, lastWeek, periodToUtc, riyadhDate } from '@/features/reports/period';

describe('S-11 report periods in Riyadh days', () => {
  it('turns Riyadh calendar days into a UTC half-open range', () => {
    expect(periodToUtc('2026-10-01', '2026-10-07')).toEqual({
      from: '2026-09-30T21:00:00.000Z',
      to: '2026-10-07T21:00:00.000Z',
    });
    expect(periodToUtc('2026-10-07', '2026-10-07')).toEqual({
      from: '2026-10-06T21:00:00.000Z',
      to: '2026-10-07T21:00:00.000Z',
    });
    expect(periodToUtc('2026-10-08', '2026-10-07')).toBeNull();
    expect(periodToUtc('', '2026-10-07')).toBeNull();
  });

  it('uses the Riyadh date across UTC midnight', () => {
    expect(riyadhDate(Date.parse('2026-10-29T21:30:00Z'))).toBe('2026-10-30');
    expect(riyadhDate(Date.parse('2026-10-29T20:59:59Z'))).toBe('2026-10-29');
    expect(addDays('2026-10-30', -6)).toBe('2026-10-24');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(lastWeek(Date.parse('2026-10-29T21:30:00Z'))).toEqual({ from: '2026-10-24', to: '2026-10-30' });
  });
});
