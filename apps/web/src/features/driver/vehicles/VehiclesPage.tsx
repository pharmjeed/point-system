import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Car, SearchX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { displayMessage, isApiError } from '@/api/errors';
import { listVehicles } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { TicketSummary } from '@/api/types';
import { paths } from '@/app/paths';
import {
  Banner,
  EmptyState,
  FilterChips,
  ListItem,
  PlateBadge,
  SearchField,
  Skeleton,
  StatusChip,
  TicketNumber,
} from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { useServerNow } from '@/hooks/useNow';
import { buttons, d12 } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatClock } from '@/lib/format';
import { useCommandGate } from '@/realtime/hooks';
import { plateValue, vehicleSummary } from '../fieldModel';
import { FILTER_STATUSES, nextFilter, searchDigits, VEHICLE_FILTERS, type VehicleFilter } from './model';
import { CarGlyph } from '@/components/CarGlyph';

/** 02 D-12: the search runs 300 ms after the last keystroke. */
const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;
/** A PAGINATION_CURSOR_INVALID this soon after the last reload waits for the tap (no request loop). */
const CURSOR_RESET_GUARD_MS = 10_000;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * D-12 — المركبات (PNT-069): the open tickets of the driver's venue with the minimal fields only (`GET
 * /v1/tickets`, newest first, cursor pages of 50 loaded as the list scrolls), searched by plate digits or the
 * ticket number and filtered by the 02 chips. `ticket.updated` patches the rows in place (realtime, newer
 * versions only) and every resync reloads them. Offline, the last results stay on screen dimmed under D-15 أ.
 */
export function VehiclesPage() {
  const qc = useQueryClient();
  const gate = useCommandGate();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<VehicleFilter>('all');
  const typed = useDebounced(text.trim(), DEBOUNCE_MS);
  const q = searchDigits(typed);
  // letters only: nothing can match (07: q is digits), no request
  const impossible = typed.length > 0 && q.length === 0;
  const statuses = FILTER_STATUSES[filter];
  const statusList = statuses.join(',');
  const list = useInfiniteQuery({
    queryKey: queryKeys.vehicleSearch(q, statusList),
    queryFn: ({ pageParam, signal }) =>
      listVehicles({ q, status: statuses, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: !impossible,
  });
  const items = impossible ? [] : (list.data?.pages.flatMap((p) => p.items) ?? []);
  const filtered = typed.length > 0 || filter !== 'all';

  // infinite list: the next page loads when the end of the list comes into view — not again after it failed
  // (the inline «إعادة المحاولة» asks for it), so a lasting error never loops
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = list;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  // 02 §1.9 PAGINATION_CURSOR_INVALID «إعادة تحميل القائمة من البداية» — by itself once; refused again right after
  // (a lasting refusal), the inline «إعادة المحاولة» reloads it, so a list end in view never loops
  const lastReset = useRef(0);
  const [resetHeld, setResetHeld] = useState(false);
  const resetList = useCallback(() => {
    lastReset.current = Date.now();
    setResetHeld(false);
    void qc.resetQueries({ queryKey: queryKeys.vehicleSearch(q, statusList), exact: true });
  }, [qc, q, statusList]);
  const cursorInvalid = isFetchNextPageError && isApiError(list.error, 'PAGINATION_CURSOR_INVALID');
  useEffect(() => {
    if (!cursorInvalid) return;
    if (Date.now() - lastReset.current < CURSOR_RESET_GUARD_MS) setResetHeld(true);
    else resetList();
  }, [cursorInvalid, resetList]);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="page-title">
      <h1 className="pt-page-title" id="page-title">
        {d12.title}
      </h1>
      <SearchField
        id="vehicle-search"
        value={text}
        onChange={setText}
        placeholder={d12.search}
        label={d12.search}
        inputMode="numeric"
        loading={list.isFetching && !list.isFetchingNextPage && !!list.data}
      />
      <FilterChips
        options={VEHICLE_FILTERS.map((f) => ({ value: f, label: d12.filters[f] }))}
        value={[filter]}
        onChange={(next) => setFilter(nextFilter(filter, next))}
      />
      {list.isPending && !impossible ? (
        <div className="flex flex-col gap-3">
          <Skeleton />
          <Skeleton />
        </div>
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState icon={SearchX} title={d12.emptySearch} />
        ) : (
          <EmptyState icon={Car} title={d12.emptyAll} />
        )
      ) : (
        <div className="pt-live" data-stale={gate.unconfirmed || gate.stale}>
          <div className="pt-live__cards">
            <ul className="pt-list" aria-label={d12.title} aria-busy={list.isFetching}>
              {items.map((t) => (
                <li key={t.id}>
                  <VehicleRow ticket={t} />
                </li>
              ))}
            </ul>
            {list.isFetchingNextPage ? <Skeleton variant="line" /> : null}
            {isFetchNextPageError && (!cursorInvalid || resetHeld) ? (
              <Banner
                kind="error"
                rounded
                message={displayMessage(list.error)}
                actionLabel={buttons.retry}
                onAction={cursorInvalid ? resetList : () => void fetchNextPage()}
              />
            ) : null}
            <div ref={sentinel} aria-hidden="true" />
          </div>
        </div>
      )}
    </section>
  );
}

/** «#125 │ 1234 ب ح د │ كامري · أبيض │ «مطلوبة» · منذ 1:40» (02 D-12). */
function VehicleRow({ ticket }: { ticket: TicketSummary }) {
  const plate = plateValue(ticket.plate);
  const vehicle = vehicleSummary(ticket.vehicle);
  return (
    <ListItem
      to={`${paths.driverVehicles}/${ticket.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <TicketNumber n={ticket.display_number} />
          <CarGlyph {...ticket.vehicle} width={44} />
          {plate ? (
            <PlateBadge {...plate} />
          ) : (
            <bdi dir="ltr" className="font-mono">
              {ticket.plate.display}
            </bdi>
          )}
        </span>
      }
      meta={vehicle || undefined}
      trailing={
        <span className="flex flex-col items-end gap-1">
          <StatusChip status={ticket.status} size="sm" />
          {ticket.requested_at ? <WaitingSince since={ticket.requested_at} /> : null}
        </span>
      }
    />
  );
}

function WaitingSince({ since }: { since: string }) {
  const now = useServerNow(1000);
  return (
    <span className="text-sm text-text-muted">
      {fmt(d12.since, { time: formatClock((now - Date.parse(since)) / 1000) })}
    </span>
  );
}
