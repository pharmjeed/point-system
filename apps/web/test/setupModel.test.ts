import { describe, expect, it } from 'vitest';
import { VENUE_SETTINGS_DEFAULTS } from '../../../packages/shared/src/settings';
import { ApiError, NetworkError } from '@/api/errors';
import type { DriverListItem, Shift, VenueEvent } from '@/api/types';
import { matchesFilter, matchesSearch } from '@/features/drivers/driverModel';
import { fieldError, toFormErrors } from '@/features/common/formErrors';
import {
  currentShift,
  eventGroup,
  eventsIn,
  openEventCount,
  pricingText,
} from '@/features/venues/venueModel';
import { stripBidiMarks } from '@/lib/format';
import { VENUE_DEFAULTS, withDefaults } from '@/lib/venueDefaults';

const event = (over: Partial<VenueEvent>): VenueEvent => ({
  id: 'e',
  venue_id: 'v',
  dispatch_pool_id: 'p',
  name_ar: 'حفل',
  event_date: '2026-10-28',
  status: 'open',
  pricing_mode: 'included',
  fee_halalas: 0,
  version: 1,
  ...over,
});

describe('S-08 event groups «اليوم · القادمة · المغلقة»', () => {
  const today = '2026-10-28';
  it('groups by the Riyadh date and the status', () => {
    expect(eventGroup(event({}), today)).toBe('today');
    expect(eventGroup(event({ event_date: '2026-10-27' }), today)).toBe('today'); // still running
    expect(eventGroup(event({ event_date: '2026-11-02', status: 'draft' }), today)).toBe('upcoming');
    expect(eventGroup(event({ status: 'closed' }), today)).toBe('closed');
    expect(eventGroup(event({ status: 'canceled', event_date: '2026-12-01' }), today)).toBe('closed');
  });

  it('orders soonest first, closed latest first; counts open events', () => {
    const list = [
      event({ id: 'b', event_date: '2026-11-05', status: 'draft' }),
      event({ id: 'a', event_date: '2026-11-01', status: 'draft' }),
      event({ id: 'c', event_date: '2026-10-01', status: 'closed' }),
      event({ id: 'd', event_date: '2026-10-20', status: 'canceled' }),
    ];
    expect(eventsIn(list, 'upcoming', today).map((e) => e.id)).toEqual(['a', 'b']);
    expect(eventsIn(list, 'closed', today).map((e) => e.id)).toEqual(['d', 'c']);
    expect(openEventCount([...list, event({ id: 'o' })])).toBe(1);
  });

  it('pricing text', () => {
    expect(pricingText(event({}))).toBe('مشمول');
    expect(stripBidiMarks(pricingText(event({ pricing_mode: 'per_vehicle', fee_halalas: 2000 })))).toBe(
      '20.00 ر.س لكل مركبة',
    );
  });

  it('the venue card shows the open shift, else the next scheduled one', () => {
    const shift = (id: string, status: Shift['status'], starts_at: string): Shift => ({
      id,
      venue_id: 'v',
      dispatch_pool_id: 'p',
      status,
      starts_at,
      version: 1,
    });
    expect(
      currentShift([shift('x', 'closed', '2026-10-01T00:00:00Z'), shift('y', 'open', '2026-10-02T00:00:00Z')])
        ?.id,
    ).toBe('y');
    expect(
      currentShift([
        shift('late', 'scheduled', '2026-10-30T00:00:00Z'),
        shift('soon', 'scheduled', '2026-10-29T00:00:00Z'),
      ])?.id,
    ).toBe('soon');
    expect(currentShift([shift('x', 'closed', '2026-10-01T00:00:00Z')])).toBeNull();
  });
});

