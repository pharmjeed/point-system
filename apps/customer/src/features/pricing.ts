/**
 * C-08 «اختر باقتك» (owner's option 1, DEC-640): every way to subscribe at a place as a card, priced by the day.
 *
 * The day is a **working day of the place**, not a calendar day, so the number is honest: a place open five days a
 * week has 5 × 52 = 260 days a year and 260 ÷ 12 ≈ 21.7 a month (always open: 7 a week). A plan of counted service
 * days (the student plan, DEC-590) is priced by its own days. Next to it, what the same days would cost at the
 * per-visit price, when the place has one. The yearly cards come first, the cheapest per day marked «الأوفر».
 * Prices are VAT-inclusive halalas from the server; nothing is rounded before the end. Pure.
 */
import type { CustomerLocationDetail, CustomerLocationPlan, OpeningHours } from '@point/shared/customer';
import { fmt, isolate, type Dictionary } from '../i18n';
import { formatMoney } from '../i18n/format';
import { yearlySavingPct } from './subscriptions';

export type PlanCycle = 'monthly' | 'yearly';

/** Days the place opens in a week (1 … 7), or null when its hours are unknown. */
export function openDaysPerWeek(hours: OpeningHours): number | null {
  if (hours.always_open) return 7;
  const n = Object.values(hours.days).filter((d) => (d?.length ?? 0) > 0).length;
  return n > 0 ? n : null;
}

/** Working days in a cycle: a week's open days over 52 weeks (a month is a twelfth of it). */
export const workingDays = (perWeek: number, cycle: PlanCycle): number =>
  cycle === 'yearly' ? perWeek * 52 : (perWeek * 52) / 12;

export interface PlanChoice {
  key: string;
  planId: string;
  cycle: PlanCycle;
  title: string;
  /** «13.27 ر.س» */
  perDay: string;
  perDayHalalas: number;
  /** «3,450.00 ر.س تدفعها مرة واحدة للسنة» */
  total: string;
  totalHalalas: number;
  /** «الأوفر · وفّر 17%» on the cheapest per day (yearly), else null */
  badge: string | null;
  /** «توفّر 3,050.00 ر.س في السنة مقارنة بالدفع لكل زيارة», when it saves */
  saves: string | null;
  soldOut: boolean;
  /** «اشترك سنويًا · 3,450.00 ر.س» */
  action: string;
}

const money = (h: number, dict: Dictionary) => isolate(formatMoney(Math.round(h), dict));

function serviceDays(plan: CustomerLocationPlan): number | null {
  return plan.policy.term_kind === 'service_days' && plan.policy.service_days
    ? plan.policy.service_days
    : null;
}

/** The subscription choices of a place, yearly first, then monthly, then counted-day terms. */
export function planChoices(loc: CustomerLocationDetail, dict: Dictionary): PlanChoice[] {
  if (!loc.subscriptions_enabled) return [];
  const perWeek = openDaysPerWeek(loc.opening_hours) ?? 7;
  const visit = loc.pay_per_visit_halalas;
  const many = loc.plans.length > 1;
  const choices: PlanChoice[] = [];
  for (const plan of loc.plans) {
    const named = (cycleTitle: string) => (many ? `${cycleTitle} · ${plan.name_ar}` : cycleTitle);
    const days = serviceDays(plan);
    if (days !== null && plan.monthly_price_halalas !== null) {
      const total = plan.monthly_price_halalas;
      const visits = visit !== null ? visit * days - total : 0;
      choices.push({
        key: `${plan.plan_id}:monthly`,
        planId: plan.plan_id,
        cycle: 'monthly',
        title: plan.name_ar,
        perDay: money(total / days, dict),
        perDayHalalas: total / days,
        total: fmt(dict.locations.plan.totalTerm, { amount: money(total, dict), n: days }),
        totalHalalas: total,
        badge: null,
        saves: visits > 0 ? fmt(dict.locations.plan.savesTerm, { amount: money(visits, dict) }) : null,
        soldOut: plan.sold_out,
        action: fmt(dict.locations.plan.subscribeTerm, { amount: money(total, dict) }),
      });
      continue;
    }
    for (const cycle of ['yearly', 'monthly'] as const) {
      const total = cycle === 'yearly' ? plan.yearly_price_halalas : plan.monthly_price_halalas;
      if (total === null) continue;
      const days = workingDays(perWeek, cycle);
      const visits = visit !== null ? visit * days - total : 0;
      const pct = cycle === 'yearly' ? yearlySavingPct(plan) : null;
      choices.push({
        key: `${plan.plan_id}:${cycle}`,
        planId: plan.plan_id,
        cycle,
        title: named(cycle === 'yearly' ? dict.subscribe.yearly : dict.subscribe.monthly),
        perDay: money(total / days, dict),
        perDayHalalas: total / days,
        total: fmt(cycle === 'yearly' ? dict.locations.plan.totalYearly : dict.locations.plan.totalMonthly, {
          amount: money(total, dict),
        }),
        totalHalalas: total,
        badge: pct !== null && pct > 0 ? fmt(dict.locations.plan.best, { pct }) : null,
        saves:
          visits > 0
            ? fmt(cycle === 'yearly' ? dict.locations.plan.savesYear : dict.locations.plan.savesMonth, {
                amount: money(visits, dict),
              })
            : null,
        soldOut: plan.sold_out,
        action: fmt(
          cycle === 'yearly' ? dict.locations.plan.subscribeYearly : dict.locations.plan.subscribeMonthly,
          { amount: money(total, dict) },
        ),
      });
    }
  }
  // «الأوفر» only on the cheapest per day among those that carry a yearly saving
  const best = choices
    .filter((c) => c.badge !== null)
    .reduce<PlanChoice | null>((a, c) => (a === null || c.perDayHalalas < a.perDayHalalas ? c : a), null);
  return choices.map((c) => (c === best ? c : { ...c, badge: null }));
}

/** The choice shown selected first: the marked best one that can be bought, else the first that can. */
export function defaultChoice(choices: readonly PlanChoice[]): PlanChoice | null {
  return choices.find((c) => c.badge !== null && !c.soldOut) ?? choices.find((c) => !c.soldOut) ?? null;
}

/** The line under the cards: what «لليوم» means here. */
export function dayBasis(loc: CustomerLocationDetail, dict: Dictionary): string {
  const perWeek = openDaysPerWeek(loc.opening_hours);
  return perWeek === null || perWeek === 7
    ? dict.locations.plan.basisAll
    : fmt(dict.locations.plan.basis, { n: perWeek });
}
