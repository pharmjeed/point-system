import { useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import { listEvents, listShifts, listVenues } from '@/api/setup';
import type { Venue } from '@/api/types';
import { can } from '@/app/permissions';
import { Button, EmptyState, ListItem } from '@/components';
import { QueryView } from '@/features/common/QueryView';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { nav, s08, shiftStatus } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { currentShift, openEventCount } from './venueModel';
import { VenueFormSheet } from './VenueFormSheet';

/**
 * S-08 — venues of the caller's scope as cards: name, code, open events, shift status (02 S-08).
 * «موقع جديد» for `venue.manage` only.
 */
export function VenuesPage() {
  const me = useStaffMe();
  const venues = useQuery({ queryKey: queryKeys.venues, queryFn: ({ signal }) => listVenues(signal) });
  const [creating, setCreating] = useState(false);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="page-title">
      <div className="pt-pagehead">
        <h1 className="pt-page-title" id="page-title">
          {nav.venues}
        </h1>
        {can(me, 'venue.manage') ? (
          <Button compact variant="secondary" iconStart={Plus} onClick={() => setCreating(true)}>
            {s08.newVenue}
          </Button>
        ) : null}
      </div>
      <QueryView query={venues}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={Building2} title={s08.emptyVenues} />
          ) : (
            <ul className="pt-list" aria-label={nav.venues}>
              {list.map((venue) => (
                <li key={venue.id}>
                  <VenueRow venue={venue} />
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <VenueFormSheet open={creating} onOpenChange={setCreating} />
    </section>
  );
}

function VenueRow({ venue }: { venue: Venue }) {
  const events = useQuery({
    queryKey: queryKeys.events(venue.id),
    queryFn: ({ signal }) => listEvents(venue.id, signal),
  });
  const shifts = useQuery({
    queryKey: queryKeys.shifts(venue.id),
    queryFn: ({ signal }) => listShifts(venue.id, signal),
  });
  const shift = shifts.data ? currentShift(shifts.data) : null;
  return (
    <ListItem
      icon={Building2}
      to={`/venues/${venue.id}`}
      title={venue.name_ar}
      meta={
        <span className="flex flex-wrap items-center gap-x-2">
          <bdi dir="ltr" className="pt-num">
            {venue.code}
          </bdi>
          {events.data ? <span>{fmt(s08.openEvents, { n: openEventCount(events.data) })}</span> : null}
          {shifts.data ? (
            <span>{fmt(s08.shiftLine, { status: shift ? shiftStatus[shift.status] : s08.noShift })}</span>
          ) : null}
        </span>
      }
    />
  );
}
