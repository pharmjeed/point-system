/**
 * V2-036 (docs/v2/04 §7; DEC-591, DEC-593, DEC-594, DEC-600; the subscriptions annex clauses 1, 2, 4, 5): the counted-day
 * arithmetic of a `service_days` term — 22 counted days on Sunday … Thursday from the first counted day, Friday and
 * Saturday never counted, holidays counted, a freeze moving the end by the counted days it actually froze.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  consumedServiceDays,
  countServiceDays,
  daysBetween,
  freezeRequestCheck,
  isIsoDate,
  isServiceDay,
  maskOfWeekdays,
  nextServiceDayOnOrAfter,
  nthServiceDay,
  remainingServiceDays,
  resumedTermEnd,
  riyadhDate,
  riyadhMidnight,
  riyadhMinuteOfDay,
  SERVICE_DAY_RULES,
  serviceDaysRefundHalalas,
  serviceTerm,
  serviceTermInstants,
  serviceTermStart,
  SUNDAY_TO_THURSDAY_MASK,
  weekdayOf,
  weekdaysOfMask,
} from '../src/index.js';

const M = SUNDAY_TO_THURSDAY_MASK;
/** an instant at a Riyadh local time (UTC+3) */
const at = (day: string, hhmm = '09:00') => new Date(`${day}T${hhmm}:00+03:00`);

/** the slow reference: walk day by day */
function slowNth(from: string, n: number, mask: number) {
  let d = from;
  let left = n;
  for (;;) {
    if (isServiceDay(d, mask) && --left === 0) return d;
    d = addDays(d, 1);
  }
}
function slowCount(from: string, to: string, mask: number) {
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) if (isServiceDay(d, mask)) n++;
  return n;
}

describe('dates on the Riyadh calendar', () => {
  it('Sunday … Thursday is the mask 31 and its weekdays', () => {
    expect(maskOfWeekdays([0, 1, 2, 3, 4])).toBe(M);
    expect(weekdaysOfMask(M)).toEqual([0, 1, 2, 3, 4]);
    expect(() => maskOfWeekdays([])).toThrow(RangeError);
    expect(() => maskOfWeekdays([7])).toThrow(RangeError);
    expect(() => weekdaysOfMask(0)).toThrow(RangeError);
    expect(() => weekdaysOfMask(128)).toThrow(RangeError);
  });

  it('reads weekdays: 2026-11-01 is a Sunday, Friday 2026-11-06 and Saturday 2026-11-07 do not serve', () => {
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(isServiceDay('2026-11-05', M)).toBe(true); // Thursday
    expect(isServiceDay('2026-11-06', M)).toBe(false); // Friday
    expect(isServiceDay('2026-11-07', M)).toBe(false); // Saturday
  });

  it('an instant belongs to its Riyadh date (UTC+3, no daylight saving), its midnight is 21:00 UTC the day before', () => {
    expect(riyadhDate(new Date('2026-11-01T20:59:59Z'))).toBe('2026-11-01');
    expect(riyadhDate(new Date('2026-11-01T21:00:00Z'))).toBe('2026-11-02');
    expect(riyadhMidnight('2026-11-02').toISOString()).toBe('2026-11-01T21:00:00.000Z');
    expect(riyadhMidnight('2026-07-01').toISOString()).toBe('2026-06-30T21:00:00.000Z');
    expect(riyadhMinuteOfDay(at('2026-11-01', '11:59'))).toBe(11 * 60 + 59);
  });

  it('validates dates and steps across months and years', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });
});

