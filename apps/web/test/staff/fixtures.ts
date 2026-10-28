import type {
  Alert,
  DriverLive,
  Me,
  OperationsBoard,
  QueueItem,
  Task,
  TaskCard,
  TicketDetail,
  TicketSummary,
} from '@/api/types';

/** Small builders for the staff-screen model tests (shapes of docs/07_openapi.yaml). */

export const NOW = Date.parse('2026-10-29T18:00:00Z');
export const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

export function ticketSummary(over: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 't-1',
    display_number: 1,
    event_id: 'e-1',
    venue_id: 'v-1',
    status: 'parked',
    channel: 'whatsapp',
    plate: { country: 'SA', digits: '1234', letters_ar: 'أ ب ج', letters_en: 'A B J', display: 'أ ب ج 1234' },
    wa_link_status: 'linked',
    payment_status: 'not_required',
    version: 1,
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  return {
    id: 'k-1',
    ticket_id: 't-1',
    type: 'retrieve',
    status: 'queued',
    priority_at: ago(30),
    seq: 1,
    version: 1,
    ...over,
  };
}

export function queueItem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    task_id: 'k-1',
    ticket: ticketSummary(),
    status: 'queued',
    requested_at: ago(30),
    waiting_seconds: 30,
    ...over,
  };
}

export function taskCard(t: Partial<Task> = {}, ticket: Partial<TaskCard['ticket']> = {}): TaskCard {
  const k = task(t);
  return {
    task: k,
    ticket: { id: k.ticket_id, display_number: 1, status: 'retrieving', version: 1, ...ticket },
  };
}

export function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 'a-1',
    venue_id: 'v-1',
    type: 'request_unaccepted',
    severity: 'critical',
    status: 'open',
    raised_at: ago(10),
    ...over,
  };
}

export function driverLive(id: string, over: Partial<DriverLive> = {}): DriverLive {
  return {
    driver: { id, full_name: `سائق ${id}` },
    driver_state: 'available',
    connection_state: 'online',
    ...over,
  };
}

export function board(over: Partial<OperationsBoard> = {}): OperationsBoard {
  return {
    event: {
      id: 'e-1',
      venue_id: 'v-1',
      dispatch_pool_id: 'p-1',
      name_ar: 'حفل',
      event_date: '2026-10-29',
      status: 'open',
      pricing_mode: 'included',
      fee_halalas: 0,
      version: 1,
    },
    kpis: {
      open_requests: 0,
      oldest_wait_seconds: null,
      avg_accept_seconds_30m: null,
      drivers_available: 0,
      drivers_busy: 0,
      drivers_on_break: 0,
      drivers_on_duty: 0,
      vehicles_parked: 0,
      ready_waiting: 0,
    },
    queue: [],
    active_tasks: [],
    next_tasks: [],
    drivers: [],
    alerts: [],
    failed_messages: [],
    custody_issues: [],
    channel_health: 'healthy',
    ...over,
  };
}

export function ticketDetail(over: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ...ticketSummary(),
    projection: 'full',
    customer: { phone_masked: '05•••••123', consent: null },
    inspection_status: 'complete',
    ...over,
  };
}

/** Canon §10 base grants (packages/shared ROLE_PERMISSIONS), as `/v1/me.permissions` sends them. */
export const PERMISSIONS = {
  owner: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'event.manage',
    'shift.manage',
    'venue.read',
    'venue.manage',
    'venue.layout_read',
    'driver.read',
    'driver.manage',
    'driver.assign',
    'driver.transfer',
    'staff.manage',
    'alert.read',
    'alert.manage',
    'incident.read',
    'report.read',
    'export.create',
    'audit.read',
    'wa.channel_read',
    'wa.channel_manage',
    'wa.templates_manage',
    'outbox.manage',
    'retention.manage',
    'org.settings_manage',
    'telemetry.write',
  ],
  admin: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'ticket.change_phone',
    'ticket.void',
    'ticket.manual_reconcile',
    'payment.reverse',
    'cash.handover_confirm',
    'event.manage',
    'shift.manage',
    'venue.read',
    'venue.manage',
    'venue.layout_read',
    'driver.read',
    'driver.manage',
    'driver.assign',
    'driver.transfer',
    'staff.manage',
    'alert.read',
    'alert.manage',
    'incident.read',
    'incident.create',
    'incident.manage',
    'report.read',
    'export.create',
    'audit.read',
    'wa.channel_read',
    'wa.templates_manage',
    'outbox.manage',
    'telemetry.write',
  ],
  supervisor: [
    'auth.self',
    'ticket.read_minimal',
    'ticket.read_full',
    'ticket.read_photos',
    'ticket.reveal_phone',
    'ticket.change_phone',
    'ticket.void',
    'ticket.inspection_exception',
    'ticket.repark',
    'ticket.custody_transfer',
    'ticket.manual_reconcile',
    'wa.link',
    'retrieval.request_on_behalf',
    'retrieval.cancel',
    'task.release_custody',
    'task.reassign',
    'handover.resend_code',
    'handover.exception',
    'payment.reverse',
    'payment.waive',
    'cash.handover_confirm',
    'event.manage',
    'shift.manage',
    'duty.force_end',
    'venue.read',
    'venue.layout_read',
    'driver.read',
    'driver.assign',
    'driver.transfer',
    'alert.read',
    'alert.manage',
    'incident.read',
    'incident.create',
    'incident.manage',
    'report.read',
    'export.create',
    'telemetry.write',
  ],
} as const;

export function meWith(
  role: keyof typeof PERMISSIONS,
  extra: string[] = [],
): Pick<Me, 'permissions' | 'user'> {
  return {
    permissions: [...PERMISSIONS[role], ...extra],
    user: { id: `u-${role}`, employee_code: 'S-1', full_name: 'مشرف', role, status: 'active', version: 1 },
  };
}
