import { useQuery } from '@tanstack/react-query';
import { HandCoins, KeyRound, Layers, ScanSearch, SquareParking, Timer, type LucideIcon } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { queryKeys } from '@/api/queryClient';
import { getVenue, listKeyBoards, listPools, listSpots, listZones } from '@/api/setup';
import type { Venue } from '@/api/types';
import { paths } from '@/app/paths';
import { can } from '@/app/permissions';
import { Header, ListItem } from '@/components';
import { QueryView } from '@/features/common/QueryView';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { s08, s09 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { KeysSection, ParkingSection } from './setup/LayoutSections';
import { PoolsSection } from './setup/PoolsSection';
import { SettingsSection } from './setup/SettingsSection';

type Section = keyof typeof s09.sections;
const SECTIONS: Array<[Section, LucideIcon]> = [
  ['parking', SquareParking],
  ['keys', KeyRound],
  ['pools', Layers],
  ['timers', Timer],
  ['handover', HandCoins],
  ['inspection', ScanSearch],
];
const isSection = (v: string | null): v is Section => !!v && SECTIONS.some(([s]) => s === v);

/**
 * S-09 — venue setup (`/venues/:venueId/setup`). The six tabs of 02 S-09 are a section list
 * (`?section=…`; the design system has no tab component — docs/progress/notes/pnt-023.md). Everything is
 * readable with `venue.read` / `venue.layout_read`; create, disable and save need `venue.manage`
 * (supervisors view only, 02 §2.2).
 */
export function VenueSetupPage() {
  const { venueId = '' } = useParams();
  const navigate = useNavigate();
  const venue = useQuery({
    queryKey: queryKeys.venue(venueId),
    queryFn: ({ signal }) => getVenue(venueId, signal),
  });
  return (
    <section className="flex flex-col gap-3" aria-label={s08.setup}>
      <QueryView query={venue} backTo={paths.venues}>
        {(v) => <SetupBody venue={v} onBack={() => navigate(`/venues/${v.id}`)} />}
      </QueryView>
    </section>
  );
}

function SetupBody({ venue, onBack }: { venue: Venue; onBack: () => void }) {
  const me = useStaffMe();
  const [params, setParams] = useSearchParams();
  const section = params.get('section');
  const manage = can(me, 'venue.manage');
  if (isSection(section)) {
    return (
      <>
        <Header title={s09.sections[section]} onBack={() => setParams({}, { replace: false })} />
        <p className="pt-record__meta">
          {s08.setup} · {venue.name_ar}
        </p>
        {section === 'parking' ? <ParkingSection venueId={venue.id} manage={manage} /> : null}
        {section === 'keys' ? <KeysSection venueId={venue.id} manage={manage} /> : null}
        {section === 'pools' ? <PoolsSection venueId={venue.id} manage={manage} /> : null}
        {section === 'timers' || section === 'handover' || section === 'inspection' ? (
          <SettingsSection venueId={venue.id} group={section} manage={manage} />
        ) : null}
      </>
    );
  }
  return (
    <>
      <Header title={s08.setup} onBack={onBack} />
      <p className="pt-record__meta">{venue.name_ar}</p>
      <SectionIndex venueId={venue.id} />
    </>
  );
}

function SectionIndex({ venueId }: { venueId: string }) {
  const zones = useQuery({
    queryKey: queryKeys.zones(venueId),
    queryFn: ({ signal }) => listZones(venueId, signal),
  });
  const spots = useQuery({
    queryKey: queryKeys.spots(venueId),
    queryFn: ({ signal }) => listSpots(venueId, signal),
  });
  const boards = useQuery({
    queryKey: queryKeys.keyBoards(venueId),
    queryFn: ({ signal }) => listKeyBoards(venueId, signal),
  });
  const pools = useQuery({
    queryKey: queryKeys.pools(venueId),
    queryFn: ({ signal }) => listPools(venueId, signal),
  });
  const meta: Partial<Record<Section, string>> = {
    parking:
      zones.data && spots.data
        ? `${fmt(s09.zonesCount, { n: zones.data.length })} · ${fmt(s09.spotsCount, { n: spots.data.length })}`
        : undefined,
    keys: boards.data
      ? `${fmt(s09.boardsCount, { n: boards.data.length })} · ${fmt(s09.slotsCount, {
          n: boards.data.reduce((sum, b) => sum + b.slots.length, 0),
        })}`
      : undefined,
    pools: pools.data ? fmt(s09.poolsCount, { n: pools.data.length }) : undefined,
  };
  return (
    <ul className="pt-list" aria-label={s08.setup}>
      {SECTIONS.map(([key, icon]) => (
        <li key={key}>
          <ListItem icon={icon} title={s09.sections[key]} meta={meta[key]} to={`?section=${key}`} />
        </li>
      ))}
    </ul>
  );
}
