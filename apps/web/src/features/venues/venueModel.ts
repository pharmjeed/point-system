import type { EventStatus, PaymentMethod, Shift, VenueEvent } from '@/api/types';
import { s08 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDate, formatHalalas, formatTime } from '@/lib/format';

/** S-08 event groups «اليوم · القادمة · المغلقة» (02 S-08), by the Riyadh calendar date and status. */
export type EventGroup = 'today' | 'upcoming' | 'closed';

const FINISHED: EventStatus[] = ['closed', 'canceled'];

export function eventGroup(event: Pick<VenueEvent, 'status' | 'event_date'>, today: string): EventGroup {
  if (FINISHED.includes(event.status)) return 'closed';
  return event.event_date > today ? 'upcoming' : 'today';
}

/** Events of one group, soonest first (closed: latest first). */
export function eventsIn(events: VenueEvent[], group: EventGroup, today: string): VenueEvent[] {
  const list = events.filter((e) => eventGroup(e, today) === group);
  const key = (e: VenueEvent) => `${e.event_date}|${e.starts_at ?? ''}`;
  return list.sort((a, b) =>
    group === 'closed' ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b)),
  );
}

export const openEventCount = (events: VenueEvent[]) => events.filter((e) => e.status === 'open').length;

/** The shift shown on a venue card: the open one, else the next scheduled one. */
export function currentShift(shifts: Shift[]): Shift | null {
  return (
    shifts.find((s) => s.status === 'open') ??
    shifts
      .filter((s) => s.status === 'scheduled')
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ??
    null
  );
}

/** «مشمول» or «20.00 ر.س لكل مركبة». */
export function pricingText(event: Pick<VenueEvent, 'pricing_mode' | 'fee_halalas'>): string {
  return event.pricing_mode === 'per_vehicle'
    ? fmt(s08.perVehiclePrice, { amount: formatHalalas(event.fee_halalas) })
    : s08.included;
}

/** «29/10/2026 · 7:00 م – 11:30 م» */
export function whenText(event: Pick<VenueEvent, 'event_date' | 'starts_at' | 'ends_at'>): string {
  const date = formatDate(`${event.event_date}T12:00:00Z`);
  const times = [event.starts_at, event.ends_at].filter((t): t is string => !!t).map((t) => formatTime(t));
  return times.length ? `${date} · ${times.join(' – ')}` : date;
}

export function shiftWhenText(shift: Pick<Shift, 'starts_at' | 'ends_at'>): string {
  const start = `${formatDate(shift.starts_at)} · ${formatTime(shift.starts_at)}`;
  return shift.ends_at ? `${start} – ${formatTime(shift.ends_at)}` : start;
}

export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'pos'];
