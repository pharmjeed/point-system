import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, Info, X } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { DriverLive, Me, OperationsBoard } from '@/api/types';
import { Button, Icon } from '@/components';
import { buttons } from '@/i18n/ar';
import { s07, staff } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { can } from './permissions';
import { LIVE_EVENT_STATUSES } from './selection';
import { fetchBoard, fetchVenueEvents, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { checklistFrom, type ChecklistTicket, type TransferChecklist } from './transferModel';
import './staff.css';

/**
 * The custody snapshot of a driver (DEC-32; 02 S-06, S-07): his live state and the operations boards of his
 * venue's open and closing events (`event.manage` lists them, `alert.read` reads a board). `known` is false while
 * a board is missing (loading, refused or failed): the screen then leaves the judgement to the server.
 */
export function useCustodySnapshot(
  me: Me,
  driverId: string,
  venueId: string | null,
  live: DriverLive | null | undefined,
) {
  const events = useQuery({
    queryKey: staffKeys.venueEvents(venueId ?? '-', LIVE_EVENT_STATUSES),
    queryFn: ({ signal }) => fetchVenueEvents(venueId as string, LIVE_EVENT_STATUSES, signal),
    enabled: !!venueId && can(me, 'event.manage'),
  });
  const boards = useQueries({
    queries: (events.data?.items ?? []).map((e) => ({
      queryKey: staffKeys.board(e.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBoard(e.id, signal),
      enabled: can(me, 'alert.read'),
    })),
  });
  const stamp = boards.map((b) => b.dataUpdatedAt).join('|');
  const snapshot = useMemo(
    () =>
      checklistFrom(
        driverId,
        live,
        boards.filter((b) => b.data).map((b) => b.data as OperationsBoard),
      ),
    [driverId, live, stamp], // boards data changes with dataUpdatedAt
  );
  const known = !venueId || (events.isSuccess && boards.every((b) => b.isSuccess));
  return { snapshot, known };
}

function Mark({ state }: { state: 'ok' | 'bad' | 'info' }) {
  const icon = state === 'ok' ? Check : state === 'bad' ? X : Info;
  return (
    <span className={cx('st-check__mark', `is-${state}`)}>
      <Icon icon={icon} size={20} label={state === 'ok' ? '✓' : state === 'bad' ? '✗' : undefined} />
    </span>
  );
}

/** «#125», or «#125 · حفل آل فلان» when several events are live (numbers are unique per event only). */
const numberOf = (t: ChecklistTicket) =>
  t.event_name ? `${t.display_number} · ${t.event_name}` : String(t.display_number);

const nums = (list: readonly ChecklistTicket[]) =>
  list
    .filter((t) => t.display_number > 0)
    .map((t) => `#${numberOf(t)}`)
    .join('، ');

/** «#131، #140» — the numbers of a checklist row (no number for a park/repark seen from the state only). */
export const ticketNumbers = nums;

const keyOf = (t: ChecklistTicket) => t.ticket_id ?? `#${t.display_number}`;

/**
 * The custody checklist (02 S-07 «التحقق من العهدة»; the same blocking rows in the S-06 confirmations of
 * «تعطيل الحساب» and «إنهاء المناوبة قسرًا»): ✗ for a vehicle or a key held, a movement in progress or an active
 * park/repark, each with «فتح» to transfer it officially first (no override); `scope = 'transfer'` adds what goes
 * back to the old venue's queue and the live single offers that are withdrawn.
 */
export function CustodyChecklist({
  checklist,
  fromName = '',
  scope = 'transfer',
  testId = 'transfer-checklist',
}: {
  checklist: TransferChecklist;
  fromName?: string;
  scope?: 'transfer' | 'blocking';
  testId?: string;
}) {
  const navigate = useNavigate();
  const link = (t: ChecklistTicket) => {
    const ticketId = t.display_number > 0 ? t.ticket_id : null;
    return ticketId ? (
      <Button variant="ghost" compact onClick={() => navigate(staffPaths.ticket(ticketId))}>
        {buttons.open}
      </Button>
    ) : null;
  };
  const yesNo = (list: readonly ChecklistTicket[]) =>
    list.length ? `${staff.yes} ${nums(list)}`.trim() : staff.no;
  const held = new Set([...checklist.vehicles, ...checklist.keys].map(keyOf));
  return (
    <ul className="st-checklist" data-testid={testId}>
      <li className="st-check">
        <Mark state={checklist.vehicles.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.vehicles, { n: checklist.vehicles.length })}</span>
        {checklist.vehicles.map((t) => (
          <span key={`v${keyOf(t)}`} className="st-inline-list">
            {t.display_number > 0 ? fmt(s07.mustRelease, { n: numberOf(t) }) : null}
            {link(t)}
          </span>
        ))}
      </li>
      <li className="st-check">
        <Mark state={checklist.keys.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.keys, { n: checklist.keys.length })}</span>
        {checklist.keys.map((t) => (
          <span key={`k${keyOf(t)}`} className="st-inline-list">
            {t.display_number > 0 ? fmt(s07.mustRelease, { n: numberOf(t) }) : null}
            {link(t)}
          </span>
        ))}
      </li>
      <li className="st-check">
        <Mark state={checklist.movement.length ? 'bad' : 'ok'} />
        <span>{fmt(s07.movement, { v: yesNo(checklist.movement) })}</span>
        {/* an accepted park/repark holds nothing yet: its «فتح» is here (a movement's ticket is linked above) */}
        {checklist.movement
          .filter((t) => !held.has(keyOf(t)))
          .map((t) => (
            <span key={`m${keyOf(t)}`} className="st-inline-list">
              {link(t)}
            </span>
          ))}
      </li>
      {scope === 'transfer' ? (
        <>
          <li className="st-check">
            <Mark state="info" />
            <span>{fmt(s07.acceptedBeforeKey, { v: yesNo(checklist.acceptedBeforeKey) })}</span>
            <span className="st-muted">{s07.acceptedNote}</span>
          </li>
          <li className="st-check">
            <Mark state="info" />
            <span>
              {fmt(s07.nextTask, { v: checklist.nextTask.length ? nums(checklist.nextTask) : staff.no })}
            </span>
            {checklist.nextTask.length ? (
              <span className="st-muted">{fmt(s07.nextNote, { venue: fromName })}</span>
            ) : null}
          </li>
          <li className="st-check">
            <Mark state="info" />
            <span>{fmt(s07.offers, { n: checklist.singleOffers })}</span>
            {checklist.singleOffers ? <span className="st-muted">{s07.offersNote}</span> : null}
          </li>
        </>
      ) : null}
    </ul>
  );
}
