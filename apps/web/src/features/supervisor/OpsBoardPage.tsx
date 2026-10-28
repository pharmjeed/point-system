import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Activity,
  BellRing,
  CalendarDays,
  Clock,
  FileExclamationPoint,
  KeyRound,
  MessageCircleWarning,
  Timer,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Me, OperationsBoard, QueueItem as QueueEntry, TaskCard } from '@/api/types';
import { canAdmin, paths } from '@/app/paths';
import {
  Banner,
  Button,
  DriverRow,
  EmptyState,
  KpiStrip,
  ListItem,
  QueueItem,
  SearchField,
  StatusChip,
  TaskRow,
} from '@/components';
import type { KpiTileProps } from '@/components/Kpi';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { useOnline } from '@/hooks/useOnline';
import { useServerNow } from '@/hooks/useNow';
import {
  alertType,
  buttons,
  custodyHolder,
  custodySubject,
  s02,
  s12,
  staff,
  taskStatus,
  taskType,
  waMessageStatus,
} from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { formatClock, formatSinceMinutes, formatTime } from '@/lib/format';
import { useUiStore } from '@/stores/ui';
import { AlertList } from './AlertList';
import { useLiveAlerts } from './OpsArea';
import {
  driverTaskInfo,
  liveAlerts,
  mergeBoards,
  notCollected,
  plateText,
  plateValue,
  queueBadges,
  queueStateText,
  secondsSince,
  sortQueue,
  stageSince,
  thresholdsFrom,
  vehicleSummary,
  type Thresholds,
} from './opsModel';
import { can } from './permissions';
import { useOpsSelection } from './selection';
import { fetchBoard, fetchVenueSettings, LIVE_REFETCH_MS, searchTickets, staffKeys } from './staffApi';
import { staffPaths } from './staffPaths';
import { ForbiddenPage, PageSkeleton, QueryError, Tabs } from './ui';
import { VenueEventPicker } from './VenueEventPicker';
import './staff.css';

type BoardTab = 'queue' | 'active' | 'next' | 'drivers' | 'alerts' | 'failed' | 'custody';

/**
 * S-02 — لوحة التشغيل (02 §4 S-02, PNT-074): the live control centre of the venue/event. Indicators, the queue
 * oldest first with its waiting counter and escalation badges, active and next tasks, drivers by `driver_state`,
 * alerts, failed messages and custody issues. `GET /v1/events/{eventId}/operations` (or every open event for
 * «كل الحفلات المفتوحة»), refreshed every 15 s (15 §11.1) until the realtime client invalidates
 * `staffKeys.board(eventId)`. Counters tick locally from server time (02 §1.7). Cards below 1024px with tabs,
 * three columns from 1024px.
 */
export function OpsBoardPage() {
  const me = useStaffMe();
  if (!can(me, 'alert.read'))
    return <ForbiddenPage title={s02.title} backTo={canAdmin(me) ? paths.admin : paths.reports} />;
  return <Board me={me} />;
}

