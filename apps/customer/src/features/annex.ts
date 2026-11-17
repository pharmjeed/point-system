/**
 * The subscriptions annex in the app (V2-036 / V2-037; docs/v2/04 §7; DEC-590 … DEC-605), the pure part: what C-09
 * shows of a plan before payment (who it is for, its service days and the dates if paid now, the net price, the VAT
 * and the total, its policies, the announced closures, the consent it needs), what C-14 says of a service-day term
 * (one date range, the days left, eligibility, freeze), the freeze screen's choices and preview, and the complaints.
 * The server decides every date, day count, amount and permission; these only present them.
 *
 * Copy (DEC-610, DEC-611): one short idea per line, one word per idea (الاشتراك، الباقة، الدورة، يوم الخدمة، التجميد،
 * التجديد), counts with their Arabic forms (`countText`: «22 يوم خدمة»، «متبقٍ 18 يومًا»), dates as «8 نوفمبر» and
 * ranges as «8 نوفمبر – 7 ديسمبر 2026» with non-breaking spaces inside each date. The legal detail is on C-24.
 */
import {
  addDays,
  COMPLAINT_CATEGORIES,
  countServiceDays,
  freezeRequestCheck,
  isServiceDay,
  maskOfWeekdays,
  nthServiceDay,
  riyadhDate,
  weekdayOf,
  type ComplaintCategory,
  type CustomerComplaint,
  type CustomerLocationPlan,
  type CustomerPlanPolicy,
  type CustomerSubscription,
  type CustomerVenueClosure,
  type FreezeRequestIssue,
} from '@point/shared/customer';
import { fmt, isolate, type Dictionary } from '../i18n';
import { countText, formatDate, formatMoney } from '../i18n/format';

const NBSP = ' ';

/** «22 يوم خدمة» / «22 service days». */
export const serviceDaysText = (n: number, dict: Dictionary) => countText(n, dict.units.serviceDay);
/** «18 يومًا» / «18 days». */
export const daysText = (n: number, dict: Dictionary) => countText(n, dict.units.day);

const parts = (day: string) => day.split('-').map(Number) as [number, number, number];

/** `2026-11-08` → «8 نوفمبر» / «8 Nov» (one unbreakable piece). */
export function dayMonth(day: string, dict: Dictionary): string {
  const [, m, d] = parts(day);
  return `${d}${NBSP}${dict.annex.months[m - 1] ?? ''}`;
}

/** `2026-11-08` → «8 نوفمبر 2026». */
export function dateText(day: string, dict: Dictionary): string {
  return `${dayMonth(day, dict)}${NBSP}${parts(day)[0]}`;
}

/** An instant → its Riyadh day as «8 نوفمبر 2026». */
export const instantText = (iso: string, dict: Dictionary) => dateText(formatDate(iso), dict);

/** `2026-11-08` → «الأحد 8 نوفمبر» — the freeze screen's days, where the weekday matters. */
export function dayText(day: string, dict: Dictionary): string {
  return `${dict.annex.weekdays[weekdayOf(day)] ?? ''} ${dayMonth(day, dict)}`;
}

/** «8 نوفمبر – 7 ديسمبر 2026»; the year on both ends only when it changes. */
export function rangeText(start: string, end: string, dict: Dictionary): string {
  const sameYear = parts(start)[0] === parts(end)[0];
  return fmt(dict.annex.range, {
    start: sameYear ? dayMonth(start, dict) : dateText(start, dict),
    end: dateText(end, dict),
  });
}

/** The weekdays of a service-day plan as a range («من الأحد إلى الخميس») — the first and the last. */
function weekdaysText(days: readonly number[], dict: Dictionary): { from: string; to: string } {
  const names = days.map((d) => dict.annex.weekdays[d] ?? '');
  return { from: names[0] ?? '', to: names.at(-1) ?? '' };
}

/** A plan's purchase consent is required before paying (DEC-601, the same rule as the server's). */
export function consentRequired(
  p: Pick<CustomerPlanPolicy, 'refund_policy' | 'renewal_mode' | 'eligibility'>,
) {
  return p.refund_policy === 'non_refundable' || p.renewal_mode === 'manual' || p.eligibility !== 'none';
}

