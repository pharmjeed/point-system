import type { Me, Payment, TicketDetail } from '@/api/types';

/**
 * Permission gating for the staff screens (09 §3, canon §10). `GET /v1/me.permissions` is the list the
 * server grants this session; hiding a button is UX only — the server re-checks every command (02 §0) and
 * its refusal text is shown (RootLayout toasts PERMISSION_DENIED and refetches /v1/me).
 */
export type Permission =
  | 'ticket.read_full'
  | 'ticket.read_photos'
  | 'ticket.reveal_phone'
  | 'ticket.void'
  | 'ticket.inspection_exception'
  | 'ticket.repark'
  | 'ticket.custody_transfer'
  | 'retrieval.request_on_behalf'
  | 'retrieval.cancel'
  | 'task.release_custody'
  | 'task.reassign'
  | 'handover.resend_code'
  | 'handover.exception'
  | 'payment.record'
  | 'payment.reverse'
  | 'payment.waive'
  | 'cash.handover_confirm'
  | 'event.manage'
  | 'venue.read'
  | 'venue.layout_read'
  | 'driver.read'
  | 'driver.transfer'
  | 'alert.read'
  | 'alert.manage'
  | 'incident.read'
  | 'incident.create'
  | 'incident.manage'
  | 'report.read'
  | 'export.create'
  | 'audit.read'
  | 'wa.channel_read'
  | 'wa.channel_manage'
  | 'wa.templates_manage'
  | 'outbox.manage'
  | 'retention.manage'
  | 'org.settings_manage'
  | 'staff.manage';

export const can = (me: Pick<Me, 'permissions'>, permission: Permission): boolean =>
  me.permissions.includes(permission);

export const canAll = (me: Pick<Me, 'permissions'>, ...permissions: Permission[]): boolean =>
  permissions.every((p) => me.permissions.includes(p));

/** The S-03 action panel (02 S-03 table). Keys are stable ids used by the panel and the tests. */
export type TicketAction =
  | 'reassign'
  | 'releaseCustody'
  | 'cancelRetrieval'
  | 'repark'
  | 'handoverException'
  | 'resendCode'
  | 'custodyTransfer'
  | 'revealPhone'
  | 'onBehalf'
  | 'voidTicket'
  | 'inspectionException'
  | 'waiver'
  | 'reverse'
  | 'openIncident'
  | 'recordPayment';

const OPEN_STATUSES = new Set([
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
]);

export const isOpenTicket = (t: Pick<TicketDetail, 'status'>) => OPEN_STATUSES.has(t.status);

/** A payment that can still be reversed (13 §7). */
export const isReversible = (p: Payment | null | undefined): p is Payment => !!p && p.status === 'recorded';

/**
 * Which actions of the 02 S-03 table are offered, from the permission list and the ticket snapshot (state,
 * open task, payment). The server stays the judge (state, version, custody, scope).
 */
export function ticketActions(me: Pick<Me, 'permissions' | 'user'>, t: TicketDetail): TicketAction[] {
  const out: TicketAction[] = [];
  const open = isOpenTicket(t);
  const task = t.open_task ?? null;
  const retrieveTask = task && task.type === 'retrieve' ? task : null;
  const beforeMovement =
    !!retrieveTask &&
    (['offered', 'broadcast', 'assigned_waiting'].includes(retrieveTask.status) ||
      (retrieveTask.status === 'accepted' && !retrieveTask.started_at));

  if (can(me, 'task.reassign') && retrieveTask && beforeMovement) out.push('reassign');
  if (
    can(me, 'task.release_custody') &&
    retrieveTask &&
    retrieveTask.status === 'accepted' &&
    !!retrieveTask.key_picked_up_at &&
    !retrieveTask.started_at
  )
    out.push('releaseCustody');
  if (
    can(me, 'retrieval.cancel') &&
    !!t.active_cycle &&
    ['requested', 'assigned', 'assigned_waiting', 'retrieving', 'ready'].includes(t.status)
  )
    out.push('cancelRetrieval');
  if (can(me, 'ticket.repark') && t.status === 'ready') out.push('repark');
  if (can(me, 'handover.exception') && t.status === 'ready') out.push('handoverException');
  if (can(me, 'handover.resend_code') && t.status === 'ready' && t.wa_link_status === 'linked')
    out.push('resendCode');
  if (can(me, 'ticket.custody_transfer') && open) out.push('custodyTransfer');
  if (can(me, 'ticket.reveal_phone') && !!t.customer?.phone_masked) out.push('revealPhone');
  if (can(me, 'retrieval.request_on_behalf') && t.status === 'parked' && !t.active_cycle)
    out.push('onBehalf');
  if (can(me, 'ticket.void') && (t.status === 'received' || t.status === 'parking')) out.push('voidTicket');
  if (can(me, 'ticket.inspection_exception') && t.inspection_status === 'incomplete')
    out.push('inspectionException');
  if (can(me, 'payment.waive') && t.payment_status === 'due' && t.status !== 'voided') out.push('waiver');
  if (can(me, 'payment.reverse') && isReversible(t.payment)) out.push('reverse');
  if (
    can(me, 'payment.record') &&
    t.status === 'ready' &&
    t.payment_status === 'due' &&
    retrieveTask?.assignee?.id === me.user.id
  )
    out.push('recordPayment');
  if (can(me, 'incident.create')) out.push('openIncident');
  return out;
}

/** Admin area sections (02 §2.2 table, 02 S-13) — read permission per section. */
export type AdminSection = 'audit' | 'outbox' | 'channel' | 'templates' | 'retention' | 'org';

export const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSection; read: Permission }> = [
  { id: 'channel', read: 'wa.channel_read' },
  { id: 'templates', read: 'wa.channel_read' },
  { id: 'outbox', read: 'outbox.manage' },
  { id: 'audit', read: 'audit.read' },
  { id: 'retention', read: 'audit.read' },
  { id: 'org', read: 'org.settings_manage' },
];

export const adminSectionsFor = (me: Pick<Me, 'permissions'>): AdminSection[] =>
  ADMIN_SECTIONS.filter((s) => can(me, s.read)).map((s) => s.id);
