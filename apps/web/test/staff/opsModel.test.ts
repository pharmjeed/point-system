import { describe, expect, it } from 'vitest';
import {
  alertContext,
  DEFAULT_THRESHOLDS,
  driverTaskInfo,
  liveAlerts,
  mergeBoards,
  notCollected,
  plateValue,
  queueBadges,
  queueStateText,
  secondsSince,
  sortQueue,
  stageSince,
  taskWaitsLong,
  thresholdsFrom,
  vehicleSummary,
} from '@/features/supervisor/opsModel';
import { ago, alert, board, driverLive, NOW, queueItem, taskCard, ticketSummary } from './fixtures';

describe('S-02 queue (oldest requested_at first, canon §2 rule 6)', () => {
  it('sorts by requested_at, ties by task id, without mutating the reply', () => {
    const queue = [
      queueItem({ task_id: 'k-3', requested_at: ago(20) }),
      queueItem({ task_id: 'k-2', requested_at: ago(300) }),
      queueItem({ task_id: 'k-1', requested_at: ago(20) }),
    ];
    expect(sortQueue(queue).map((q) => q.task_id)).toEqual(['k-2', 'k-1', 'k-3']);
    expect(queue.map((q) => q.task_id)).toEqual(['k-3', 'k-2', 'k-1']);
  });

  it('counts whole seconds from server time, never negative', () => {
    expect(secondsSince(ago(75.9), NOW)).toBe(75);
    expect(secondsSince(new Date(NOW + 5000).toISOString(), NOW)).toBe(0);
    expect(secondsSince(null, NOW)).toBeNull();
    expect(secondsSince('not a date', NOW)).toBeNull();
  });

  it('describes each queue state with the driver name', () => {
    const driver = { id: 'd-1', full_name: 'خالد' };
    expect(queueStateText(queueItem({ status: 'queued' }))).toBe('في الطابور');
    expect(queueStateText(queueItem({ status: 'offered', assignee: driver }))).toBe('معروض على خالد');
    expect(queueStateText(queueItem({ status: 'offered' }))).toBe('معروض');
    expect(queueStateText(queueItem({ status: 'broadcast' }))).toBe('بث');
    expect(queueStateText(queueItem({ status: 'assigned_waiting', assignee: driver }))).toBe(
      'محجوز تالٍ لـخالد',
    );
    expect(queueStateText(queueItem({ status: 'in_progress', assignee: driver }))).toBe(
      'جارٍ الإحضار — خالد',
    );
  });

  it('names the recipient of a single round from offer.recipient (DEC-316)', () => {
    const offer = { offer_id: 'o-1', mode: 'single' as const, round_no: 1, recipients: 1 };
    expect(
      queueStateText(
        queueItem({ status: 'offered', offer: { ...offer, recipient: { id: 'd-2', full_name: 'سعد' } } }),
      ),
    ).toBe('معروض على سعد');
    expect(queueStateText(queueItem({ status: 'offered', offer: { ...offer, recipient: null } }))).toBe(
      'معروض',
    );
  });
});