describe('S-05 filters and search', () => {
  const driver = (
    over: { state?: string; status?: 'active' | 'disabled'; name?: string } = {},
  ): DriverListItem => ({
    user: {
      id: 'u',
      employee_code: 'D-0017',
      full_name: over.name ?? 'خالد سعيد',
      phone_e164: '+966551234567',
      role: 'driver',
      status: over.status ?? 'active',
      version: 1,
    },
    live: over.state
      ? { driver: { id: 'u', full_name: 'خالد سعيد' }, driver_state: over.state as never }
      : null,
  });
  it('«مشغول» groups intake_parking, retrieving and busy_with_next (02 S-05)', () => {
    for (const state of ['intake_parking', 'retrieving', 'busy_with_next'])
      expect(matchesFilter(driver({ state }), 'busy')).toBe(true);
    expect(matchesFilter(driver({ state: 'available' }), 'busy')).toBe(false);
    expect(matchesFilter(driver({}), 'off_duty')).toBe(true); // no live record = off duty
    expect(matchesFilter(driver({ status: 'disabled', state: 'available' }), 'available')).toBe(false);
    expect(matchesFilter(driver({ status: 'disabled' }), 'disabled')).toBe(true);
    expect(matchesFilter(driver({ status: 'disabled' }), 'all')).toBe(true);
  });
  it('searches the name, the employee code and the phone digits', () => {
    expect(matchesSearch(driver(), 'خالد')).toBe(true);
    expect(matchesSearch(driver(), 'd-0017')).toBe(true);
    expect(matchesSearch(driver(), '4567')).toBe(true);
    expect(matchesSearch(driver(), '١٢٣٤')).toBe(true);
    expect(matchesSearch(driver(), 'فهد')).toBe(false);
    expect(matchesSearch(driver(), '  ')).toBe(true);
  });
});

describe('venue setting defaults', () => {
  it('equal the canon §12 defaults of @point/shared', () => {
    expect(JSON.parse(JSON.stringify(VENUE_DEFAULTS))).toEqual(
      JSON.parse(JSON.stringify(VENUE_SETTINGS_DEFAULTS)),
    );
  });
  it('fill what a reply leaves out without sharing arrays', () => {
    const s = withDefaults({
      dispatch: { single_offer_ttl_s: 45 },
      inspection: { required_photos: ['photo_front'] },
    });
    expect(s.dispatch.single_offer_ttl_s).toBe(45);
    expect(s.dispatch.single_offer_reminder_s).toBe(15);
    expect(s.inspection.required_photos).toEqual(['photo_front']);
    s.pricing.allowed_methods.push('cash');
    expect(VENUE_DEFAULTS.pricing.allowed_methods).toEqual(['cash', 'pos']);
  });
});

describe('form error placement (02 §1.9)', () => {
  it('VALIDATION_FAILED goes under each field of details.fields', () => {
    const error = new ApiError({
      code: 'VALIDATION_FAILED',
      status: 422,
      message_ar: 'تحقّق من الحقول المحددة.',
      details: {
        fields: [
          { field: 'range.to', issue: 'max' },
          { field: 'name_ar', issue: 'dup', message_ar: 'مكرر' },
        ],
      },
    });
    const f = toFormErrors(error);
    expect(f.form).toBe('تحقّق من الحقول المحددة.');
    expect(fieldError(f, 'range')).toBe('تحقّق من الحقول المحددة.');
    expect(fieldError(f, 'name_ar')).toBe('مكرر');
  });
  it('a code naming a field goes under it; others above the button with the follow-up code', () => {
    const phone = new ApiError({ code: 'PHONE_INVALID', status: 422, message_ar: 'رقم غير صالح' });
    expect(toFormErrors(phone, { PHONE_INVALID: 'phone' })).toEqual({
      form: null,
      requestId: null,
      fields: { phone: 'رقم غير صالح' },
    });
    const conflict = new ApiError({ code: 'ASSIGNMENT_CONFLICT', status: 409, requestId: 'req_1' });
    expect(toFormErrors(conflict)).toMatchObject({ requestId: 'req_1', fields: {} });
    expect(toFormErrors(new NetworkError('offline')).form).toBe(
      'تعذر الوصول للخادم. سنعيد إرسال الطلب نفسه دون تكرار.',
    );
    expect(toFormErrors(null).form).toBeNull();
  });
});
