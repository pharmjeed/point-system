/**
 * C-24 «الشروط والأحكام» (DEC-614 … DEC-616), the pure part of the screen: the document of the app's language, the
 * plan values when the screen is opened from a service-day plan (C-09 «اطّلع على الشروط والأحكام», C-14 «الشروط»),
 * and the rendered sections. Without a plan (C-19, C-04) the clauses name «the plan's» value with the current student
 * plan's in brackets (`TermsDocument.generic`).
 */
import type { CustomerPlanPolicy } from '@point/shared/customer';
import { renderTerms, type RenderedTerms, type TermsDocument, type TermsValues } from '../legal/terms';
import { termsAr } from '../legal/terms.ar';
import { termsEn } from '../legal/terms.en';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { countText, formatMoney } from '../i18n/format';
import { serviceDaysText } from './annex';

export const termsDocument = (locale: AppLocale): TermsDocument => (locale === 'en' ? termsEn : termsAr);

/** The plan the terms are read for: its name, policies and price before VAT (when known). */
export interface TermsPlan {
  name: string;
  policy: CustomerPlanPolicy;
  /** the price of a term before VAT, in halalas (C-09's breakdown); null on C-14 (the total is all it knows) */
  netHalalas: number | null;
}

const WORDS = {
  ar: {
    and: ' و',
    list: '، ',
    week: (from: string, to: string) => `من ${from} إلى ${to}`,
    price: (amount: string) => `${amount} قبل الضريبة لكل دورة`,
    daily: (visits: string) => `${visits} يوميًا`,
    freeze: (times: string, days: string) => `${times} في كل دورة، حتى ${days}`,
    freezeDays: (days: string) => `حد التجميد (${days})`,
  },
  en: {
    and: ' and ',
    list: ', ',
    week: (from: string, to: string) => `${from} to ${to}`,
    price: (amount: string) => `${amount} before VAT, per term`,
    daily: (visits: string) => `${visits} a day`,
    freeze: (times: string, days: string) => `${times} per term, for up to ${days}`,
    freezeDays: (days: string) => `the freeze limit (${days})`,
  },
} as const;

/**
 * The values of a service-day plan for the clauses. A value the plan cannot give (no daily limit, no freeze, no price
 * before VAT, every weekday a service day) keeps the generic wording of the document.
 */
export function planTermsValues(plan: TermsPlan, locale: AppLocale, dict: Dictionary): TermsValues {
  const doc = termsDocument(locale);
  const w = WORDS[locale];
  const p = plan.policy;
  const out: Record<keyof TermsValues, string> = { ...doc.generic };
  if (p.term_kind !== 'service_days' || !p.service_days || !p.service_weekdays?.length) return out;
  const names = (days: readonly number[]) => days.map((d) => dict.annex.weekdays[d] ?? '');
  const on = [...p.service_weekdays].sort((x, y) => x - y);
  out.serviceDays = serviceDaysText(p.service_days, dict);
  out.serviceWeek = w.week(names(on)[0] ?? '', names(on).at(-1) ?? '');
  const off = [0, 1, 2, 3, 4, 5, 6].filter((d) => !on.includes(d));
  if (off.length > 0) {
    const n = names(off);
    out.offDays = n.length === 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(w.list)}${w.and}${n.at(-1)}`;
  }
  if (plan.netHalalas !== null) out.price = w.price(formatMoney(plan.netHalalas, dict));
  if (p.daily_visit_limit) out.dailyLimit = w.daily(countText(p.daily_visit_limit, dict.units.visit));
  if (p.freeze_max_times > 0 && p.freeze_max_days) {
    const days = serviceDaysText(p.freeze_max_days, dict);
    out.freezeLimit = w.freeze(countText(p.freeze_max_times, dict.units.time), days);
    out.freezeDays = w.freezeDays(days);
  }
  return out;
}

export interface TermsView extends RenderedTerms {
  /** «الأرقام هنا لباقة «باقة الطالب».» when a plan's values are shown, else null */
  planNote: string | null;
}

/** C-24's content: the document of the language with the brand, and the plan's values when a plan is given. */
export function termsView(
  locale: AppLocale,
  brand: string,
  dict: Dictionary,
  plan: TermsPlan | null = null,
): TermsView {
  const doc = termsDocument(locale);
  const counted = plan && plan.policy.term_kind === 'service_days';
  const values = counted ? planTermsValues(plan, locale, dict) : doc.generic;
  return {
    ...renderTerms(doc, brand, values, isolate),
    planNote: counted ? fmt(dict.terms.planValues, { plan: plan.name }) : null,
  };
}