describe('S-02 escalation badges', () => {
  const ctx = { alerts: [], thresholds: DEFAULT_THRESHOLDS, nowMs: NOW };

  it('«متأخر» once an unaccepted request passes dispatch.unaccepted_escalation_s', () => {
    expect(queueBadges(queueItem({ requested_at: ago(59) }), ctx)).toEqual([]);
    expect(queueBadges(queueItem({ requested_at: ago(60) }), ctx)).toEqual([
      { level: 'critical', label: 'متأخر' },
    ]);
    expect(queueBadges(queueItem({ status: 'broadcast', requested_at: ago(90) }), ctx)).toHaveLength(1);
  });

  it('the server signals win over the local clock (escalated_at, an open request_unaccepted alert)', () => {
    expect(queueBadges(queueItem({ requested_at: ago(5), escalated_at: ago(1) }), ctx)).toHaveLength(1);
    const alerts = [alert({ task_id: 'k-1' })];
    expect(queueBadges(queueItem({ requested_at: ago(5) }), { ...ctx, alerts })).toHaveLength(1);
    const resolved = [alert({ task_id: 'k-1', status: 'resolved' })];
    expect(queueBadges(queueItem({ requested_at: ago(5) }), { ...ctx, alerts: resolved })).toEqual([]);
  });

  it('the server badges of the snapshot are the reference (DEC-241, DEC-315)', () => {
    expect(queueBadges(queueItem({ requested_at: ago(5), badges: ['late'] }), ctx)).toEqual([
      { level: 'critical', label: 'متأخر' },
    ]);
    const waiting = queueItem({ status: 'assigned_waiting', requested_at: ago(5), badges: ['long_wait'] });
    expect(queueBadges(waiting, { ...ctx, nextSince: ago(1) })).toEqual([
      { level: 'warning', label: 'انتظار طويل' },
    ]);
    // a `late` badge never shows once the request was taken
    expect(queueBadges(queueItem({ status: 'accepted', badges: ['late'] }), ctx)).toEqual([]);
    const ready = {
      ...taskCard({ status: 'in_progress' }, { status: 'ready' }),
      badges: ['not_collected' as const],
    };
    expect(notCollected(ready, { ...ctx, readySince: ago(5) })).toBe(true);
    const next = { ...taskCard({ status: 'assigned_waiting' }), badges: ['long_wait' as const] };
    expect(taskWaitsLong(next, { ...ctx, since: ago(5) })).toBe(true);
  });

  it('«انتظار طويل» on a next task card: badge, open alert or the local clock', () => {
    const next = taskCard({ status: 'assigned_waiting', id: 'k-9' });
    expect(taskWaitsLong(next, { ...ctx, since: ago(299) })).toBe(false);
    expect(taskWaitsLong(next, { ...ctx, since: ago(300) })).toBe(true);
    const alerts = [alert({ type: 'next_task_waiting_long', task_id: 'k-9', severity: 'warning' })];
    expect(taskWaitsLong(next, { ...ctx, alerts, since: ago(5) })).toBe(true);
    expect(taskWaitsLong(taskCard({ status: 'accepted' }), { ...ctx, since: ago(900) })).toBe(false);
  });

  it('no «متأخر» once accepted; «انتظار طويل» for a reserved next task past next_task_wait_alert_s', () => {
    expect(queueBadges(queueItem({ status: 'accepted', requested_at: ago(900) }), ctx)).toEqual([]);
    const waiting = queueItem({ status: 'assigned_waiting', requested_at: ago(900) });
    expect(queueBadges(waiting, { ...ctx, nextSince: ago(120) })).toEqual([]);
    expect(queueBadges(waiting, { ...ctx, nextSince: ago(300) })).toEqual([
      { level: 'warning', label: 'انتظار طويل' },
    ]);
  });

  it('uses the venue thresholds when they are loaded', () => {
    const thresholds = thresholdsFrom({
      dispatch: { unaccepted_escalation_s: 120, next_task_wait_alert_s: 60 },
      ready: { uncollected_alert_min: 5 },
    });
    expect(thresholds).toEqual({
      unacceptedEscalationS: 120,
      nextTaskWaitAlertS: 60,
      readyUncollectedS: 300,
    });
    expect(thresholdsFrom(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(queueBadges(queueItem({ requested_at: ago(90) }), { ...ctx, thresholds })).toEqual([]);
  });

  it('«لم تُستلم» for a ready vehicle past ready.uncollected_alert_min', () => {
    const card = taskCard({ status: 'in_progress' }, { status: 'ready' });
    expect(notCollected(card, { ...ctx, readySince: ago(599) })).toBe(false);
    expect(notCollected(card, { ...ctx, readySince: ago(600) })).toBe(true);
    const alerts = [alert({ type: 'ready_not_collected', ticket_id: 't-1', severity: 'warning' })];
    expect(notCollected(card, { ...ctx, alerts, readySince: ago(5) })).toBe(true);
    expect(notCollected(taskCard({}, { status: 'retrieving' }), { ...ctx, readySince: ago(900) })).toBe(
      false,
    );
  });

  it('stage start per task status', () => {
    expect(stageSince(taskCard({ status: 'assigned_waiting', assigned_waiting_at: ago(10) }))).toBe(ago(10));
    expect(stageSince(taskCard({ status: 'in_progress', started_at: ago(20), accepted_at: ago(30) }))).toBe(
      ago(20),
    );
    expect(stageSince(taskCard({ status: 'accepted', accepted_at: ago(30) }))).toBe(ago(30));
  });
});

describe('S-02 drivers and «كل الحفلات المفتوحة»', () => {
  it('derives current/next ticket and custody from the snapshot', () => {
    const b = board({
      active_tasks: [
        taskCard(
          { id: 'k-1', status: 'in_progress', assignee: { id: 'd-1', full_name: 'خالد' } },
          { id: 't-1', display_number: 41 },
        ),
        taskCard(
          {
            id: 'k-2',
            ticket_id: 't-2',
            status: 'accepted',
            key_picked_up_at: ago(5),
            assignee: { id: 'd-2', full_name: 'سعد' },
          },
          { id: 't-2', display_number: 42 },
        ),
      ],
      next_tasks: [
        taskCard(
          {
            id: 'k-3',
            ticket_id: 't-3',
            status: 'assigned_waiting',
            assignee: { id: 'd-1', full_name: 'خالد' },
          },
          { id: 't-3', display_number: 43 },
        ),
      ],
      custody_issues: [
        {
          ticket: ticketSummary({ id: 't-9', display_number: 49 }),
          subject: 'key',
          holder: { type: 'driver', id: 'd-1', label: 'خالد' },
          since: ago(600),
        },
      ],
    });
    expect(driverTaskInfo(driverLive('d-1', { active_task_id: 'k-1', next_task_id: 'k-3' }), b)).toEqual({
      current: 41,
      next: 43,
      custody: 3,
    });
    expect(driverTaskInfo(driverLive('d-2'), b)).toEqual({ current: 42, next: null, custody: 1 });
    expect(driverTaskInfo(driverLive('d-3'), b)).toEqual({ current: null, next: null, custody: 0 });
  });

  it('merges the boards of every open event of the venue', () => {
    const shared = driverLive('d-1');
    const a = board({
      queue: [queueItem({ task_id: 'k-1', requested_at: ago(30) })],
      drivers: [shared, driverLive('d-2', { driver_state: 'retrieving' })],
      alerts: [alert({ id: 'a-1' })],
      kpis: {
        ...board().kpis,
        open_requests: 1,
        oldest_wait_seconds: 30,
        avg_accept_seconds_30m: 20,
        vehicles_parked: 5,
      },
    });
    const b = board({
      event: { ...board().event, id: 'e-2' },
      queue: [queueItem({ task_id: 'k-2', requested_at: ago(120) })],
      drivers: [shared, driverLive('d-3', { driver_state: 'on_break' })],
      alerts: [alert({ id: 'a-1' }), alert({ id: 'a-2' })],
      channel_health: 'degraded',
      kpis: {
        ...board().kpis,
        open_requests: 2,
        oldest_wait_seconds: 120,
        avg_accept_seconds_30m: 40,
        vehicles_parked: 3,
      },
    });
    const merged = mergeBoards([a, b]);
    expect(merged?.queue.map((q) => q.task_id)).toEqual(['k-2', 'k-1']);
    expect(merged?.drivers.map((d) => d.driver.id)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(merged?.alerts.map((x) => x.id)).toEqual(['a-1', 'a-2']);
    expect(merged?.channel_health).toBe('degraded');
    expect(merged?.kpis).toMatchObject({
      open_requests: 3,
      oldest_wait_seconds: 120,
      avg_accept_seconds_30m: 30,
      drivers_available: 1,
      drivers_busy: 1,
      drivers_on_break: 1,
      drivers_on_duty: 3,
      vehicles_parked: 8,
    });
    expect(mergeBoards([])).toBeNull();
    expect(mergeBoards([a])).toBe(a);
  });
});

describe('alerts and display helpers', () => {
  it('lists live alerts most severe first, then newest', () => {
    const list = liveAlerts([
      alert({ id: 'w-old', severity: 'warning', raised_at: ago(100) }),
      alert({ id: 'c', severity: 'critical', raised_at: ago(200) }),
      alert({ id: 'w-new', severity: 'warning', raised_at: ago(10) }),
      alert({ id: 'r', severity: 'critical', status: 'resolved' }),
      alert({ id: 'i', severity: 'info', status: 'acknowledged' }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['c', 'w-new', 'w-old', 'i']);
  });

  it('gives an alert its ticket number or driver name', () => {
    expect(alertContext(alert({ details: { display_number: 47 } }))).toBe('#47');
    expect(alertContext(alert({ details: { driver_name: 'خالد' } }))).toBe('خالد');
    expect(alertContext(alert())).toBeNull();
  });

  it('shows the vehicle from the stored keys and the Saudi plate as PlateBadge letters', () => {
    expect(vehicleSummary({ make: 'toyota', model: 'كامري', color: 'white' })).toBe('تويوتا كامري أبيض');
    expect(vehicleSummary({ make: 'Rolls', color: null })).toBe('Rolls');
    expect(plateValue(ticketSummary().plate)).toEqual({
      digits: '1234',
      letters: ['أ', 'ب', 'ج'],
      lettersEn: ['A', 'B', 'J'],
    });
    expect(plateValue({ country: 'BH', raw: '12345', display: '12345' })).toBeUndefined();
  });
});
