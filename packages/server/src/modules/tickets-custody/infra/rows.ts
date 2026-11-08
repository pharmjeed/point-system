import type { TicketChannel, TicketEntitlement, TicketStatus } from '@point/shared';

/** `tickets` row (docs/06_schema.sql). */
export interface TicketRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  dispatch_pool_id: string;
  display_number: number;
  status: TicketStatus;
  channel: TicketChannel;
  customer_id: string | null;
  wa_link_status: 'none' | 'pending_send' | 'pending_confirmation' | 'linked' | 'failed' | 'opted_out';
  link_version: number;
  paper_serial: string | null;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_type: string | null;
  key_tag: string | null;
  inspection_status: 'pending' | 'complete' | 'incomplete' | 'exception_approved';
  notes: string | null;
  current_spot_id: string | null;
  current_spot_note: string | null;
  current_key_slot_id: string | null;
  vehicle_holder_type: 'customer' | 'driver' | 'spot' | 'supervisor' | 'unknown';
  vehicle_holder_id: string | null;
  key_holder_type: 'customer' | 'driver' | 'key_slot' | 'supervisor' | 'unknown';
  key_holder_id: string | null;
  pending_retrieval_at: Date | null;
  pending_retrieval_source: 'whatsapp' | 'app' | null;
  active_cycle_id: string | null;
  last_requested_at: Date | null;
  payment_status: 'not_required' | 'due' | 'collected' | 'waived';
  fee_halalas: number;
  payment_waived_at: Date | null;
  payment_waived_by: string | null;
  payment_waiver_reason: string | null;
  created_by: string;
  parked_by: string | null;
  retrieved_by: string | null;
  delivered_by: string | null;
  submitted_at: Date | null;
  parked_at: Date | null;
  delivered_at: Date | null;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  /** V2-014 (0010, DEC-502): the account vehicle an app intake copied, and the entitlement decided at intake */
  customer_vehicle_id: string | null;
  entitlement: TicketEntitlement;
  /** V2-033 (0016, DEC-535): the subscription that covered the visit at intake (`entitlement = subscription` only) */
  subscription_id: string | null;
}

/** `retrieval_cycles` row. */
export interface CycleRow {
  id: string;
  org_id: string;
  venue_id: string;
  ticket_id: string;
  cycle_no: number;
  requested_at: Date;
  request_source: 'whatsapp' | 'staff' | 'app';
  requested_by_user_id: string | null;
  requested_by_customer_id: string | null;
  request_reason: string | null;
  requested_early: boolean;
  assigned_at: Date | null;
  assigned_waiting_at: Date | null;
  accepted_by: string | null;
  started_at: Date | null;
  ready_at: Date | null;
  delivered_at: Date | null;
  canceled_at: Date | null;
  canceled_by: string | null;
  cancel_reason: string | null;
  reparked_at: Date | null;
  retrieved_by: string | null;
  delivered_by: string | null;
  handover_method: 'code' | 'paper_stub' | 'supervisor_exception' | 'manual_reconcile' | null;
  outcome: 'delivered' | 'canceled' | 'reparked' | null;
  closed_at: Date | null;
  created_at: Date;
}

export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
];

export const CLOSED_TICKET_STATUSES: readonly TicketStatus[] = ['delivered', 'voided'];

export const isClosedTicket = (s: TicketStatus) => s === 'delivered' || s === 'voided';
