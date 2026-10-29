import type { Venue, VenueEvent } from '@/api/types';
import { Select } from '@/components';
import { eventStatus } from '@/i18n/ar';
import { staff } from '@/i18n/ar.staff';
import { ALL_OPEN } from './selection';

/**
 * The venue and event selectors of the supervisor TopBar (02 §1.3): venues of the scope only (owner/admin: all),
 * events `open` and `closing`, plus «كل الحفلات المفتوحة».
 */
export function VenueEventPicker({
  venues,
  events,
  venueId,
  eventId,
  onVenue,
  onEvent,
  allowAll = true,
  idPrefix = 'ops',
}: {
  venues: readonly Venue[];
  events: readonly VenueEvent[];
  venueId: string | null;
  eventId: string | null;
  onVenue: (id: string) => void;
  onEvent: (id: string) => void;
  allowAll?: boolean;
  idPrefix?: string;
}) {
  const eventOptions: Array<readonly [string, string]> = events.map((e) => [
    e.id,
    e.status === 'open' ? e.name_ar : `${e.name_ar} · ${eventStatus[e.status]}`,
  ]);
  if (allowAll && events.length > 1) eventOptions.unshift([ALL_OPEN, staff.allOpenEvents]);
  return (
    <div className="st-pickers">
      <Select
        id={`${idPrefix}-venue`}
        label={staff.venue}
        value={venueId ?? ''}
        options={venues.map((v) => [v.id, v.name_ar] as const)}
        onChange={(e) => onVenue(e.target.value)}
        disabled={venues.length < 2}
      />
      {events.length ? (
        <Select
          id={`${idPrefix}-event`}
          label={staff.event}
          value={eventId ?? ''}
          options={eventOptions}
          onChange={(e) => onEvent(e.target.value)}
          disabled={eventOptions.length < 2}
        />
      ) : null}
    </div>
  );
}