/** «تجميد مرة واحدة في كل دورة، حتى 5 أيام خدمة» — or null when the plan has no freeze. */
export function freezeRule(p: CustomerPlanPolicy, dict: Dictionary, template: string): string | null {
  if (p.freeze_max_times <= 0 || !p.freeze_max_days) return null;
  return fmt(template, {
    times: countText(p.freeze_max_times, dict.units.time),
    days: serviceDaysText(p.freeze_max_days, dict),
  });
}

export type PolicyIcon =
  'graduation-cap' | 'car' | 'calendar-days' | 'snowflake' | 'rotate-ccw' | 'receipt' | 'info' | 'user';

export interface PlanAnnex {
  audience: string | null;
  term: string | null;
  countedNote: string | null;
  preview: string | null;
  soldOut: boolean;
  breakdown: { net: string; vat: string; vatLabel: string; total: string } | null;
  /** the plan's rules, one short line each, with the icon C-09 shows next to it */
  bullets: ReadonlyArray<{ icon: PolicyIcon; text: string }>;
  needsEligibility: boolean;
  needsConsent: boolean;
  nonRefundable: boolean;
  manualRenewal: boolean;
}

/** What C-09 shows of a plan before payment (annex clauses 1–3, 5, 6); the full rules are on C-24. */
export function planAnnex(plan: CustomerLocationPlan, dict: Dictionary): PlanAnnex {
  const p = plan.policy;
  const a = dict.annex;
  const bullets: { icon: PolicyIcon; text: string }[] = [];
  if (p.eligibility !== 'none') bullets.push({ icon: 'graduation-cap', text: a.policy.eligibility });
  if (p.daily_visit_limit === 1) bullets.push({ icon: 'car', text: a.policy.daily });
  else if (p.daily_visit_limit)
    bullets.push({
      icon: 'car',
      text: fmt(a.policy.dailyN, { n: countText(p.daily_visit_limit, dict.units.visit) }),
    });
  if (p.term_kind === 'service_days') {
    bullets.push({ icon: 'calendar-days', text: a.policy.serviceDays });
    bullets.push({ icon: 'calendar-days', text: a.policy.holidays });
  }
  if (p.vehicle_change === 'any_time') bullets.push({ icon: 'car', text: a.policy.vehicleAnyTime });
  const freeze = freezeRule(p, dict, a.policy.freeze);
  if (freeze) bullets.push({ icon: 'snowflake', text: freeze });
  if (p.renewal_mode === 'manual') bullets.push({ icon: 'rotate-ccw', text: a.policy.manual });
  if (p.refund_policy === 'non_refundable') bullets.push({ icon: 'receipt', text: a.policy.nonRefundable });
  if (p.closure_policy === 'continue') bullets.push({ icon: 'info', text: a.policy.continueClosure });
  if (p.eligibility !== 'none' || p.term_kind === 'service_days')
    bullets.push({ icon: 'user', text: a.policy.personal });
  const b = plan.monthly_breakdown;
  const counted = p.term_kind === 'service_days' && p.service_days && p.service_weekdays;
  const term = counted
    ? fmt(a.countedTerm, {
        days: serviceDaysText(p.service_days as number, dict),
        ...weekdaysText(p.service_weekdays as number[], dict),
      })
    : null;
  return {
    audience: plan.audience_ar ? fmt(a.audience, { audience: plan.audience_ar }) : null,
    term,
    countedNote: counted
      ? fmt(a.countedNote, { days: serviceDaysText(p.service_days as number, dict) })
      : null,
    preview: plan.term_preview
      ? fmt(a.termPreview, {
          range: rangeText(plan.term_preview.starts_on, plan.term_preview.ends_on, dict),
        })
      : null,
    soldOut: plan.sold_out,
    breakdown: b
      ? {
          net: isolate(formatMoney(b.net_halalas, dict)),
          vat: isolate(formatMoney(b.vat_halalas, dict)),
          vatLabel: fmt(a.vat, { pct: b.vat_rate_bp / 100 }),
          total: isolate(formatMoney(b.total_halalas, dict)),
        }
      : null,
    bullets,
    needsEligibility: p.eligibility !== 'none',
    needsConsent: consentRequired(p),
    nonRefundable: p.refund_policy === 'non_refundable',
    manualRenewal: p.renewal_mode === 'manual',
  };
}

