/**
 * V2-004 (DEC-490): the venue public profile's weekly hours — the DEC-482 shape written strictly, the canonical
 * stored form, «open now» in Riyadh time with overnight intervals, and the operator/platform bodies.
 */
import { describe, expect, it } from 'vitest';
import {
  OpeningHoursInputSchema,
  PutVenuePublicProfileBodySchema,
  ReviewReasonBodySchema,
  VENUE_CATEGORIES,
  VenuePricingBodySchema,
  canonicalOpeningHours,
  categoryAllowsSubscriptions,
  hasOpeningHours,
  isOpenAt,
  normalizeOpeningHours,
} from '../src/index.js';
import { OpeningHoursSchema as CustomerOpeningHoursSchema, VENUE_PUBLIC_CATEGORIES } from '../src/customer/index.js';

/** A Riyadh local time (UTC+3) as an instant. */
const riyadh = (iso: string) => new Date(`${iso}+03:00`);

describe('opening hours', () => {
  const hours = {
    always_open: false,
    days: {
      sun: [{ open: '08:00', close: '22:00' }],
      fri: [{ open: '20:00', close: '02:00' }],
      sat: [{ open: '10:00', close: '24:00' }],
    },
  };

  it('every operator write is a valid customer value (the DEC-482 shape)', () => {
    const parsed = OpeningHoursInputSchema.parse(hours);
    expect(CustomerOpeningHoursSchema.safeParse(parsed).success).toBe(true);
  });

  it('refuses overlap, empty intervals, bad times, unknown days and more than 4 intervals', () => {
    const issue = (days: object) =>
      OpeningHoursInputSchema.safeParse({ always_open: false, days }).error?.issues[0]?.message;
    expect(
      issue({
        sun: [
          { open: '08:00', close: '12:00' },
          { open: '11:59', close: '13:00' },
        ],
      }),
    ).toBe('overlapping_intervals');
    // an overnight interval occupies the rest of its day
    expect(
      issue({
        fri: [
          { open: '20:00', close: '02:00' },
          { open: '21:00', close: '22:00' },
        ],
      }),
    ).toBe('overlapping_intervals');
    expect(issue({ mon: [{ open: '09:00', close: '09:00' }] })).toBe('empty_interval');
    expect(issue({ mon: [{ open: '24:00', close: '09:00' }] })).toBe('time_format');
    expect(issue({ mon: [{ open: '9:00', close: '10:00' }] })).toBe('time_format');
    expect(OpeningHoursInputSchema.safeParse({ always_open: false, days: { xyz: [] } }).success).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => ({ open: `0${i}:00`, close: `0${i}:30` }));
    expect(OpeningHoursInputSchema.safeParse({ always_open: false, days: { mon: five } }).success).toBe(false);
    // touching intervals are fine
    expect(
      issue({
        tue: [
          { open: '08:00', close: '12:00' },
          { open: '12:00', close: '16:00' },
        ],
      }),
    ).toBeUndefined();
  });

  it('the stored form is canonical: week order, sorted intervals, no empty day', () => {
    const typed = {
      always_open: false,
      days: {
        thu: [
          { open: '16:00', close: '20:00' },
          { open: '08:00', close: '12:00' },
        ],
        mon: [],
        sun: [{ open: '08:00', close: '22:00' }],
      },
    };
    const c = canonicalOpeningHours(typed);
    expect(Object.keys(c.days)).toEqual(['sun', 'thu']);
    expect(c.days.thu?.map((i) => i.open)).toEqual(['08:00', '16:00']);
    // the 0008 default and an unreadable value are «unknown»
    expect(normalizeOpeningHours({})).toEqual({ always_open: false, days: {} });
    expect(normalizeOpeningHours('nonsense')).toEqual({ always_open: false, days: {} });
    expect(hasOpeningHours(normalizeOpeningHours({}))).toBe(false);
    expect(hasOpeningHours({ always_open: true, days: {} })).toBe(true);
  });

  it('«open now» in Riyadh time, overnight intervals included; unknown hours → null', () => {
    // 2026-11-01 is a Sunday
    expect(isOpenAt(hours, riyadh('2026-11-01T08:00:00'))).toBe(true);
    expect(isOpenAt(hours, riyadh('2026-11-01T07:59:00'))).toBe(false);
    expect(isOpenAt(hours, riyadh('2026-11-01T22:00:00'))).toBe(false);
    // Friday 20:00 → Saturday 02:00
    expect(isOpenAt(hours, riyadh('2026-11-06T23:30:00'))).toBe(true);
    expect(isOpenAt(hours, riyadh('2026-11-07T01:59:00'))).toBe(true);
    expect(isOpenAt(hours, riyadh('2026-11-07T02:00:00'))).toBe(false);
    // Saturday until midnight
    expect(isOpenAt(hours, riyadh('2026-11-07T23:59:00'))).toBe(true);
    expect(isOpenAt(hours, riyadh('2026-11-02T12:00:00'))).toBe(false); // Monday: closed
    expect(isOpenAt({ always_open: true, days: {} }, riyadh('2026-11-02T03:00:00'))).toBe(true);
    expect(isOpenAt({ always_open: false, days: {} }, riyadh('2026-11-02T03:00:00'))).toBeNull();
  });
});

describe('bodies', () => {
  const body = {
    expected_version: 0,
    category: 'mall',
    address: '  طريق  ',
    city: '',
    lat: 24.7,
    lng: 46.7,
    opening_hours: { always_open: true, days: {} },
    photo_ids: [],
  };

  it('the PUT body: trimmed texts, empty → null, the coordinate pair, unique photos (at most 6)', () => {
    const p = PutVenuePublicProfileBodySchema.parse(body);
    expect(p).toMatchObject({ address: 'طريق', city: null });
    expect(PutVenuePublicProfileBodySchema.safeParse({ ...body, lat: null }).success).toBe(false);
    expect(PutVenuePublicProfileBodySchema.safeParse({ ...body, lat: null, lng: null }).success).toBe(true);
    const id = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    expect(PutVenuePublicProfileBodySchema.safeParse({ ...body, photo_ids: [id, id] }).success).toBe(false);
    expect(
      PutVenuePublicProfileBodySchema.safeParse({ ...body, photo_ids: Array(7).fill(id) }).success,
    ).toBe(false);
    expect(PutVenuePublicProfileBodySchema.safeParse({ ...body, price: 1 }).success).toBe(false); // strict
  });

  it('review reasons are 3 … 500 characters; prices are positive halalas or null', () => {
    expect(ReviewReasonBodySchema.safeParse({ expected_version: 1, reason: ' ab ' }).success).toBe(false);
    expect(ReviewReasonBodySchema.safeParse({ expected_version: 1, reason: 'سبب' }).success).toBe(true);
    const price = { expected_version: 1, subscriptions_enabled: true };
    expect(VenuePricingBodySchema.safeParse({ ...price, pay_per_visit_halalas: 0 }).success).toBe(false);
    expect(VenuePricingBodySchema.safeParse({ ...price, pay_per_visit_halalas: null }).success).toBe(true);
  });

  it('halls sell no subscription (V2-D07); the categories match the customer contract', () => {
    expect(VENUE_CATEGORIES.filter((c) => !categoryAllowsSubscriptions(c))).toEqual(['hall']);
    expect([...VENUE_PUBLIC_CATEGORIES]).toEqual([...VENUE_CATEGORIES]);
  });
});
