import { describe, expect, it } from 'vitest';
import {
  addDays,
  halalasFromSar,
  riyadhParts,
  riyadhRange,
  riyadhToIso,
  sarFromHalalas,
  todayRiyadh,
} from '@/lib/riyadh';

describe('Riyadh local dates and times (07 §1.8)', () => {
  it('maps a local date and time to the UTC instant (UTC+03:00 all year)', () => {
    expect(riyadhToIso('2026-10-28', '19:00')).toBe('2026-10-28T16:00:00.000Z');
    expect(riyadhToIso('2026-01-01', '00:30')).toBe('2025-12-31T21:30:00.000Z');
    expect(riyadhToIso('2026-10-28', '')).toBeNull();
    expect(riyadhToIso('28/10/2026', '19:00')).toBeNull();
  });

  it('reads an instant back as Riyadh date and time', () => {
    expect(riyadhParts('2026-10-28T21:30:00.000Z')).toEqual({ date: '2026-10-29', time: '00:30' });
    expect(todayRiyadh(Date.parse('2026-10-28T20:59:00.000Z'))).toBe('2026-10-28');
    expect(todayRiyadh(Date.parse('2026-10-28T21:00:00.000Z'))).toBe('2026-10-29');
  });

  it('an end at or before the start is on the next day', () => {
    expect(riyadhRange('2026-10-28', '19:00', '01:30')).toEqual({
      starts_at: '2026-10-28T16:00:00.000Z',
      ends_at: '2026-10-28T22:30:00.000Z',
    });
    expect(riyadhRange('2026-10-28', '19:00', '23:00').ends_at).toBe('2026-10-28T20:00:00.000Z');
    expect(riyadhRange('2026-10-28', '', '')).toEqual({ starts_at: null, ends_at: null });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('parses riyal amounts into integer halalas, any digit script', () => {
    expect(halalasFromSar('20')).toBe(2000);
    expect(halalasFromSar('25.5')).toBe(2550);
    expect(halalasFromSar('25.05')).toBe(2505);
    expect(halalasFromSar('٢٠')).toBe(2000);
    expect(halalasFromSar('12٫75')).toBe(1275);
    expect(halalasFromSar('1.234')).toBeNull();
    expect(halalasFromSar('')).toBeNull();
    expect(halalasFromSar('-5')).toBeNull();
    expect(sarFromHalalas(2550)).toBe('25.50');
  });
});
