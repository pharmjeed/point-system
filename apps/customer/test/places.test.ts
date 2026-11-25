/**
 * DEC-639: C-06 by subscription — «أين تركن عادةً؟» without one (option 2), the place, car and renewal under the
 * entry pass with one (option 4).
 */
import type { CustomerHomeSubscription, CustomerLocationSummary } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import {
  heldSubscriptions,
  homeMode,
  pinSpots,
  placeCards,
  subscribedChip,
  subscriptionLine,
} from '../src/features/places';
import { ar } from '../src/i18n/ar';

const sub = (patch: Partial<CustomerHomeSubscription>): CustomerHomeSubscription => ({
  subscription_id: '00000000-0000-4000-8000-000000000001',
  venue_id: '00000000-0000-4000-8000-0000000000a1',
  venue_name_ar: 'برج الأعمال',
  venue_name_en: 'Business Tower',
  status: 'active',
  billing_cycle: 'monthly',
  current_period_end: '2026-12-25T09:00:00Z',
  cancel_at_period_end: false,
  ...patch,
});

const loc = (patch: Partial<CustomerLocationSummary>): CustomerLocationSummary => ({
  venue_id: '00000000-0000-4000-8000-0000000000b1',
  name_ar: 'مستشفى النخيل',
  name_en: null,
  category: 'hospital',
  operator_name_ar: 'صف المدينة',
  operator_name_en: null,
  city: 'الرياض',
  lat: 24.7,
  lng: 46.7,
  distance_m: 1200,
  open_now: true,
  subscriptions_enabled: true,
  pay_per_visit_halalas: null,
  monthly_from_halalas: 17500,
  ...patch,
});

const visit = {
  ticket_id: '00000000-0000-4000-8000-0000000000c1',
  venue_id: '00000000-0000-4000-8000-0000000000a1',
  venue_name_ar: 'برج الأعمال',
  venue_name_en: null,
  status: 'parked' as const,
  plate_display: '1234 ا ب ح',
  received_at: '2026-11-24T08:00:00Z',
};

describe('C-06 by subscription (DEC-639)', () => {
  it('chooses the place without a held subscription, the pass with one, the circle in any visit', () => {
    expect(homeMode({ current_visit: null, subscriptions: [] })).toBe('choose');
    expect(homeMode({ current_visit: null, subscriptions: [sub({ status: 'pending_payment' })] })).toBe(
      'choose',
    );
    for (const status of ['active', 'past_due', 'frozen'] as const)
      expect(homeMode({ current_visit: null, subscriptions: [sub({ status })] })).toBe('subscribed');
    // a guest visit linked from WhatsApp, or a subscription that ended mid-visit, still shows the circle
    expect(homeMode({ current_visit: visit, subscriptions: [] })).toBe('visit');
  });

  it('names the held place first by status, with «+n» for the others', () => {
    const held = heldSubscriptions({
      subscriptions: [
        sub({ status: 'frozen', venue_name_ar: 'نادي الشاطئ' }),
        sub({ status: 'pending_payment', venue_name_ar: 'لا يُعدّ' }),
        sub({ status: 'active' }),
      ],
    });
    expect(held.map((s) => s.status)).toEqual(['active', 'frozen']);
    expect(subscribedChip(held, ar, 'ar')).toBe('مشترك · ⁨برج الأعمال⁩ (+1)');
    expect(subscribedChip(held.slice(0, 1), ar, 'ar')).toBe('مشترك · ⁨برج الأعمال⁩');
    expect(subscribedChip(held.slice(0, 1), ar, 'en')).toContain('Business Tower');
  });

  it('says when the subscription renews or ends, or why it needs attention', () => {
    expect(subscriptionLine(sub({}), ar)).toBe('يتجدد ⁨2026-12-25⁩ · شهري');
    expect(subscriptionLine(sub({ billing_cycle: 'yearly' }), ar)).toContain('سنوي');
    expect(subscriptionLine(sub({ cancel_at_period_end: true }), ar)).toBe('لن يتجدد · ينتهي ⁨2026-12-25⁩');
    expect(subscriptionLine(sub({ status: 'past_due' }), ar)).toBe(ar.home.subPastDue);
    expect(subscriptionLine(sub({ status: 'frozen' }), ar)).toBe(ar.home.subFrozen);
    expect(subscriptionLine(sub({ current_period_end: null }), ar)).toBe('شهري');
  });

  it('lists only the places that sell a subscription, with the monthly price and a short pin', () => {
    const cards = placeCards(
      [
        loc({}),
        loc({ venue_id: '00000000-0000-4000-8000-0000000000b2', subscriptions_enabled: false }),
        loc({ venue_id: '00000000-0000-4000-8000-0000000000b3', monthly_from_halalas: null }),
        loc({ venue_id: '00000000-0000-4000-8000-0000000000b4', distance_m: null, open_now: null }),
      ],
      ar,
      'ar',
    );
    expect(cards.map((c) => c.id)).toEqual([
      '00000000-0000-4000-8000-0000000000b1',
      '00000000-0000-4000-8000-0000000000b4',
    ]);
    expect(cards[0]).toMatchObject({ title: 'مستشفى النخيل', category: 'hospital', pin: '175 ر.س' });
    expect(cards[0]?.price).toContain('175.00');
    expect(cards[0]?.facts).toContain(ar.home.openNow);
    expect(cards[1]?.facts).toBe('');
  });

  it('places the pins by their coordinates inside the margins, north up and east right', () => {
    const cards = placeCards(
      [
        loc({ venue_id: '00000000-0000-4000-8000-0000000000d1', lat: 24.8, lng: 46.6 }),
        loc({ venue_id: '00000000-0000-4000-8000-0000000000d2', lat: 24.6, lng: 46.8 }),
        loc({ venue_id: '00000000-0000-4000-8000-0000000000d3', lat: null, lng: null }),
      ],
      ar,
      'ar',
    );
    const spots = pinSpots(cards, 0.1);
    expect(spots).toHaveLength(2);
    // the northern, western place is at the top left; the southern, eastern one at the bottom right
    expect(spots[0]).toMatchObject({ x: 0.1, y: 0.1 });
    expect(spots[1]?.x).toBeCloseTo(0.9);
    expect(spots[1]?.y).toBeCloseTo(0.9);
    // one place sits in the middle
    expect(pinSpots(cards.slice(0, 1))).toEqual([{ id: cards[0]?.id, x: 0.5, y: 0.5 }]);
    expect(pinSpots([])).toEqual([]);
  });
});
