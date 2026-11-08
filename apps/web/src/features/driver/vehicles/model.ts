import type { Me, TicketDetail, TicketStatus } from '@/api/types';
import { onlyDigits } from '@/lib/digits';
import { canRelink } from '../linkModel';

/** The D-12 chips (02 D-12 «ربط الفلاتر بالحالات»); `all` sends no status filter. */
export type VehicleFilter = 'all' | 'parked' | 'requested' | 'retrieving' | 'ready' | 'intake';

export const FILTER_STATUSES: Record<VehicleFilter, readonly TicketStatus[]> = {
  all: [],
  parked: ['parked'],
  requested: ['requested', 'assigned', 'assigned_waiting'],
  retrieving: ['retrieving'],
  ready: ['ready'],
  intake: ['received', 'parking', 'reparking'],
};

export const VEHICLE_FILTERS = Object.keys(FILTER_STATUSES) as VehicleFilter[];

/** 07 `listTickets.q` (max 20): digits only — plate digits or the ticket number (02 D-12); ٠–٩ normalised. */
export function searchDigits(text: string): string {
  return onlyDigits(text).slice(0, 20);
}

/** The single-choice chips on top of the multi-select FilterChips: a second tap on a chip goes back to «الكل». */
export function nextFilter(current: VehicleFilter, selected: readonly string[]): VehicleFilter {
  const added = selected.find((v) => v !== current);
  return (added as VehicleFilter | undefined) ?? 'all';
}

const hasPermission = (me: Me, permission: string) => me.permissions.includes(permission);

/** The task of an open retrieval before any driver took it (the driver may cancel only then — 07). */
export function unassignedRetrieval(ticket: TicketDetail): { cycleId: string } | null {
  const task = ticket.open_task;
  if (ticket.status !== 'requested' || !task || task.type !== 'retrieve') return null;
  if (!['queued', 'offered', 'broadcast'].includes(task.status)) return null;
  const cycleId = task.cycle_id ?? ticket.active_cycle?.id ?? null;
  return cycleId ? { cycleId } : null;
}

/**
 * What D-13 offers this viewer (02 D-13; the server decides again on every command):
 * - «طلب الإحضار نيابة عن العميل» on a parked ticket (`retrieval.request_on_behalf`);
 * - «إلغاء طلب الإحضار» while the request is not assigned (`retrieval.cancel`);
 * - «تغيير رقم الجوال» for the creator or the assignee (the full projection) of a WhatsApp ticket after the
 *   intake (07: the draft's number is edited in D-05, a paper ticket has no conversation to move);
 * - «إعادة الربط بواتساب» on a WhatsApp ticket after the intake whose link is `none` or `failed` (`wa.link`),
 *   when D-07 can act on it (a QR until parked, or the resend to a number on record): it opens D-07 (02 D-13);
 * - «إبلاغ عن واقعة» always (`incident.create`).
 */
export function vehicleActions(me: Me, ticket: TicketDetail) {
  const open = ticket.status !== 'delivered' && ticket.status !== 'voided';
  return {
    relink:
      open &&
      ticket.channel === 'whatsapp' &&
      ticket.status !== 'received' &&
      canRelink(ticket) &&
      hasPermission(me, 'wa.link'),
    onBehalf: open && ticket.status === 'parked' && hasPermission(me, 'retrieval.request_on_behalf'),
    cancel:
      open && !!unassignedRetrieval(ticket) && hasPermission(me, 'retrieval.cancel')
        ? (unassignedRetrieval(ticket) as { cycleId: string })
        : null,
    changePhone:
      open &&
      ticket.projection === 'full' &&
      ticket.channel === 'whatsapp' &&
      ticket.status !== 'received' &&
      hasPermission(me, 'ticket.change_phone'),
    report: open && hasPermission(me, 'incident.create'),
  };
}

/** The 02 D-13 rows a minimal projection never has (09 §5.1): spot, key slot, photos, masked phone. */
export function restrictedRows(ticket: TicketDetail) {
  const full = ticket.projection === 'full';
  return {
    spot: full ? (ticket.current_spot?.label ?? ticket.current_spot_note ?? null) : null,
    keySlot: full ? (ticket.current_key_slot?.label ?? null) : null,
    phone: full ? (ticket.customer?.phone_masked ?? null) : null,
    photos: full ? (ticket.media ?? []).filter((m) => m.upload_status === 'uploaded') : [],
  };
}