describe('the 22 counted days of the student plan (annex clauses 1 and 2)', () => {
  it('paid Sunday morning: day 1 is that Sunday, day 22 is Monday 2026-11-30 (not a calendar month or 30 days)', () => {
    const term = serviceTerm(at('2026-11-01', '09:00'), 22, M);
    expect(term).toEqual({ startOn: '2026-11-01', endOn: '2026-11-30' });
    expect(countServiceDays(term.startOn, addDays(term.endOn, 1), M)).toBe(22);
    const { start, end } = serviceTermInstants(term);
    expect(start.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T21:00:00.000Z');
  });

  it('the cutoff (DEC-591): paid at 12:00 or later, or on Friday/Saturday, day 1 is the next service day', () => {
    expect(serviceTermStart(at('2026-11-01', '11:59'), M)).toBe('2026-11-01');
    expect(serviceTermStart(at('2026-11-01', '12:00'), M)).toBe('2026-11-02');
    expect(serviceTermStart(at('2026-11-05', '23:00'), M)).toBe('2026-11-08'); // Thursday night → Sunday
    expect(serviceTermStart(at('2026-11-06', '08:00'), M)).toBe('2026-11-08'); // Friday → Sunday
    expect(serviceTermStart(at('2026-11-07', '08:00'), M)).toBe('2026-11-08'); // Saturday → Sunday
    expect(SERVICE_DAY_RULES.same_day_cutoff_minute).toBe(720);
  });

  it('crosses a month and a year: day 1 Thursday 2026-12-24 → day 22 Sunday 2027-01-24', () => {
    const term = serviceTerm(at('2026-12-24', '07:30'), 22, M);
    expect(term).toEqual({ startOn: '2026-12-24', endOn: '2027-01-24' });
    expect(countServiceDays('2026-12-24', '2027-01-25', M)).toBe(22);
  });

  it('the 22nd day is never a Friday or a Saturday, whatever the first day', () => {
    for (let d = '2026-11-01'; d < '2027-03-01'; d = addDays(d, 1)) {
      const start = nextServiceDayOnOrAfter(d, M);
      const end = nthServiceDay(start, 22, M);
      expect(isServiceDay(end, M), `${d} → ${end}`).toBe(true);
      expect(countServiceDays(start, addDays(end, 1), M)).toBe(22);
      // 22 Sunday…Thursday days span 4 whole weeks and 2 more days: 30 or 32 calendar days
      expect([29, 30, 31, 32]).toContain(daysBetween(start, end) + 1);
    }
  });

  it('nthServiceDay and countServiceDays agree with a day-by-day walk for every mask and start', () => {
    const masks = [M, 1, 0b1000001, 127, 0b0101010, maskOfWeekdays([6])];
    for (const mask of masks)
      for (let d = '2026-11-01'; d < '2026-11-15'; d = addDays(d, 1))
        for (const n of [1, 2, 5, 22, 23, 60]) {
          expect(nthServiceDay(d, n, mask), `${mask} ${d} ${n}`).toBe(slowNth(d, n, mask));
          const to = addDays(d, n);
          expect(countServiceDays(d, to, mask)).toBe(slowCount(d, to, mask));
        }
    expect(countServiceDays('2026-11-05', '2026-11-05', M)).toBe(0);
    expect(countServiceDays('2026-11-05', '2026-11-01', M)).toBe(0);
    expect(() => nthServiceDay('2026-11-01', 0, M)).toThrow(RangeError);
  });

  it('holidays and absences count (they are not Fridays or Saturdays): a no-show never moves the end', () => {
    const term = serviceTerm(at('2026-11-01'), 22, M);
    // nothing in the arithmetic knows a holiday: the end is the same whatever the venue announces
    expect(remainingServiceDays('2026-11-15', term, M)).toBe(12);
    expect(consumedServiceDays('2026-11-12', term, 22, M)).toBe(10);
    expect(consumedServiceDays('2026-10-30', term, 22, M)).toBe(0);
    expect(remainingServiceDays('2026-10-25', term, M)).toBe(22); // before day 1: all of them
    expect(remainingServiceDays('2026-12-01', term, M)).toBe(0);
  });
});

describe('the freeze (annex clause 4, DEC-593, DEC-594)', () => {
  const term = serviceTerm(at('2026-11-01'), 22, M); // 2026-11-01 … 2026-11-30
  const today = '2026-11-03'; // Tuesday
  const check = (startsOn: string, returnsOn: string, maxDays = 5) =>
    freezeRequestCheck({ today, startsOn, returnsOn, term, mask: M, maxDays });

  it('five counted days Monday → Monday: Friday and Saturday inside do not count toward the five', () => {
    expect(check('2026-11-09', '2026-11-16')).toEqual({ ok: true, days: 5 });
    // Thursday → Wednesday: Thu, Sun, Mon, Tue = 4 (Fri/Sat skipped)
    expect(check('2026-11-05', '2026-11-11')).toEqual({ ok: true, days: 4 });
  });

  it('refuses a start today or in the past (never retroactive), and a start too far ahead', () => {
    expect(check('2026-11-03', '2026-11-05')).toEqual({ ok: false, issue: 'not_in_advance' });
    expect(check('2026-11-02', '2026-11-05')).toEqual({ ok: false, issue: 'not_in_advance' });
    expect(check('2026-11-04', '2026-11-05')).toEqual({ ok: true, days: 1 });
    const far = freezeRequestCheck({
      today,
      startsOn: addDays(today, SERVICE_DAY_RULES.freeze_max_lead_days + 1),
      returnsOn: addDays(today, SERVICE_DAY_RULES.freeze_max_lead_days + 3),
      term: { startOn: term.startOn, endOn: '2027-06-01' },
      mask: M,
      maxDays: 5,
    });
    expect(far).toEqual({ ok: false, issue: 'too_far_ahead' });
  });

  it('refuses a start or a return on a Friday/Saturday, a return not after the start, more than five days', () => {
    expect(check('2026-11-06', '2026-11-09')).toEqual({ ok: false, issue: 'start_not_service_day' });
    expect(check('2026-11-05', '2026-11-07')).toEqual({ ok: false, issue: 'return_not_service_day' });
    expect(check('2026-11-05', '2026-11-05')).toEqual({ ok: false, issue: 'return_not_after_start' });
    expect(check('2026-11-09', '2026-11-17')).toEqual({ ok: false, issue: 'too_long' }); // 6 counted days
  });

  it('refuses a start outside the term', () => {
    expect(check('2026-12-01', '2026-12-02')).toEqual({ ok: false, issue: 'after_term' });
    const later = { startOn: '2026-11-10', endOn: '2026-12-09' };
    expect(
      freezeRequestCheck({
        today,
        startsOn: '2026-11-04',
        returnsOn: '2026-11-05',
        term: later,
        mask: M,
        maxDays: 5,
      }),
    ).toEqual({ ok: false, issue: 'before_term' });
    // the last counted day itself may be frozen
    expect(check('2026-11-30', '2026-12-01')).toEqual({ ok: true, days: 1 });
  });

  it('extends the end by the counted days actually frozen: five days → day 22 moves from 11-30 to 12-07', () => {
    const remaining = remainingServiceDays('2026-11-09', term, M); // days 7 … 22
    expect(remaining).toBe(16);
    expect(resumedTermEnd('2026-11-16', remaining, M)).toBe('2026-12-07');
    expect(countServiceDays('2026-11-09', '2026-11-16', M)).toBe(5);
  });

  it('an early reactivation resumes the same day: two days used → the end moves by two counted days only', () => {
    const remaining = remainingServiceDays('2026-11-09', term, M);
    // frozen Monday 11-09, back Wednesday 11-11 (Mon + Tue frozen)
    expect(resumedTermEnd('2026-11-11', remaining, M)).toBe('2026-12-02');
    expect(countServiceDays('2026-11-09', '2026-11-11', M)).toBe(2);
    // back on the first day itself: nothing frozen, the end does not move
    expect(resumedTermEnd('2026-11-09', remaining, M)).toBe(term.endOn);
  });

  it('a freeze of the last counted day pushes it to the return day; across a month end too', () => {
    const remaining = remainingServiceDays('2026-11-30', term, M);
    expect(remaining).toBe(1);
    expect(resumedTermEnd('2026-12-03', remaining, M)).toBe('2026-12-03');
    expect(resumedTermEnd('2026-12-31', 3, M)).toBe('2027-01-04'); // Thu 31, Sun 3, Mon 4
    expect(resumedTermEnd('2026-12-04', 0, M)).toBe('2026-12-03');
  });
});

describe('the exceptional refund by remaining counted days (annex clause 5, DEC-600)', () => {
  it('price × remaining ÷ 22, rounded down, never more than paid', () => {
    expect(serviceDaysRefundHalalas(17_250, 22, 22)).toBe(17_250);
    expect(serviceDaysRefundHalalas(17_250, 11, 22)).toBe(8_625);
    expect(serviceDaysRefundHalalas(17_250, 1, 22)).toBe(784); // 784.09…
    expect(serviceDaysRefundHalalas(17_250, 0, 22)).toBe(0);
    expect(serviceDaysRefundHalalas(17_250, 30, 22)).toBe(17_250);
    expect(serviceDaysRefundHalalas(17_250, 5, 0)).toBe(0);
  });
});
