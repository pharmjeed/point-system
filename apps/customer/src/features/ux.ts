/**
 * The presentation logic of the V2-UX redesign (DEC-570 … DEC-579), pure and unit tested: the stage tracker and the
 * hero of C-12, the elapsed time shown while the customer waits, the plate split into its two halves (`PlateBadge`
 * of 03 §3.7), and the renewal line of a subscription card on C-06. Every value comes from the server's reads; this
 * only decides how it is drawn.
 */
import type {
  CustomerHomeSubscription,
  CustomerLocationPlan,
  CustomerVisitDetail,
  CustomerVisitStep,
} from '@point/shared/customer';
import { fmt, isolate, type Dictionary } from '../i18n';
import { formatDate, formatTime } from '../i18n/format';
import { yearlySavingPct } from './subscriptions';

/** The six stages of the C-12 tracker (01 R3: received → parked → requested → on the way → ready → delivered). */
export const TRACKER_STAGES = [
  'received',
  'parked',
  'requested',
  'on_the_way',
  'ready',
  'delivered',
] as const;
export type TrackerStage = (typeof TRACKER_STAGES)[number];
export type StageState = 'done' | 'current' | 'todo';

/** The timeline steps a stage covers (the request is accepted on its way: «قُبل الطلب» belongs to «إحضار»). */
const STAGE_STEPS: Record<TrackerStage, readonly CustomerVisitStep[]> = {
  received: ['received'],
  parked: ['parked'],
  requested: ['requested'],
  on_the_way: ['accepted', 'on_the_way'],
  ready: ['ready'],
  delivered: ['delivered'],
};

/** The stage in progress for each open ticket status (none when nothing is moving: parked, waiting for a request). */
const CURRENT_STAGE: Partial<Record<CustomerVisitDetail['status'], TrackerStage>> = {
  received: 'parked',
  parking: 'parked',
  reparking: 'parked',
  requested: 'requested',
  assigned: 'on_the_way',
  assigned_waiting: 'on_the_way',
  retrieving: 'on_the_way',
  ready: 'ready',
};

/**
 * Each stage done (its last step has a time and it is not the one in progress), current (the status says it is
 * happening now), or still to come. A delivered visit has every reached stage done; a re-parked car goes back to
 * «صف» with the later stages to come again.
 */
export function trackerStages(
  v: Pick<CustomerVisitDetail, 'status' | 'open' | 'timeline'>,
): { stage: TrackerStage; state: StageState }[] {
  const at = new Map(v.timeline.map((s) => [s.step, s.at] as const));
  const current = v.open ? CURRENT_STAGE[v.status] : undefined;
  const reparked = v.status === 'reparking';
  return TRACKER_STAGES.map((stage) => {
    if (stage === current) return { stage, state: 'current' as const };
    const steps = STAGE_STEPS[stage];
    const reached = steps.some((s) => (at.get(s) ?? null) !== null);
    // after a re-park the retrieval stages start over
    const stale = reparked && TRACKER_STAGES.indexOf(stage) > TRACKER_STAGES.indexOf('parked');
    return { stage, state: reached && !stale ? ('done' as const) : ('todo' as const) };
  });
}

/** How far along the tracker is, 0 … 1 (the filled part of its line). */
export function trackerProgress(stages: readonly { state: StageState }[]): number {
  if (stages.length < 2) return 0;
  let last = 0;
  stages.forEach((s, i) => {
    if (s.state !== 'todo') last = i;
  });
  return last / (stages.length - 1);
}

/** The picture of the C-12 hero: what the car is doing, for its icon and colour. */
export type HeroKind = 'parking' | 'parked' | 'waiting' | 'moving' | 'ready' | 'done' | 'void';

export function heroKind(status: CustomerVisitDetail['status']): HeroKind {
  switch (status) {
    case 'received':
    case 'parking':
    case 'reparking':
      return 'parking';
    case 'parked':
      return 'parked';
    case 'requested':
      return 'waiting';
    case 'assigned':
    case 'assigned_waiting':
    case 'retrieving':
      return 'moving';
    case 'ready':
      return 'ready';
    case 'delivered':
      return 'done';
    default:
      return 'void';
  }
}

/** `m:ss` under an hour, `h:mm` after (Western digits, monospace on screen). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export interface ElapsedView {
  label: string;
  value: string;
  /** ticks every second (the request is moving); otherwise a fixed time of day */
  live: boolean;
}

/**
 * The time line under the C-12 hero: since the request while the car is being brought (the only wait the customer
 * feels; no ETA is promised — the server gives none), the time the car reached the gate when ready, the intake time
 * while it stays parked. Nothing for a closed visit.
 */
export function elapsedView(
  v: Pick<CustomerVisitDetail, 'status' | 'open' | 'timeline' | 'request' | 'received_at'>,
  dict: Dictionary,
  nowMs: number,
): ElapsedView | null {
  if (!v.open) return null;
  const moving = ['requested', 'assigned', 'assigned_waiting', 'retrieving'].includes(v.status);
  if (moving && v.request.requested_at) {
    const since = nowMs - Date.parse(v.request.requested_at);
    return { label: dict.visit.since.requested, value: formatElapsed(since), live: true };
  }
  if (v.status === 'ready') {
    const ready = v.timeline.find((s) => s.step === 'ready')?.at;
    return ready ? { label: dict.visit.since.ready, value: formatTime(ready), live: false } : null;
  }
  return { label: dict.visit.since.received, value: formatTime(v.received_at), live: false };
}

/**
 * A Saudi plate as «1234 ا ب ح» (`saudiPlateDisplay`) in its two halves for `PlateBadge` (03 §3.7); any other text
 * (a foreign plate typed by the staff) stays whole.
 */
export function plateParts(display: string): { digits: string; letters: string } | null {
  const m = /^\s*([0-9]{1,4})\s+(.+?)\s*$/.exec(display);
  if (!m || /[0-9]/.test(m[2] as string)) return null;
  return { digits: m[1] as string, letters: m[2] as string };
}

/** The one line of a subscription card on C-06: the renewal or end date, else the status. */
export function homeSubscriptionLine(s: CustomerHomeSubscription, dict: Dictionary): string {
  const day = (iso: string) => isolate(formatDate(iso));
  if (s.status === 'active' && s.current_period_end)
    return fmt(s.cancel_at_period_end ? dict.subscriptions.endsOn : dict.subscriptions.renewsOn, {
      date: day(s.current_period_end),
    });
  return dict.subscriptionStatus[s.status];
}

/** «صباح الخير» before noon, «مساء الخير» after (Riyadh time, UTC+3 with no daylight saving: DEC-481). */
export function dayPart(nowMs: number): 'morning' | 'evening' {
  const hour = new Date(nowMs + 3 * 3600_000).getUTCHours();
  return hour >= 4 && hour < 12 ? 'morning' : 'evening';
}

/** The best yearly saving of a location's plans (C-08's yearly price tile), whole percent, or null. */
export function bestYearlySaving(
  plans: readonly Pick<CustomerLocationPlan, 'monthly_price_halalas' | 'yearly_price_halalas'>[],
): number | null {
  const all = plans.map(yearlySavingPct).filter((p): p is number => p !== null);
  return all.length ? Math.max(...all) : null;
}
