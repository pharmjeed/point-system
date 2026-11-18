import type { CustodyHolderType, CustodySubject, Me, Payment, TicketDetail } from '@/api/types';

/**
 * Permission gating for the staff screens (09 §3, canon §10). `GET /v1/me.permissions` is the list the
 * server grants this session; hiding a button is UX only — the server re-checks every command (02 §0) and
 * its refusal text is shown (RootLayout toasts PERMISSION_DENIED and refetches /v1/me).
 */
export type Permission =
  | 'ticket.read_full'
  | 'ticket.read_photos'
  | 'ticket.reveal_phone'
  | 'ticket.change_phone'
  | 'ticket.void'
  | 'ticket.inspection_exception'
  | 'ticket.repark'
  | 'ticket.custody_transfer'
  | 'ticket.manual_reconcile'
  | 'wa.link'
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
  | 'venue.manage'
  | 'venue.layout_read'
  | 'driver.read'
  | 'driver.manage'
  | 'driver.transfer'
  | 'duty.force_end'
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
  | 'staff.manage'
  | 'settlement.read'
  | 'settlement.dispute';

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
  | 'changePhone'
  | 'relinkWhatsApp'
  | 'onBehalf'
  | 'voidTicket'
  | 'inspectionException'
  | 'manualReconcile'
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
  // «تغيير الجوال» — an open WhatsApp ticket after the intake (a draft is edited by PATCH /intake; DEC-211)
  if (can(me, 'ticket.change_phone') && open && t.status !== 'received' && t.channel === 'whatsapp')
    out.push('changePhone');
  if (can(me, 'wa.link') && relinkable(t)) out.push('relinkWhatsApp');
  if (can(me, 'retrieval.request_on_behalf') && t.status === 'parked' && !t.active_cycle)
    out.push('onBehalf');
  if (can(me, 'ticket.void') && (t.status === 'received' || t.status === 'parking')) out.push('voidTicket');
  if (can(me, 'ticket.inspection_exception') && t.inspection_status === 'incomplete')
    out.push('inspectionException');
  if (can(me, 'ticket.manual_reconcile') && open && reconcileTargets(t).length) out.push('manualReconcile');
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

/**
 * How S-03 «إعادة الربط بواتساب» can re-link this ticket (02 S-03, D-07; 07 `linkWhatsApp`, DEC-193 … DEC-198):
 * - `direct` — W-01 again to the recorded number (`none` / `failed` after the intake; a number not opted out);
 * - `qr` — a link code the customer sends himself (`received` / `parking` / `parked`; also after an opt-out,
 *   the only way back, 12 §7.6);
 * - `confirm` — a QR message waits for «هل هو جوال العميل الذي أمامك؟» (venue supervisors may answer, DEC-198).
 * The server stays the judge (consent, channel health, template).
 */
export function relinkMethods(t: TicketDetail): { direct: boolean; qr: boolean; confirm: boolean } {
  if (!isOpenTicket(t) || t.channel !== 'whatsapp') return { direct: false, qr: false, confirm: false };
  const optedOut = t.wa_link_status === 'opted_out' || !!t.customer?.opted_out;
  return {
    direct:
      t.status !== 'received' &&
      (t.wa_link_status === 'none' || t.wa_link_status === 'failed') &&
      !!t.customer?.phone_masked &&
      !optedOut,
    qr:
      ['received', 'parking', 'parked'].includes(t.status) &&
      ['none', 'failed', 'opted_out'].includes(t.wa_link_status),
    confirm: t.wa_link_status === 'pending_confirmation' && !!t.wa_link_pending,
  };
}

const relinkable = (t: TicketDetail) => {
  const m = relinkMethods(t);
  return m.direct || m.qr || m.confirm;
};

/**
 * The true states S-03 «مطابقة يدوية بعد انقطاع» may set (07 `manualReconcile`, DEC-252, DEC-253): a paper ticket
 * without its stub number only to `voided` (`paper_serial_missing`); a recorded payment forbids `voided`
 * (`payment_recorded`, 13 §8.6). Any open ticket, `parked` → `parked` included (a correction).
 */
export function reconcileTargets(
  t: Pick<TicketDetail, 'status' | 'channel' | 'paper_serial' | 'payment' | 'payment_status'>,
): Array<'parked' | 'delivered' | 'voided'> {
  if (!isOpenTicket(t)) return [];
  const recorded = t.payment?.status === 'recorded' || t.payment_status === 'collected';
  const noStub = t.channel === 'paper' && !t.paper_serial;
  const out: Array<'parked' | 'delivered' | 'voided'> = noStub ? [] : ['parked', 'delivered'];
  if (!recorded) out.push('voided');
  return out;
}

/**
 * The new holders S-03 offers for an official custody transfer (DEC-250, DEC-328): the key to an on-duty driver,
 * the supervisor himself or a free key slot; a moving vehicle to a driver, the supervisor or a free spot; a
 * `parked` vehicle only to a free spot (the server refuses anything but a spot or `unknown` for it,
 * `parked_vehicle_spot_or_unknown`). `customer` and `unknown` are never offered (handover, reconcile).
 */
export function custodyTransferHolders(
  subject: CustodySubject,
  ticket: Pick<TicketDetail, 'status'>,
): Array<Exclude<CustodyHolderType, 'customer' | 'unknown'>> {
  if (subject === 'key') return ['driver', 'supervisor', 'key_slot'];
  return ticket.status === 'parked' ? ['spot'] : ['driver', 'supervisor', 'spot'];
}

/** Admin area sections (02 §2.2 table, 02 S-13) — read permission per section. */
export type AdminSection =
  | 'staff'
  | 'listing'
  | 'audit'
  | 'outbox'
  | 'channel'
  | 'templates'
  | 'retention'
  | 'org'
  | 'settlements'
  | 'subscription';

export const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSection; read: Permission }> = [
  // «الموظفون»: the administration manages supervisors, the owner everyone (02 §2.2, canon §10 staff.manage)
  { id: 'staff', read: 'staff.manage' },
  // «ملف الموقع العام» (V2-004, O-04): owner and admin edit and submit their venues' public profile
  { id: 'listing', read: 'venue.manage' },
  { id: 'channel', read: 'wa.channel_read' },
  { id: 'templates', read: 'wa.channel_read' },
  { id: 'outbox', read: 'outbox.manage' },
  { id: 'audit', read: 'audit.read' },
  { id: 'retention', read: 'audit.read' },
  { id: 'org', read: 'org.settings_manage' },
  // V2-041 / V2-042 (O-05 / O-06): the owner and the administration read their statements and system subscription
  { id: 'settlements', read: 'settlement.read' },
  { id: 'subscription', read: 'settlement.read' },
];

export const adminSectionsFor = (me: Pick<Me, 'permissions'>): AdminSection[] =>
  ADMIN_SECTIONS.filter((s) => can(me, s.read)).map((s) => s.id);
