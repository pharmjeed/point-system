/**
 * DEC-640: C-08 «اختر باقتك» priced by the working day of the place.
 */
import type { CustomerLocationDetail, CustomerLocationPlan } from '@point/shared/customer';
import { describe, expect, it } from 'vitest';
import { FAKE_LOCATIONS } from '../src/api/fake/seed';
import { dayBasis, defaultChoice, openDaysPerWeek, planChoices, workingDays } from '../src/features/pricing';
import { ar } from '../src/i18n/ar';

const tower = FAKE_LOCATIONS.find((l) => l.name_ar === 'برج الأعمال — العليا') as CustomerLocationDetail;
const university = FAKE_LOCATIONS.find((l) => l.name_ar.startsWith('جامعة الأفق')) as CustomerLocationDetail;
const strip = (s: string) => s.replace(/[⁦-⁩]/g, '');

describe('C-08 plan cards priced by the day (DEC-640)', () => {
  it('counts the open days of a week and the working days of a cycle', () => {
    expect(openDaysPerWeek(tower.opening_hours)).toBe(5);
    expect(openDaysPerWeek({ always_open: true, days: {} })).toBe(7);
    expect(openDaysPerWeek({ always_open: false, days: { sun: [] } })).toBeNull();
    expect(workingDays(5, 'yearly')).toBe(260);
    expect(workingDays(5, 'monthly')).toBeCloseTo(21.667, 3);
  });

  it('prices the tower yearly first and best, then monthly, with the saving against 25 SAR a visit', () => {
    const [yearly, monthly, ...rest] = planChoices(tower, ar);
    expect(rest).toEqual([]);
    expect(yearly).toMatchObject({ cycle: 'yearly', title: ar.subscribe.yearly, totalHalalas: 345000 });
    expect(strip(yearly!.perDay)).toBe('13.27 ر.س'); // 3,450 ÷ 260
    expect(yearly!.badge).toBe('الأوفر · وفّر 17%');
    expect(strip(yearly!.saves ?? '')).toBe('توفّر 3,050.00 ر.س في السنة مقارنة بالدفع لكل زيارة');
    expect(strip(yearly!.action)).toBe('اشترك سنويًا · 3,450.00 ر.س');
    expect(monthly).toMatchObject({ cycle: 'monthly', badge: null });
    expect(strip(monthly!.perDay)).toBe('15.92 ر.س'); // 345 ÷ 21.67
    expect(strip(monthly!.total)).toBe('345.00 ر.س كل شهر · ألغِ التجديد متى شئت');
    expect(defaultChoice([yearly!, monthly!])).toBe(yearly);
    expect(dayBasis(tower, ar)).toBe('سعر اليوم على أساس 5 أيام دوام في الأسبوع · الأسعار شاملة الضريبة.');
  });

  it('prices a counted-day plan by its own service days', () => {
    const [term] = planChoices(university, ar);
    const plan = university.plans[0] as CustomerLocationPlan;
    expect(term).toMatchObject({ cycle: 'monthly', title: plan.name_ar, badge: null });
    expect(strip(term!.total)).toBe(`172.50 ر.س لكل ${plan.policy.service_days} يوم خدمة`);
    expect(strip(term!.perDay)).toBe('7.84 ر.س'); // 172.50 ÷ 22
  });

  it('names the plan on every card when a place sells several, and marks only the cheapest a day', () => {
    const club = FAKE_LOCATIONS.find((l) => l.plans.length > 1) as CustomerLocationDetail;
    const choices = planChoices(club, ar);
    expect(choices).toHaveLength(4);
    expect(choices.every((c) => c.title.includes(' · '))).toBe(true);
    expect(choices.filter((c) => c.badge !== null)).toHaveLength(1);
  });

  it('skips sold-out plans as the default, and offers nothing without subscriptions', () => {
    const soldOut = {
      ...tower,
      plans: tower.plans.map((p) => ({ ...p, sold_out: true })),
    } satisfies CustomerLocationDetail;
    expect(defaultChoice(planChoices(soldOut, ar))).toBeNull();
    expect(planChoices({ ...tower, subscriptions_enabled: false }, ar)).toEqual([]);
  });
});
