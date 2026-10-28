import type {
  Alert,
  CustodyIssue,
  DriverLive,
  OperationsBoard,
  OperationsKpis,
  Plate,
  QueueItem,
  TaskCard,
  VenueSettings,
  WaHealthStatus,
} from '@/api/types';
import type { PlateValue } from '@/components';
import { s02, staff, vehicleColor, vehicleMake } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';

/**
 * Pure model of the operations board (S-02, 02 §4 S-02): ordering, waiting counters, escalation badges,
 * the merge of «كل الحفلات المفتوحة», and per-driver task/custody derived from the snapshot. Unit-tested
 * (test/staff/opsModel.test.ts); the page only renders what this returns.
 */

/** Canon §12 defaults, used until the venue's own settings load. */
export const DEFAULT_THRESHOLDS = {
  unacceptedEscalationS: 60,
  nextTaskWaitAlertS: 300,
  readyUncollectedS: 10 * 60,
};
export type Thresholds = typeof DEFAULT_THRESHOLDS;

export function thresholdsFrom(settings?: VenueSettings | null): Thresholds {
  return {
    unacceptedEscalationS:
      settings?.dispatch?.unaccepted_escalation_s ?? DEFAULT_THRESHOLDS.unacceptedEscalationS,
    nextTaskWaitAlertS: settings?.dispatch?.next_task_wait_alert_s ?? DEFAULT_THRESHOLDS.nextTaskWaitAlertS,
    readyUncollectedS:
      settings?.ready?.uncollected_alert_min != null
        ? settings.ready.uncollected_alert_min * 60
        : DEFAULT_THRESHOLDS.readyUncollectedS,
  };
}

