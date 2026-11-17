/**
 * C-09 اختيار الباقة and C-14 اشتراكاتي (V2-032; docs/v2/01 R2, R6; DEC-532, DEC-534), the pure part: the plans of a
 * location for a cycle with the yearly saving, the vehicles the customer may cover, and what a subscription card
 * says and offers. The server decides every price, date and permission (`can_*`); these only present them.
 */
import type { CustomerLocationPlan, CustomerSubscription, CustomerVehicle } from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatMoney, formatTime } from '../i18n/format';
import { instantText, serviceDaysText } from './annex';

export type Cycle = 'monthly' | 'yearly';

/** The yearly saving against twelve monthly payments, in whole percent (null without both prices). */
export function yearlySavingPct(
  plan: Pick<CustomerLocationPlan, 'monthly_price_halalas' | 'yearly_price_halalas'>,
) {
  const m = plan.monthly_price_halalas;
  const y = plan.yearly_price_halalas;
  if (m === null || y === null || m <= 0) return null;
  const pct = Math.round((1 - y / (m * 12)) * 100);
  return pct > 0 ? pct : null;
}

export interface PlanOption {
  planId: string;
  title: string;
  price: number;
  priceText: string;
  vehicles: string;
  saving: string | null;
}

/** The plans sold for a cycle (a plan without that cycle's price is not offered). */
export function planOptions(
  plans: readonly CustomerLocationPlan[],
  cycle: Cycle,
  dict: Dictionary,
): PlanOption[] {
  return plans.flatMap((p) => {
    const price = cycle === 'yearly' ? p.yearly_price_halalas : p.monthly_price_halalas;
    if (price === null) return [];
    const pct = cycle === 'yearly' ? yearlySavingPct(p) : null;
    return [
      {
        planId: p.plan_id,
        title: p.name_ar,
        price,
        // a service-day plan is priced per term, not «شهريًا» (DEC-612)
        priceText: fmt(
          p.policy.term_kind === 'service_days'
            ? dict.subscribe.perTerm
            : cycle === 'yearly'
              ? dict.subscribe.perYear
              : dict.subscribe.perMonth,
          {
            amount: isolate(formatMoney(price, dict)),
          },
        ),
        vehicles: fmt(dict.subscribe.vehiclesIncluded, { n: p.vehicles_included }),
        saving: pct === null ? null : fmt(dict.subscribe.saving, { pct }),
      },
    ];
  });
}

/** The cycles a location sells (C-09 shows the toggle only when both exist). */
export function cyclesOf(plans: readonly CustomerLocationPlan[]): Cycle[] {
  const out: Cycle[] = [];
  if (plans.some((p) => p.monthly_price_halalas !== null)) out.push('monthly');
  if (plans.some((p) => p.yearly_price_halalas !== null)) out.push('yearly');
  return out;
}

/**
 * The covered vehicles chosen on C-09 / C-14: toggling one keeps at most `max` (the oldest choice leaves first), so
 * a one-car plan simply switches the car.
 */
export function toggleVehicle(chosen: readonly string[], id: string, max: number): string[] {
  if (chosen.includes(id)) return chosen.filter((v) => v !== id);
  const next = [...chosen, id];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** C-09's form is complete: a plan and 1 … its vehicles. */
export function subscribeIssue(
  planId: string | null,
  vehicles: readonly string[],
  dict: Dictionary,
): string | null {
  if (!planId) return dict.subscribe.choosePlan;
  if (vehicles.length === 0) return dict.subscribe.chooseVehicle;
  return null;
}

export interface SubscriptionCard {
  title: string;
  status: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  price: string;
  line: string | null;
  vehicles: string | null;
  nextPrice: string | null;
}

const TONE: Record<CustomerSubscription['status'], SubscriptionCard['tone']> = {
  pending_eligibility: 'warning',
  pending_payment: 'warning',
  active: 'success',
  past_due: 'danger',
  frozen: 'warning',
  canceled: 'muted',
  expired: 'muted',
};

/** What a C-14 card says: the venue, the state, the price and cycle, and the one line that matters now. */
export function subscriptionCard(
  s: CustomerSubscription,
  dict: Dictionary,
  locale: AppLocale,
): SubscriptionCard {
  // «7 ديسمبر 2026»: the dates of every card read alike (DEC-611)
  const day = (iso: string | null) => (iso ? instantText(iso, dict) : '');
  let line: string | null = null;
  if (s.status === 'pending_payment' && s.pending_expires_at)
    line = fmt(dict.subscriptions.pendingUntil, { time: isolate(formatTime(s.pending_expires_at)) });
  else if (s.status === 'past_due') line = fmt(dict.subscriptions.pastDue, { date: day(s.grace_ends_at) });
  else if (s.status === 'frozen') line = dict.subscriptions.frozen;
  else if (s.status === 'active' && s.cancel_at_period_end)
    line = fmt(dict.subscriptions.canceledAtEnd, { date: day(s.current_period_end) });
  else if (s.status === 'active' && s.renews_at)
    line = fmt(dict.subscriptions.renewsOn, { date: day(s.renews_at) });
  else if (s.ended_at) line = fmt(dict.subscriptions.ended, { date: day(s.ended_at) });
  const plates = s.vehicles
    .filter((v) => !v.removed && v.plate_display)
    .map((v) => isolate(v.plate_display as string));
  return {
    title: locale === 'en' && s.venue_name_en ? s.venue_name_en : s.venue_name_ar,
    status: dict.subscriptionStatus[s.status],
    tone: TONE[s.status],
    price: fmt(dict.subscriptions.price, {
      amount: isolate(formatMoney(s.price_halalas, dict)),
      // a service-day term is named by its days, never «شهري» (DEC-612)
      cycle:
        s.policy.term_kind === 'service_days' && s.policy.service_days
          ? serviceDaysText(s.policy.service_days, dict)
          : s.billing_cycle === 'yearly'
            ? dict.subscribe.yearly
            : dict.subscribe.monthly,
    }),
    line,
    vehicles: plates.length ? fmt(dict.subscriptions.vehicles, { plates: plates.join('، ') }) : null,
    nextPrice:
      s.next_price_halalas !== null
        ? fmt(dict.subscriptions.nextPrice, { amount: isolate(formatMoney(s.next_price_halalas, dict)) })
        : null,
  };
}

/** The account's cars a subscription may cover (C-09 / C-14's choice). */
export function coverableVehicles(vehicles: readonly CustomerVehicle[]) {
  return vehicles.map((v) => ({ id: v.id, label: v.plate.display }));
}