/** The announced closures of C-09, one line each: «إجازة منتصف الفصل · 27 ديسمبر 2026 – 7 يناير 2027». */
export function closureLines(closures: readonly CustomerVenueClosure[], dict: Dictionary): string[] {
  return closures.map((c) =>
    fmt(dict.annex.closureRange, { reason: c.reason_ar, range: rangeText(c.starts_on, c.ends_on, dict) }),
  );
}

/** The application form of a plan checked for eligibility: the issue to show, or null. */
export function applicationIssue(number: string, name: string, dict: Dictionary): string | null {
  if (!/^[A-Za-z0-9-]{3,32}$/.test(number.trim())) return dict.annex.numberInvalid;
  if (name.trim().length < 2) return dict.annex.nameInvalid;
  return null;
}

export interface SubscriptionAnnex {
  /** the eligibility and refund lines C-14 adds under the card's status, most important first */
  lines: string[];
  /** the term as one compact range («8 نوفمبر – 7 ديسمبر 2026»), null without a service-day term in progress */
  period: string | null;
  /** «متبقٍ 18 يومًا من 22» */
  remaining: string | null;
  /** 0 … 1 of the service days used, for the progress bar (null without a service-day term) */
  progress: number | null;
  /** the freeze in short lines: its state, its dates, the new end */
  freezeLines: string[];
  /** «غير قابل للاسترداد · التجديد بطلبك» while the subscription is live, else null */
  policyNote: string | null;
}

/** What C-14 says of a subscription under the annex (eligibility, service days, freeze, refund due). */
export function subscriptionAnnex(s: CustomerSubscription, dict: Dictionary): SubscriptionAnnex {
  const a = dict.annex;
  const lines: string[] = [];
  const e = s.eligibility;
  if (s.status === 'pending_eligibility' && e)
    lines.push(fmt(a.pendingEligibility, { number: isolate(e.student_number_masked) }));
  if (s.status === 'pending_payment' && e?.status === 'approved' && s.pending_expires_at)
    lines.push(fmt(a.approvedPay, { date: instantText(s.pending_expires_at, dict) }));
  if (e?.status === 'rejected') lines.push(fmt(a.rejected, { reason: e.reason ?? '' }));
  let period: string | null = null;
  let remaining: string | null = null;
  let progress: number | null = null;
  if (s.service_start_on && s.service_end_on) {
    if (s.status === 'active' || s.status === 'frozen' || s.status === 'past_due') {
      period = rangeText(s.service_start_on, s.service_end_on, dict);
      const total = s.policy.service_days ?? 0;
      if (s.remaining_days !== null && total > 0) {
        remaining = fmt(a.remaining, { days: daysText(s.remaining_days, dict), total });
        progress = Math.min(1, Math.max(0, (total - s.remaining_days) / total));
      }
    } else if (s.ended_reason === 'term_completed') lines.push(a.endedTerm);
  }
  if (s.refund_due_at) lines.push(fmt(a.refundDue, { date: instantText(s.refund_due_at, dict) }));
  const freezeLines: string[] = [];
  const f = s.freeze;
  const newEnd = f?.projected_end_on
    ? fmt(a.freezeNewEnd, { end: dateText(f.projected_end_on, dict) })
    : null;
  if (f?.status === 'scheduled') {
    freezeLines.push(fmt(a.freezeScheduled, { days: serviceDaysText(f.days, dict) }));
    freezeLines.push(
      fmt(a.freezeDates, { start: dayMonth(f.starts_on, dict), return: dayMonth(f.returns_on, dict) }),
    );
    if (newEnd) freezeLines.push(newEnd);
  } else if (f?.status === 'active') {
    freezeLines.push(fmt(a.freezeActive, { date: dayMonth(f.returns_on, dict) }));
    if (newEnd) freezeLines.push(newEnd);
  } else if (f?.status === 'completed')
    freezeLines.push(fmt(a.freezeUsed, { days: serviceDaysText(f.used_days ?? f.days, dict) }));
  const live = s.status !== 'canceled' && s.status !== 'expired' && s.status !== 'pending_eligibility';
  const notes = [
    s.policy.refund_policy === 'non_refundable' ? a.nonRefundableNote : null,
    s.policy.renewal_mode === 'manual' ? a.manualRenewalNote : null,
  ].filter((x): x is string => x !== null);
  return {
    lines,
    period,
    remaining,
    progress,
    freezeLines,
    policyNote: live && notes.length > 0 ? notes.join(' · ') : null,
  };
}