/** Whole seconds from `sinceIso` to `nowMs` (server time); never negative; null when unknown. */
export function secondsSince(sinceIso: string | null | undefined, nowMs: number): number | null {
  if (!sinceIso) return null;
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/** Oldest `requested_at` first (canon §2 rule 6; 02 S-02 «الأقدم أولًا»), ties by task id for stability. */
export function sortQueue(queue: readonly QueueItem[]): QueueItem[] {
  return [...queue].sort((a, b) => {
    const d = Date.parse(a.requested_at) - Date.parse(b.requested_at);
    return d !== 0 ? d : a.task_id.localeCompare(b.task_id);
  });
}

/** The queue line under the ticket number (02 S-02 «حالة عنصر الطابور»). */
export function queueStateText(item: QueueItem): string {
  const driver = item.assignee?.full_name ?? '';
  switch (item.status) {
    case 'queued':
      return s02.queueState.queued;
    case 'offered':
      return driver ? fmt(s02.queueState.offered, { driver }) : s02.queueState.offeredAnyone;
    case 'broadcast':
      return s02.queueState.broadcast;
    case 'assigned_waiting':
      return fmt(s02.queueState.assigned_waiting, { driver });
    case 'accepted':
      return fmt(s02.queueState.accepted, { driver });
    case 'in_progress':
      return fmt(s02.queueState.in_progress, { driver });
    default:
      return item.status;
  }
}

export interface Badge {
  level: 'warning' | 'critical';
  label: string;
}

const openAlertFor = (alerts: readonly Alert[], type: Alert['type'], match: (a: Alert) => boolean) =>
  alerts.some((a) => a.type === type && a.status !== 'resolved' && match(a));

/**
 * Escalation badges (02 S-02): «متأخر» after `dispatch.unaccepted_escalation_s` without acceptance (or once
 * the server escalated it), «انتظار طويل» for a reserved next task past `dispatch.next_task_wait_alert_s`.
 * The server's own signals (`escalated_at`, open alerts) win over the local clock.
 */
export function queueBadges(
  item: QueueItem,
  ctx: { alerts: readonly Alert[]; thresholds: Thresholds; nowMs: number; nextSince?: string | null },
): Badge[] {
  const badges: Badge[] = [];
  const unaccepted = ['queued', 'offered', 'broadcast'].includes(item.status);
  const waited = secondsSince(item.requested_at, ctx.nowMs) ?? item.waiting_seconds;
  if (
    unaccepted &&
    (!!item.escalated_at ||
      waited >= ctx.thresholds.unacceptedEscalationS ||
      openAlertFor(ctx.alerts, 'request_unaccepted', (a) => a.task_id === item.task_id))
  )
    badges.push({ level: 'critical', label: s02.escalation.late });
  if (item.status === 'assigned_waiting') {
    const since = secondsSince(ctx.nextSince ?? null, ctx.nowMs);
    if (
      (since != null && since >= ctx.thresholds.nextTaskWaitAlertS) ||
      openAlertFor(ctx.alerts, 'next_task_waiting_long', (a) => a.task_id === item.task_id)
    )
      badges.push({ level: 'warning', label: s02.escalation.longWait });
  }
  return badges;
}

/** «لم تُستلم» for a ready vehicle past `ready.uncollected_alert_min` (02 S-02), or its open alert. */
export function notCollected(
  card: TaskCard,
  ctx: { alerts: readonly Alert[]; thresholds: Thresholds; nowMs: number; readySince?: string | null },
): boolean {
  if (card.ticket.status !== 'ready') return false;
  const since = secondsSince(ctx.readySince ?? null, ctx.nowMs);
  return (
    (since != null && since >= ctx.thresholds.readyUncollectedS) ||
    openAlertFor(ctx.alerts, 'ready_not_collected', (a) => a.ticket_id === card.ticket.id)
  );
}

/** Since when a task has been in its current stage (for the TaskRow counter). */
export function stageSince(card: TaskCard): string | null {
  const t = card.task;
  if (t.status === 'assigned_waiting') return t.assigned_waiting_at ?? t.claimed_at ?? null;
  if (t.status === 'in_progress') return t.started_at ?? t.accepted_at ?? null;
  if (t.status === 'accepted') return t.accepted_at ?? t.claimed_at ?? null;
  return t.queued_at ?? card.requested_at ?? null;
}

/** "تويوتا بيضاء" from the stored English keys (02 §8.4, §9.3 item 16); free text is shown as is. */
export function vehicleSummary(v?: {
  make?: string | null;
  color?: string | null;
  model?: string | null;
}): string {
  if (!v) return '';
  const make = v.make ? ((vehicleMake as Record<string, string>)[v.make] ?? v.make) : '';
  const color = v.color ? ((vehicleColor as Record<string, string>)[v.color] ?? v.color) : '';
  return [make, v.model ?? '', color].filter(Boolean).join(' ');
}

/** `Plate` (07) → PlateBadge props; non-Saudi plates have no letters (`raw`). */
export function plateValue(p?: Plate | null): PlateValue | undefined {
  if (!p) return undefined;
  if (p.digits && p.letters_ar) {
    const letters = Array.from(p.letters_ar.replace(/\s+/g, ''));
    const lettersEn = p.letters_en ? Array.from(p.letters_en.replace(/\s+/g, '')) : undefined;
    return { digits: p.digits, letters, lettersEn };
  }
  return undefined;
}

export const plateText = (p?: Plate | null) => p?.display ?? p?.raw ?? '';

// ---------------------------------------------------------------- drivers

export interface DriverTaskInfo {
  current: number | null;
  next: number | null;
  custody: number;
}

/**
 * Current/next ticket and custody count of a driver from the board: custody follows the task
 * (11 §2.7): park/repark or retrieve `in_progress` → vehicle + key; retrieve `accepted` after key pickup → key;
 * plus the custody issues the server lists for the driver (e.g. after an official transfer).
 */
export function driverTaskInfo(
  driver: DriverLive,
  board: Pick<OperationsBoard, 'active_tasks' | 'next_tasks' | 'custody_issues'>,
): DriverTaskInfo {
  const mine = (c: TaskCard) => c.task.assignee?.id === driver.driver.id;
  const active =
    board.active_tasks.find((c) => c.task.id === driver.active_task_id) ?? board.active_tasks.find(mine);
  const next = board.next_tasks.find((c) => c.task.id === driver.next_task_id) ?? board.next_tasks.find(mine);
  const held = new Set<string>();
  for (const c of board.active_tasks.filter(mine)) {
    if (c.task.status === 'in_progress') {
      held.add(`${c.ticket.id}:vehicle`);
      held.add(`${c.ticket.id}:key`);
    } else if (c.task.status === 'accepted' && c.task.key_picked_up_at) held.add(`${c.ticket.id}:key`);
  }
  for (const issue of board.custody_issues)
    if (issue.holder.type === 'driver' && issue.holder.id === driver.driver.id)
      held.add(`${issue.ticket.id}:${issue.subject}`);
  return {
    current: active?.ticket.display_number ?? null,
    next: next?.ticket.display_number ?? null,
    custody: held.size,
  };
}

// ---------------------------------------------------------------- «كل الحفلات المفتوحة»

const HEALTH_RANK: Record<WaHealthStatus, number> = { healthy: 0, degraded: 1, down: 2 };

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * One board from the boards of every open event of the venue (02 §9.3 item 15: the UI merges the replies).
 * Lists are concatenated and de-duplicated; driver counters are recomputed from the de-duplicated drivers
 * (events of one venue share its dispatch pool); the oldest wait is the maximum; the 30-minute acceptance
 * average is the mean of the events that have one (no per-event counts in the reply).
 */
export function mergeBoards(boards: readonly OperationsBoard[]): OperationsBoard | null {
  const [first] = boards;
  if (!first) return null;
  if (boards.length === 1) return first;
  const drivers = uniqueBy(
    boards.flatMap((b) => b.drivers),
    (d) => d.driver.id,
  );
  const sum = (k: keyof OperationsKpis) =>
    boards.reduce((n, b) => n + ((b.kpis[k] as number | null) ?? 0), 0);
  const waits = boards.map((b) => b.kpis.oldest_wait_seconds).filter((v): v is number => v != null);
  const accepts = boards.map((b) => b.kpis.avg_accept_seconds_30m).filter((v): v is number => v != null);
  const kpis: OperationsKpis = {
    open_requests: sum('open_requests'),
    oldest_wait_seconds: waits.length ? Math.max(...waits) : null,
    avg_accept_seconds_30m: accepts.length ? accepts.reduce((a, b) => a + b, 0) / accepts.length : null,
    drivers_available: drivers.filter((d) => d.driver_state === 'available').length,
    drivers_busy: drivers.filter((d) =>
      ['intake_parking', 'retrieving', 'busy_with_next'].includes(d.driver_state),
    ).length,
    drivers_on_break: drivers.filter((d) => d.driver_state === 'on_break').length,
    drivers_on_duty: drivers.filter((d) => d.driver_state !== 'off_duty').length,
    vehicles_parked: sum('vehicles_parked'),
    ready_waiting: sum('ready_waiting'),
  };
  return {
    event: first.event,
    kpis,
    queue: sortQueue(
      uniqueBy(
        boards.flatMap((b) => b.queue),
        (q) => q.task_id,
      ),
    ),
    active_tasks: uniqueBy(
      boards.flatMap((b) => b.active_tasks),
      (c) => c.task.id,
    ),
    next_tasks: uniqueBy(
      boards.flatMap((b) => b.next_tasks),
      (c) => c.task.id,
    ),
    drivers,
    alerts: uniqueBy(
      boards.flatMap((b) => b.alerts),
      (a) => a.id,
    ),
    failed_messages: uniqueBy(
      boards.flatMap((b) => b.failed_messages),
      (m) => m.id,
    ),
    custody_issues: uniqueBy(
      boards.flatMap((b) => b.custody_issues),
      (c: CustodyIssue) => `${c.ticket.id}:${c.subject}`,
    ),
    channel_health: boards.reduce<WaHealthStatus>(
      (w, b) => (HEALTH_RANK[b.channel_health] > HEALTH_RANK[w] ? b.channel_health : w),
      'healthy',
    ),
  };
}

/** Alerts still needing attention, most severe first then newest (07 §1.7: alerts newest first). */
export function liveAlerts(alerts: readonly Alert[]): Alert[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return alerts
    .filter((a) => a.status !== 'resolved')
    .sort((a, b) => rank[a.severity] - rank[b.severity] || Date.parse(b.raised_at) - Date.parse(a.raised_at));
}

/** The «اسم · #رقم» context of an alert for AlertItem (ticket number from `details.display_number`). */
export function alertContext(alert: Alert): string | null {
  const n = alert.details?.display_number;
  if (typeof n === 'number' || (typeof n === 'string' && n)) return `#${n}`;
  const name = alert.details?.driver_name;
  return typeof name === 'string' && name ? name : null;
}

export const dash = staff.none;
