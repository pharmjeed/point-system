/**
 * C-12 «سيارتي الآن» and C-16 «زياراتي» view models (V2-015; docs/v2/01 R3/R4, DEC-516 … DEC-518). Pure: the screen
 * renders what these return. The server stays the source of truth: every field comes from
 * `GET /v1/customer/visits/{ticketId}`, read again on each `visit.updated` and on every (re)connection.
 */
import type { CustomerVisitDetail, CustomerVisitStep, CustomerVisitSummary } from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatMoney, formatTime, riyadhParts } from '../i18n/format';

const localName = (ar: string, en: string | null, locale: AppLocale) => (locale === 'en' && en ? en : ar);

export type StepState = 'done' | 'current' | 'todo';

export interface VisitStepRow {
  step: CustomerVisitStep;
  label: string;
  time: string | null;
  state: StepState;
}

/** The step in progress for each ticket status (none when nothing is moving). */
const CURRENT: Partial<Record<CustomerVisitDetail['status'], CustomerVisitStep>> = {
  received: 'parked',
  parking: 'parked',
  reparking: 'parked',
  requested: 'accepted',
  assigned: 'on_the_way',
  assigned_waiting: 'on_the_way',
  retrieving: 'ready',
  ready: 'delivered',
};

export interface VisitView {
  title: string;
  venue: string;
  operator: string;
  plate: string | null;
  vehicle: string | null;
  steps: VisitStepRow[];
  /** «اطلب السيارة» is offered (with a confirmation) */
  canRequest: boolean;
  /** what the customer is waiting for, in one sentence */
  waiting: string | null;
  /** the handover code card: fetch the code now */
  showCode: boolean;
  /** why no code is shown at the gate (a WhatsApp visit, the staff's check, expired) */
  handoverNote: string | null;
  /** the money line of R4 (the «ادفع» area of V2-022 sits next to it) */
  payment: string | null;
  canRate: boolean;
  open: boolean;
}

export function paymentLine(p: CustomerVisitSummary['payment'], dict: Dictionary): string | null {
  if (p.entitlement === 'event_included') return dict.visit.payment.included;
  if (p.entitlement === 'subscription') return dict.visit.payment.subscription;
  if (p.entitlement === 'app_paid') return dict.visit.payment.appPaid;
  if (p.payment_status === 'due')
    return fmt(dict.visit.payment.due, { amount: isolate(formatMoney(p.fee_halalas, dict)) });
  if (p.payment_status === 'collected') return dict.visit.payment.collected;
  if (p.payment_status === 'waived') return dict.visit.payment.waived;
  return null;
}

export function visitView(v: CustomerVisitDetail, dict: Dictionary, locale: AppLocale): VisitView {
  const current = v.open ? CURRENT[v.status] : undefined;
  const steps = v.timeline
    // «requested … ready» only once the car has been asked for; the delivery once it happened or is next
    .filter((s) => s.at !== null || s.step === current || s.step === 'received' || s.step === 'parked')
    .map<VisitStepRow>((s) => ({
      step: s.step,
      label: dict.visit.steps[s.step],
      time: s.at ? isolate(formatTime(s.at)) : null,
      state: s.at !== null && s.step !== current ? 'done' : s.step === current ? 'current' : 'todo',
    }));
  let waiting: string | null = null;
  if (v.request.pending_early) waiting = dict.visit.waiting.early;
  else if (v.status === 'requested') waiting = dict.visit.waiting.requested;
  else if (v.status === 'assigned' || v.status === 'assigned_waiting') waiting = dict.visit.waiting.accepted;
  else if (v.status === 'retrieving') waiting = dict.visit.waiting.onTheWay;
  else if (v.status === 'ready') waiting = dict.visit.waiting.ready;
  else if (v.status === 'parking' || v.status === 'received') waiting = dict.visit.waiting.parking;
  else if (v.status === 'reparking') waiting = dict.visit.waiting.reparking;

  let handoverNote: string | null = null;
  if (v.status === 'ready' && !v.handover.code_available)
    handoverNote =
      v.handover.method === 'whatsapp'
        ? dict.visit.code.whatsapp
        : v.handover.method === 'staff'
          ? dict.visit.code.staff
          : dict.visit.code.unavailable;

  const vehicle = [
    v.vehicle_make
      ? ((dict.vehicleMakes as Readonly<Record<string, string>>)[v.vehicle_make] ?? v.vehicle_make)
      : null,
    v.vehicle_color
      ? ((dict.vehicleColors as Readonly<Record<string, string>>)[v.vehicle_color] ?? v.vehicle_color)
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    title: dict.ticketStatus[v.status],
    venue: localName(v.venue_name_ar, v.venue_name_en, locale),
    operator: fmt(dict.home.operatedBy, {
      operator: localName(v.operator_name_ar, v.operator_name_en, locale),
    }),
    plate: v.plate_display ? isolate(v.plate_display) : null,
    vehicle: vehicle || null,
    steps,
    canRequest: v.request.can_request,
    waiting,
    showCode: v.handover.code_available,
    handoverNote,
    payment: paymentLine(v.payment, dict),
    canRate: v.can_rate,
    open: v.open,
  };
}

/** `٢٠٢٦-١١-٠٧` → `7/11/2026` (Riyadh day, Western digits). */
export function formatDay(iso: string): string {
  const p = riyadhParts(iso);
  return `${p.day}/${p.month}/${p.year}`;
}

export interface VisitRow {
  id: string;
  title: string;
  subtitle: string;
  facts: string[];
  open: boolean;
}

/** One line of C-16: the day and venue, the status or the duration, the amount. */
export function visitRow(v: CustomerVisitSummary, dict: Dictionary, locale: AppLocale): VisitRow {
  const facts: string[] = [];
  if (v.open) facts.push(dict.ticketStatus[v.status]);
  else if (v.duration_min !== null)
    facts.push(fmt(dict.visits.duration, { minutes: isolate(String(v.duration_min)) }));
  const pay = paymentLine(v.payment, dict);
  if (pay) facts.push(pay);
  if (v.rated) facts.push(dict.visits.rated);
  return {
    id: v.ticket_id,
    title: localName(v.venue_name_ar, v.venue_name_en, locale),
    subtitle: `${isolate(formatDay(v.received_at))} · ${isolate(formatTime(v.received_at))}`,
    facts,
    open: v.open,
  };
}

/** Seconds left of the handover code (0 when expired), by the device clock corrected with the server's. */
export function codeSecondsLeft(expiresAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
}

/** The support link of C-12 «مساعدة»: the support WhatsApp number of the build (C-19), or none. */
export function helpLink(supportWhatsapp: string | null, dict: Dictionary): string | null {
  if (!supportWhatsapp) return null;
  return `https://wa.me/${supportWhatsapp}?text=${encodeURIComponent(dict.visit.helpMessage)}`;
}
