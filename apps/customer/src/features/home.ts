/**
 * C-06 view model (01 C-06). Since V2-UX option A «زر واحد» (DEC-620 … DEC-627): the greeting, the status pill over
 * the one circle that changes with the visit (its stage, colour and action below), the venue and plate or the nearest
 * location under it, and the shortcuts. Pure.
 */
import type { CustomerHome, CustomerHomeVisit, CustomerLocationSummary } from '@point/shared/customer';
import { fmt, isolate, type AppLocale, type Dictionary } from '../i18n';
import { formatDistance, formatMoney, formatTime } from '../i18n/format';

/** The greeting as one sentence (what screen readers hear): «مساء الخير، سارة» (the time of day alone without a name). */
export function greeting(
  home: Pick<CustomerHome, 'display_name'> | null,
  dict: Dictionary,
  part: 'morning' | 'evening',
): string {
  const time = dict.home[part];
  return home?.display_name ? fmt(dict.home.greetingTime, { part: time, name: home.display_name }) : time;
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

/**
 * The visit's stage on C-06 (DEC-581, kept by option A, DEC-620): what the status pill says, the circle's colour and
 * its stop (0 parked, 1 on the way, 2 ready), from the visit's status. The map of the ticket statuses:
 *
 * | status | stage | stop |
 * |---|---|---|
 * | `received`, `parking` | `parking` (`early` once requested while parking) | 0 متوقفة (1 when early) |
 * | `reparking` | `reparking` | 0 |
 * | `parked` | `parked` | 0 |
 * | `requested` | `requested` | 1 في الطريق |
 * | `assigned`, `assigned_waiting`, `retrieving` | `coming` | 1 |
 * | `ready` | `ready` | 2 جاهزة |
 *
 * No visit (or a closed one, which `current_visit` never holds) is `none`: «عند وصولك» and the entry pass.
 */
export type HomeStage =
  'none' | 'parking' | 'reparking' | 'parked' | 'early' | 'requested' | 'coming' | 'ready';

export function homeStage(status: CustomerHomeVisit['status'] | null, pendingEarly = false): HomeStage {
  switch (status) {
    case 'received':
    case 'parking':
      return pendingEarly ? 'early' : 'parking';
    case 'reparking':
      return 'reparking';
    case 'parked':
      return 'parked';
    case 'requested':
      return 'requested';
    case 'assigned':
    case 'assigned_waiting':
    case 'retrieving':
      return 'coming';
    case 'ready':
      return 'ready';
    default:
      return 'none';
  }
}

/** The stop of the stage (0 … 2), or null without a visit. */
export function homeStop(stage: HomeStage): number | null {
  switch (stage) {
    case 'none':
      return null;
    case 'parking':
    case 'reparking':
    case 'parked':
      return 0;
    case 'early':
    case 'requested':
    case 'coming':
      return 1;
    case 'ready':
      return 2;
  }
}

/**
 * What the circle does for the stage and what C-12's read allows (DEC-620): open the entry pass, **hold to request**
 * (DEC-621), open C-12 with the time since the request, show the handover code, or open C-12.
 */
export type HomeAction = 'pass' | 'hold' | 'elapsed' | 'code' | 'open';

export interface HomeActionDetail {
  request: { can_request: boolean; requested_at: string | null };
  handover: { code_available: boolean };
}

export function homeAction(stage: HomeStage, detail: HomeActionDetail | null): HomeAction {
  if (stage === 'none') return 'pass';
  // without C-12's read (still loading, or it failed) the circle opens C-12, which reads it again
  if (!detail) return 'open';
  const stop = homeStop(stage);
  if (stop === 0) return detail.request.can_request ? 'hold' : 'open';
  if (stop === 1) return detail.request.requested_at ? 'elapsed' : 'open';
  return detail.handover.code_available ? 'code' : 'open';
}

/** The circle's colour family (the mockup of option A): blue at rest and parked, navy while it comes, green when ready. */
export type HomeTone = 'blue' | 'navy' | 'green';

export function homeTone(stage: HomeStage): HomeTone {
  const stop = homeStop(stage);
  return stop === 2 ? 'green' : stop === 1 ? 'navy' : 'blue';
}

/** «481 927»: the six digits of the handover code in two groups of three (the mockup of option A); else as it is. */
export function codeGroups(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
