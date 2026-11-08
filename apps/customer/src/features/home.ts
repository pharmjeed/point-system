/**
 * C-06 view model (01 C-06): «بطاقة الدخول» first as the big action, the visit in progress above everything when
 * there is one, my subscriptions (C-14 since V2-032), then the nearby locations. Pure.
 */
import type { CustomerHome, CustomerLocationSummary } from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatDistance, formatMoney, formatTime } from '../i18n/format';

export type HomeSection = 'visit' | 'pass' | 'subscriptions' | 'nearby';

/** «الزيارة الجارية فوق كل شيء». */
export function homeSections(home: CustomerHome): HomeSection[] {
  return home.current_visit
    ? ['visit', 'pass', 'subscriptions', 'nearby']
    : ['pass', 'subscriptions', 'nearby'];
}

export function greeting(home: CustomerHome, dict: Dictionary): string {
  return home.display_name ? fmt(dict.home.greeting, { name: home.display_name }) : dict.home.greetingNoName;
}

export interface LocationRow {
  id: string;
  title: string;
  operator: string;
  /** Distance · open/closed · subscriptions; empty parts dropped. */
  facts: string[];
  price: string | null;
}

const localName = (ar: string, en: string | null, locale: AppLocale) => (locale === 'en' && en ? en : ar);

export function locationRow(loc: CustomerLocationSummary, dict: Dictionary, locale: AppLocale): LocationRow {
  const facts: string[] = [];
  if (loc.distance_m !== null) facts.push(isolate(formatDistance(loc.distance_m, dict)));
  if (loc.open_now !== null) facts.push(loc.open_now ? dict.home.openNow : dict.home.closedNow);
  if (loc.subscriptions_enabled) facts.push(dict.home.subscriptionsAvailable);
  const price =
    loc.monthly_from_halalas !== null
      ? fmt(dict.home.monthlyFrom, { amount: isolate(formatMoney(loc.monthly_from_halalas, dict)) })
      : loc.pay_per_visit_halalas !== null
        ? fmt(dict.home.perVisit, { amount: isolate(formatMoney(loc.pay_per_visit_halalas, dict)) })
        : null;
  return {
    id: loc.venue_id,
    title: localName(loc.name_ar, loc.name_en, locale),
    operator: fmt(dict.home.operatedBy, {
      operator: localName(loc.operator_name_ar, loc.operator_name_en, locale),
    }),
    facts,
    price,
  };
}

export interface VisitCard {
  status: string;
  venue: string;
  plate: string | null;
  since: string;
}

export function visitCard(home: CustomerHome, dict: Dictionary, locale: AppLocale): VisitCard | null {
  const v = home.current_visit;
  if (!v) return null;
  return {
    status: dict.ticketStatus[v.status],
    venue: fmt(dict.home.visitAt, { venue: localName(v.venue_name_ar, v.venue_name_en, locale) }),
    plate: v.plate_display ? isolate(v.plate_display) : null,
    since: isolate(formatTime(v.received_at)),
  };
}