function Board({ me }: { me: Me }) {
  const navigate = useNavigate();
  const online = useOnline();
  const lastSyncAt = useUiStore((s) => s.lastSyncAt);
  const sel = useOpsSelection(can(me, 'venue.read'));
  const [tab, setTab] = useState<BoardTab>('queue');
  const now = useServerNow(1000);
  const liveAlertsQuery = useLiveAlerts(me);

  const boards = useQueries({
    queries: sel.eventIds.map((id) => ({
      queryKey: staffKeys.board(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBoard(id, signal),
      refetchInterval: LIVE_REFETCH_MS,
    })),
  });
  const settings = useQuery({
    queryKey: staffKeys.venueSettings(sel.venueId ?? '-'),
    queryFn: ({ signal }) => fetchVenueSettings(sel.venueId as string, signal),
    enabled: !!sel.venueId,
    staleTime: 5 * 60_000,
  });
  const thresholds = thresholdsFrom(settings.data?.settings);

  const stamp = boards.map((b) => b.dataUpdatedAt).join('|');
  const board = useMemo(
    () => mergeBoards(boards.filter((b) => b.data).map((b) => b.data as OperationsBoard)),
    // the boards array is new on every render; its data changes only with dataUpdatedAt
    [stamp, sel.eventIds.join('|')],
  );
  const boardError = boards.find((b) => b.error)?.error;
  const pending =
    sel.venues.isPending || sel.events.isPending || (sel.eventIds.length > 0 && !board && !boardError);

  const openAlertsCount = (liveAlertsQuery.data?.items ?? []).filter((a) => a.status === 'open').length;

  const header = (
    <div className="st-head">
      <h1 className="pt-page-title">{s02.title}</h1>
      <div className="st-head__actions">
        <Button variant="secondary" compact iconStart={BellRing} onClick={() => navigate(paths.opsAlerts)}>
          {fmt(staff.alertsCount, { n: openAlertsCount })}
        </Button>
        {can(me, 'incident.read') ? (
          <Button
            variant="ghost"
            compact
            iconStart={FileExclamationPoint}
            onClick={() => navigate(paths.incidents)}
          >
            {s12.title}
          </Button>
        ) : null}
      </div>
    </div>
  );

  const picker = (
    <VenueEventPicker
      venues={sel.venueList}
      events={sel.eventList}
      venueId={sel.venueId}
      eventId={sel.eventId}
      onVenue={sel.setVenue}
      onEvent={sel.setEvent}
    />
  );

  if (sel.venues.isError && !sel.venues.data)
    return (
      <div className="st-page">
        {header}
        <QueryError error={sel.venues.error} onRetry={() => void sel.venues.refetch()} />
      </div>
    );

  if (!pending && sel.events.data && sel.eventList.length === 0)
    return (
      <div className="st-page">
        {header}
        {picker}
        <EmptyState
          icon={CalendarDays}
          title={s02.noEvent}
          actionLabel={can(me, 'event.manage') ? s02.openEvent : undefined}
          onAction={() => navigate(paths.venues)}
        />
      </div>
    );

  return (
    <div className="st-page" aria-busy={pending || undefined}>
      {header}
      {picker}
      {board ? <BoardBanners board={board} /> : null}
      {boardError && board ? (
        <Banner
          kind="stale"
          rounded
          message={fmt(s02.staleBanner, { time: lastSyncAt ? formatTime(lastSyncAt) : staff.none })}
          actionLabel={buttons.retry}
          onAction={() => boards.forEach((b) => void b.refetch())}
        />
      ) : null}
      {boardError && !board ? (
        <QueryError error={boardError} onRetry={() => boards.forEach((b) => void b.refetch())} />
      ) : null}
      {pending ? <PageSkeleton rows={3} /> : null}
      {board ? (
        <>
          <Kpis board={board} now={now} thresholds={thresholds} />
          <TicketSearch
            venueId={sel.venueId}
            eventId={sel.eventIds.length === 1 ? sel.eventIds[0] : undefined}
          />
          <Tabs
            className="st-board-tabs"
            idPrefix="ops"
            label={s02.tabsLabel}
            value={tab}
            onChange={setTab}
            items={[
              { id: 'queue', label: s02.tabs.queue, count: board.queue.length },
              { id: 'active', label: s02.tabs.active, count: board.active_tasks.length },
              { id: 'next', label: s02.tabs.next, count: board.next_tasks.length },
              { id: 'drivers', label: s02.tabs.drivers, count: board.drivers.length },
              { id: 'alerts', label: s02.tabs.alerts, count: liveAlerts(board.alerts).length },
              { id: 'failed', label: s02.tabs.failed, count: board.failed_messages.length },
              { id: 'custody', label: s02.tabs.custody, count: board.custody_issues.length },
            ]}
          />
          <div className="st-board">
            <div className="st-col">
              <Panel id="queue" tab={tab} title={s02.queueHeading}>
                <QueuePanel me={me} board={board} now={now} thresholds={thresholds} online={online} />
              </Panel>
            </div>
            <div className="st-col">
              <Panel id="active" tab={tab} title={s02.tabs.active}>
                <TaskRows
                  cards={board.active_tasks}
                  board={board}
                  now={now}
                  thresholds={thresholds}
                  empty={s02.emptyActive}
                />
              </Panel>
              <Panel id="next" tab={tab} title={s02.tabs.next}>
                <TaskRows
                  cards={board.next_tasks}
                  board={board}
                  now={now}
                  thresholds={thresholds}
                  empty={s02.emptyNext}
                />
              </Panel>
              <Panel id="drivers" tab={tab} title={s02.tabs.drivers}>
                <Drivers board={board} />
              </Panel>
            </div>
            <div className="st-col">
              <Panel id="alerts" tab={tab} title={s02.tabs.alerts}>
                <AlertList
                  me={me}
                  alerts={liveAlerts(board.alerts)}
                  emptyTitle={s02.emptyAlerts}
                  renderExtra={(alert) =>
                    alert.type === 'idle_driver_while_next_waiting' &&
                    alert.ticket_id &&
                    can(me, 'task.reassign') ? (
                      <div className="st-row-actions">
                        <Button
                          variant="secondary"
                          compact
                          disabled={!online}
                          onClick={() => navigate(staffPaths.ticket(alert.ticket_id as string, 'reassign'))}
                        >
                          {s02.reassign}
                        </Button>
                      </div>
                    ) : null
                  }
                />
              </Panel>
              <Panel id="failed" tab={tab} title={s02.tabs.failed}>
                <FailedMessages board={board} />
              </Panel>
              <Panel id="custody" tab={tab} title={s02.tabs.custody}>
                <CustodyIssues board={board} now={now} />
              </Panel>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Panel({
  id,
  tab,
  title,
  children,
}: {
  id: BoardTab;
  tab: BoardTab;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx('st-section st-panel', tab !== id && 'is-inactive')}
      role="tabpanel"
      id={`ops-panel-${id}`}
      aria-labelledby={`ops-tab-${id}`}
    >
      <h2 className="pt-section-title st-panel__title">{title}</h2>
      {children}
    </section>
  );
}

function BoardBanners({ board }: { board: OperationsBoard }) {
  const noDrivers = board.alerts.some((a) => a.type === 'no_drivers_on_duty' && a.status !== 'resolved');
  return (
    <>
      {noDrivers ? <Banner kind="error" rounded message={s02.noDriversBanner} /> : null}
      {board.channel_health === 'down' ? <Banner kind="whatsapp" rounded /> : null}
    </>
  );
}

function Kpis({ board, now, thresholds }: { board: OperationsBoard; now: number; thresholds: Thresholds }) {
  const k = board.kpis;
  // the oldest unaccepted request ticks locally from its requested_at (server time)
  const oldestUnaccepted = sortQueue(board.queue).find((q) =>
    ['queued', 'offered', 'broadcast'].includes(q.status),
  );
  const oldest = oldestUnaccepted ? secondsSince(oldestUnaccepted.requested_at, now) : k.oldest_wait_seconds;
  const critical = board.alerts.filter((a) => a.severity === 'critical' && a.status !== 'resolved').length;
  const items: KpiTileProps[] = [
    { label: s02.kpi.openRequests, value: k.open_requests, icon: BellRing },
    {
      label: s02.kpi.oldestWait,
      value: oldest != null ? formatClock(oldest) : staff.none,
      icon: Clock,
      tone: oldest != null && oldest >= thresholds.unacceptedEscalationS ? 'danger' : undefined,
    },
    {
      label: s02.kpi.avgAccept,
      value: k.avg_accept_seconds_30m != null ? formatClock(k.avg_accept_seconds_30m) : staff.none,
      icon: Timer,
    },
    {
      label: s02.kpi.available,
      value: k.drivers_available,
      icon: Users,
      tone: k.drivers_available > 0 ? 'success' : 'warning',
      meta: fmt(s02.kpi.busyBreak, { busy: k.drivers_busy, onBreak: k.drivers_on_break }),
    },
    {
      label: s02.kpi.failedMessages,
      value: board.failed_messages.length,
      icon: MessageCircleWarning,
      tone: board.failed_messages.length ? 'danger' : undefined,
    },
    {
      label: s02.kpi.criticalAlerts,
      value: critical,
      icon: TriangleAlert,
      tone: critical ? 'danger' : undefined,
    },
  ];
  return <KpiStrip items={items} />;
}

function QueuePanel({
  me,
  board,
  now,
  thresholds,
  online,
}: {
  me: Me;
  board: OperationsBoard;
  now: number;
  thresholds: Thresholds;
  online: boolean;
}) {
  const navigate = useNavigate();
  const queue = sortQueue(board.queue);
  if (!queue.length) return <EmptyState icon={Activity} title={s02.emptyQueue} />;
  return (
    <ol className="st-stack" aria-label={s02.queueHeading}>
      {queue.map((item) => (
        <li key={item.task_id} data-ticket={item.ticket.display_number}>
          <QueueEntryRow item={item} board={board} now={now} thresholds={thresholds} />
          <div className="st-row-actions">
            <Button variant="secondary" compact onClick={() => navigate(staffPaths.ticket(item.ticket.id))}>
              {buttons.open}
            </Button>
            {can(me, 'task.reassign') &&
            ['offered', 'broadcast', 'assigned_waiting', 'accepted'].includes(item.status) ? (
              <Button
                variant="ghost"
                compact
                disabled={!online}
                onClick={() => navigate(staffPaths.ticket(item.ticket.id, 'reassign'))}
              >
                {s02.reassign}
              </Button>
            ) : null}
            {can(me, 'retrieval.cancel') ? (
              <Button
                variant="ghost"
                compact
                disabled={!online}
                onClick={() => navigate(staffPaths.ticket(item.ticket.id, 'cancelRetrieval'))}
              >
                {buttons.cancel}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function QueueEntryRow({
  item,
  board,
  now,
  thresholds,
}: {
  item: QueueEntry;
  board: OperationsBoard;
  now: number;
  thresholds: Thresholds;
}) {
  const next = board.next_tasks.find((c) => c.task.id === item.task_id);
  const badges = queueBadges(item, {
    alerts: board.alerts,
    thresholds,
    nowMs: now,
    nextSince: next?.task.assigned_waiting_at ?? next?.task.claimed_at ?? null,
  });
  const waiting = secondsSince(item.requested_at, now) ?? item.waiting_seconds;
  const withDriver = ['assigned_waiting', 'accepted', 'in_progress'].includes(item.status) || !!item.assignee;
  const pills = [...badges];
  if (item.status === 'broadcast') pills.unshift({ level: 'warning', label: s02.queueState.broadcast });
  if (item.status === 'offered' && !item.assignee) {
    const left = item.offer?.expires_at
      ? Math.max(0, Math.ceil((Date.parse(item.offer.expires_at) - now) / 1000))
      : null;
    pills.unshift({
      level: 'warning',
      label:
        left != null ? `${s02.queueState.offeredAnyone} ${formatClock(left)}` : s02.queueState.offeredAnyone,
    });
  }
  return (
    <QueueItem
      ticketNumber={item.ticket.display_number}
      status={item.ticket.status}
      vehicle={vehicleSummary(item.ticket.vehicle) || plateText(item.ticket.plate)}
      plate={plateValue(item.ticket.plate)}
      waiting={formatClock(waiting)}
      assignee={withDriver ? queueStateText(item) : null}
      escalations={pills}
      critical={badges.some((b) => b.level === 'critical')}
    />
  );
}

function TaskRows({
  cards,
  board,
  now,
  thresholds,
  empty,
}: {
  cards: readonly TaskCard[];
  board: OperationsBoard;
  now: number;
  thresholds: Thresholds;
  empty: string;
}) {
  if (!cards.length) return <EmptyState title={empty} />;
  return (
    <div className="pt-taskrow-scroll" role="table" aria-label={s02.tabs.active}>
      {cards.map((card) => {
        const since = stageSince(card);
        const elapsed = secondsSince(since, now);
        const extra: string[] = [];
        if (notCollected(card, { alerts: board.alerts, thresholds, nowMs: now, readySince: since }))
          extra.push(s02.escalation.notCollected);
        if (
          card.task.status === 'assigned_waiting' &&
          ((elapsed != null && elapsed >= thresholds.nextTaskWaitAlertS) ||
            board.alerts.some(
              (a) =>
                a.type === 'next_task_waiting_long' && a.task_id === card.task.id && a.status !== 'resolved',
            ))
        )
          extra.push(s02.escalation.longWait);
        const stage = [`${taskType[card.task.type]} · ${taskStatus[card.task.status]}`, ...extra].join(' · ');
        return (
          <Link
            key={card.task.id}
            to={staffPaths.ticket(card.ticket.id)}
            className="st-link-row"
            aria-label={`${buttons.open} #${card.ticket.display_number}`}
          >
            <TaskRow
              ticketNumber={card.ticket.display_number}
              status={card.ticket.status}
              driver={card.task.assignee?.full_name ?? null}
              stage={stage}
              elapsed={elapsed != null ? formatClock(elapsed) : staff.none}
            />
          </Link>
        );
      })}
    </div>
  );
}

function Drivers({ board }: { board: OperationsBoard }) {
  if (!board.drivers.length) return <EmptyState icon={Users} title={alertType.no_drivers_on_duty} />;
  return (
    <ul className="st-stack">
      {board.drivers.map((d) => {
        const info = driverTaskInfo(d, board);
        return (
          <li key={d.driver.id}>
            <DriverRow
              name={d.driver.full_name}
              state={d.driver_state}
              connection={d.connection_state ?? 'online'}
              lastSync={d.last_heartbeat_at ? formatTime(d.last_heartbeat_at) : undefined}
              current={info.current}
              next={info.next}
              custody={info.custody}
            />
          </li>
        );
      })}
    </ul>
  );
}

function FailedMessages({ board }: { board: OperationsBoard }) {
  if (!board.failed_messages.length)
    return <EmptyState icon={MessageCircleWarning} title={s02.emptyFailed} />;
  return (
    <ul className="pt-list">
      {board.failed_messages.map((m) => {
        const at = m.failed_at ?? m.queued_at;
        const meta = [m.error_title ?? m.error_code ?? waMessageStatus[m.status], at ? formatTime(at) : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={m.id}>
            <ListItem
              icon={MessageCircleWarning}
              title={fmt(s02.failedLine, { purpose: m.purpose ?? m.template_name ?? '' })}
              meta={meta}
              to={m.ticket_id ? staffPaths.ticket(m.ticket_id) : undefined}
            />
          </li>
        );
      })}
    </ul>
  );
}

function CustodyIssues({ board, now }: { board: OperationsBoard; now: number }) {
  if (!board.custody_issues.length) return <EmptyState icon={KeyRound} title={s02.emptyCustody} />;
  return (
    <ul className="pt-list">
      {board.custody_issues.map((c) => {
        const holder =
          c.holder.type === 'driver' || c.holder.type === 'supervisor'
            ? c.holder.label
              ? fmt(custodyHolder[c.holder.type], { name: c.holder.label })
              : custodyHolder[c.holder.type].replace(/\s*\{name\}/, '')
            : c.holder.type === 'spot' || c.holder.type === 'key_slot'
              ? c.holder.label
                ? fmt(custodyHolder[c.holder.type], { label: c.holder.label })
                : custodyHolder[c.holder.type].replace(/\s*\{label\}/, '')
              : custodyHolder[c.holder.type];
        return (
          <li key={`${c.ticket.id}:${c.subject}`}>
            <ListItem
              icon={KeyRound}
              title={
                <span className="st-inline-list">
                  <span className="pt-ticketno">#{c.ticket.display_number}</span>
                  <span>{fmt(s02.custodyLine, { subject: custodySubject[c.subject], holder })}</span>
                </span>
              }
              meta={formatSinceMinutes(now - Date.parse(c.since))}
              to={staffPaths.ticket(c.ticket.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** «ابحث برقم اللوحة أو رقم التذكرة» (02 S-02): `GET /v1/tickets?q=` in the selected event or venue. */
function TicketSearch({ venueId, eventId }: { venueId: string | null; eventId?: string }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const scope = eventId ?? venueId ?? '';
  const results = useQuery({
    queryKey: staffKeys.ticketSearch(scope, debounced),
    queryFn: ({ signal }) => searchTickets({ eventId, venueId: venueId ?? undefined }, debounced, signal),
    enabled: debounced.length > 0 && !!scope,
  });
  return (
    <div className="st-section">
      <SearchField id="ops-search" value={q} onChange={setQ} loading={results.isFetching} inputMode="text" />
      {debounced && results.data ? (
        results.data.items.length ? (
          <ul className="pt-list" aria-label={s02.searchResults}>
            {results.data.items.map((t) => (
              <li key={t.id}>
                <ListItem
                  title={
                    <span className="st-inline-list">
                      <span className="pt-ticketno">#{t.display_number}</span>
                      <span>{plateText(t.plate)}</span>
                    </span>
                  }
                  meta={[vehicleSummary(t.vehicle), t.event_name_ar].filter(Boolean).join(' · ')}
                  trailing={<StatusChip status={t.status} size="sm" />}
                  to={staffPaths.ticket(t.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="st-muted">{staff.noResults}</p>
        )
      ) : null}
      {results.isError ? <QueryError error={results.error} /> : null}
    </div>
  );
}
