/**
 * The subscriptions annex in the app (V2-036 / V2-037; docs/v2/04 §7; DEC-590 … DEC-605), the pure part: what C-09
 * shows of a plan before payment (who it is for, its counted days and the dates if paid now, the net price, the VAT
 * and the total, its policies, the announced closures, the consent it needs), what C-14 says of a counted-day term
 * (period, remaining days, eligibility, freeze), the freeze sheet's choices and preview, and the complaints. The
 * server decides every date, day count, amount and permission; these only present them.
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
import { formatDate, formatMoney } from '../i18n/format';

/** `الأحد 2026-11-01` — a Riyadh date with its weekday (Western digits, isolated in a sentence). */
export function dayText(day: string, dict: Dictionary): string {
  // non-breaking hyphens: a date never wraps between its parts
  return `${dict.annex.weekdays[weekdayOf(day)] ?? ''} ${isolate(day.replace(/-/g, '\u2011'))}`;
}

/** The weekdays of a counted-day plan as a range («من الأحد إلى الخميس») when they are consecutive, else a list. */
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

export interface PlanAnnex {
  audience: string | null;
  term: string | null;
  countedNote: string | null;
  preview: string | null;
  soldOut: boolean;
  breakdown: { net: string; vat: string; vatLabel: string; total: string } | null;
  bullets: string[];
  needsEligibility: boolean;
  needsConsent: boolean;
  nonRefundable: boolean;
  manualRenewal: boolean;
}

/** What C-09 shows of a plan before payment (annex clauses 1–3, 5, 6). */
export function planAnnex(plan: CustomerLocationPlan, dict: Dictionary): PlanAnnex {
  const p = plan.policy;
  const a = dict.annex;
  const bullets: string[] = [];
  if (p.eligibility !== 'none') bullets.push(a.policy.eligibility);
  if (p.daily_visit_limit === 1) bullets.push(a.policy.daily);
  else if (p.daily_visit_limit) bullets.push(fmt(a.policy.dailyN, { n: p.daily_visit_limit }));
  if (p.term_kind === 'service_days') bullets.push(a.policy.serviceDays);
  if (p.vehicle_change === 'any_time') bullets.push(a.policy.vehicleAnyTime);
  if (p.freeze_max_times > 0 && p.freeze_max_days)
    bullets.push(fmt(a.policy.freeze, { days: p.freeze_max_days }));
  if (p.renewal_mode === 'manual') bullets.push(a.policy.manual);
  if (p.refund_policy === 'non_refundable') bullets.push(a.policy.nonRefundable);
  if (p.closure_policy === 'continue') bullets.push(a.policy.continueClosure);
  if (p.eligibility !== 'none' || p.term_kind === 'service_days') bullets.push(a.policy.personal);
  const b = plan.monthly_breakdown;
  const term =
    p.term_kind === 'service_days' && p.service_days && p.service_weekdays
      ? fmt(a.countedTerm, { days: p.service_days, ...weekdaysText(p.service_weekdays, dict) })
      : null;
  return {
    audience: plan.audience_ar ? fmt(a.audience, { audience: plan.audience_ar }) : null,
    term,
    countedNote: term ? fmt(a.countedNote, { days: p.service_days ?? 0 }) : null,
    preview: plan.term_preview
      ? fmt(a.termPreview, {
          start: dayText(plan.term_preview.starts_on, dict),
          end: dayText(plan.term_preview.ends_on, dict),
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

/** The announced closures of C-08 / C-09, one line each. */
export function closureLines(closures: readonly CustomerVenueClosure[], dict: Dictionary): string[] {
  return closures.map((c) =>
    fmt(dict.annex.closureRange, {
      reason: c.reason_ar,
      start: dayText(c.starts_on, dict),
      end: dayText(c.ends_on, dict),
    }),
  );
}

/** The application form of a plan checked for eligibility: the issue to show, or null. */
export function applicationIssue(number: string, name: string, dict: Dictionary): string | null {
  if (!/^[A-Za-z0-9-]{3,32}$/.test(number.trim())) return dict.annex.numberInvalid;
  if (name.trim().length < 2) return dict.annex.nameInvalid;
  return null;
}

export interface SubscriptionAnnex {
  /** the lines C-14 adds under the card's title, most important first */
  lines: string[];
  /** 0 … 1 of the counted days used, for the progress bar (null without a counted-day term) */
  progress: number | null;
  freezeLine: string | null;
  nonRefundable: boolean;
}

/** What C-14 says of a subscription under the annex (eligibility, counted days, freeze, refund due). */
export function subscriptionAnnex(
  s: CustomerSubscription,
  dict: Dictionary,
  today: string,
): SubscriptionAnnex {
  const a = dict.annex;
  const lines: string[] = [];
  const e = s.eligibility;
  if (s.status === 'pending_eligibility' && e)
    lines.push(fmt(a.pendingEligibility, { number: isolate(e.student_number_masked) }));
  if (s.status === 'pending_payment' && e?.status === 'approved' && s.pending_expires_at)
    lines.push(fmt(a.approvedPay, { date: isolate(formatDate(s.pending_expires_at)) }));
  if (e?.status === 'rejected') lines.push(fmt(a.rejected, { reason: e.reason ?? '' }));
  let progress: number | null = null;
  if (s.service_start_on && s.service_end_on) {
    if (s.status === 'active' || s.status === 'frozen' || s.status === 'past_due') {
      if (s.service_start_on > today)
        lines.push(fmt(a.startsOn, { date: dayText(s.service_start_on, dict) }));
      lines.push(
        fmt(a.period, { start: dayText(s.service_start_on, dict), end: dayText(s.service_end_on, dict) }),
      );
      const total = s.policy.service_days ?? 0;
      if (s.remaining_days !== null && total > 0) {
        lines.push(fmt(a.remaining, { n: s.remaining_days, total }));
        progress = Math.min(1, Math.max(0, (total - s.remaining_days) / total));
      }
    } else if (s.ended_reason === 'term_completed') lines.push(a.endedTerm);
  }
  if (s.refund_due_at) lines.push(fmt(a.refundDue, { date: isolate(formatDate(s.refund_due_at)) }));
  let freezeLine: string | null = null;
  const f = s.freeze;
  if (f?.status === 'scheduled')
    freezeLine = fmt(a.freezeScheduled, {
      start: dayText(f.starts_on, dict),
      end: dayText(f.returns_on, dict),
      days: f.days,
      projected: f.projected_end_on ? dayText(f.projected_end_on, dict) : '—',
    });
  else if (f?.status === 'active')
    freezeLine = fmt(a.freezeActive, {
      date: dayText(f.returns_on, dict),
      projected: f.projected_end_on ? dayText(f.projected_end_on, dict) : '—',
    });
  else if (f?.status === 'completed') freezeLine = fmt(a.freezeUsed, { days: f.used_days ?? f.days });
  return {
    lines,
    progress,
    freezeLine,
    nonRefundable:
      s.policy.refund_policy === 'non_refundable' && s.status !== 'canceled' && s.status !== 'expired',
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
 * The freeze sheet's preview (the server's own rule, `freezeRequestCheck`): the counted days frozen and the term's
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
      issue: fmt(dict.annex.freezeIssues[r.issue as FreezeRequestIssue], { max }),
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
    date: isolate(formatDate(c.created_at)),
  };
}

/** The complaint form's issue, or null (the server checks it again). */
export function complaintIssue(body: string, dict: Dictionary): string | null {
  return body.trim().length < 10 ? dict.annex.complaintBodyShort : null;
}