/** The service days a freeze may start on or return on: the next `count` service days after today. */
export function freezeDayChoices(
  today: string,
  weekdays: readonly number[],
  count: number,
  from: string = addDays(today, 1),
): string[] {
  const mask = maskOfWeekdays(weekdays);
  const out: string[] = [];
  for (let d = from; out.length < count; d = addDays(d, 1)) if (isServiceDay(d, mask)) out.push(d);
  return out;
}

export interface FreezePreview {
  ok: boolean;
  days: number;
  issue: string | null;
  newEnd: string | null;
}

/**
 * The freeze screen's preview (the server's own rule, `freezeRequestCheck`): the service days frozen and the term's
 * new last day when the freeze runs as asked.
 */
export function freezePreview(
  s: CustomerSubscription,
  startsOn: string | null,
  returnsOn: string | null,
  today: string,
  dict: Dictionary,
): FreezePreview {
  const p = s.policy;
  if (!startsOn || !returnsOn || !s.service_start_on || !s.service_end_on || !p.service_weekdays)
    return { ok: false, days: 0, issue: null, newEnd: null };
  const mask = maskOfWeekdays(p.service_weekdays);
  const max = p.freeze_max_days ?? 0;
  const r = freezeRequestCheck({
    today,
    startsOn,
    returnsOn,
    term: { startOn: s.service_start_on, endOn: s.service_end_on },
    mask,
    maxDays: max,
  });
  if (!r.ok)
    return {
      ok: false,
      days: countServiceDays(startsOn, returnsOn, mask),
      issue: fmt(dict.annex.freezeIssues[r.issue as FreezeRequestIssue], { max: serviceDaysText(max, dict) }),
      newEnd: null,
    };
  const remaining = countServiceDays(startsOn, addDays(s.service_end_on, 1), mask);
  return { ok: true, days: r.days, issue: null, newEnd: nthServiceDay(returnsOn, remaining, mask) };
}

/** Today in Riyadh on the device's clock (the server decides; this only previews). */
export const todayRiyadh = (now: number = Date.now()) => riyadhDate(new Date(now));

export const complaintCategories = (dict: Dictionary) =>
  COMPLAINT_CATEGORIES.map((c: ComplaintCategory) => ({ value: c, label: dict.annex.categories[c] }));

export function complaintCard(c: CustomerComplaint, dict: Dictionary) {
  return {
    title: dict.annex.categories[c.category],
    reference: fmt(dict.annex.complaintReference, { reference: isolate(c.reference) }),
    status: dict.annex.complaintStatus[c.status],
    tone:
      c.status === 'resolved'
        ? ('success' as const)
        : c.status === 'closed'
          ? ('muted' as const)
          : ('warning' as const),
    note: c.resolution_note ? fmt(dict.annex.complaintNote, { note: c.resolution_note }) : null,
    date: instantText(c.created_at, dict),
  };
}

/** The complaint form's issue, or null (the server checks it again). */
export function complaintIssue(body: string, dict: Dictionary): string | null {
  return body.trim().length < 10 ? dict.annex.complaintBodyShort : null;
}
