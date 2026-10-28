/**
 * In-memory records of the fake backend (e2e only). Field names follow docs/06_schema.sql / 07_openapi.yaml
 * so the views in ./views.ts are thin. Nothing here is product code.
 */
export type Role = 'owner' | 'admin' | 'supervisor' | 'driver';
export type SetupStatus = 'active' | 'inactive';

export interface FUser {
  id: string;
  key?: string;
  role: Role;
  employee_code: string;
  full_name: string;
  phone_e164: string;
  secret: string;
  can_drive: boolean;
  status: 'active' | 'disabled';
  must_change_secret: boolean;
  disabled_reason: string | null;
  disabled_at: string | null;
  /** 'org' or venue ids (role_scopes). */
  scopes: Array<'org' | string>;
  version: number;
  created_at: string;
}

export interface FAssignment {
  id: string;
  driver_id: string;
  venue_id: string;
  status: 'scheduled' | 'active' | 'ended';
  starts_at: string;
  ends_at: string | null;
  reason: string | null;
}

export interface FVenue {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  address: string | null;
  city: string | null;
  timezone: string;
  status: SetupStatus;
  default_dispatch_pool_id: string;
  version: number;
  settings: Record<string, Record<string, unknown>>;
  settings_version: number;
  created_at: string;
}

export interface FPool {
  id: string;
  venue_id: string;
  name: string;
  is_default: boolean;
  status: SetupStatus;
  created_at: string;
}

export interface FZone {
  id: string;
  venue_id: string;
  name: string;
  sort_order: number;
  status: SetupStatus;
}

export interface FSpot {
  id: string;
  venue_id: string;
  zone_id: string;
  label: string;
  status: SetupStatus;
  /** Ticket holding an active spot allocation. */
  ticket_id: string | null;
}

export interface FBoard {
  id: string;
  venue_id: string;
  name: string;
  status: SetupStatus;
}

export interface FSlot {
  id: string;
  venue_id: string;
  key_board_id: string;
  label: string;
  status: SetupStatus;
  ticket_id: string | null;
}

export interface FEvent {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  host_name: string | null;
  event_date: string;
  starts_at: string | null;
  ends_at: string | null;
  status: 'draft' | 'open' | 'closing' | 'closed' | 'canceled';
  pricing_mode: 'included' | 'per_vehicle';
  fee_halalas: number;
  allowed_payment_methods: Array<'cash' | 'pos'>;
  opened_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  next_display_number: number;
  version: number;
  created_at: string;
}

export interface FShift {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name: string | null;
  starts_at: string;
  ends_at: string | null;
  status: 'scheduled' | 'open' | 'closed';
  opened_at: string | null;
  closed_at: string | null;
  version: number;
}

export interface FDuty {
  id: string;
  user_id: string;
  shift_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  status: 'on_duty' | 'on_break' | 'ended';
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  available_since: string | null;
  version: number;
}

export interface FMedia {
  id: string;
  ticket_id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  sha256: string | null;
  upload_status: 'pending' | 'uploaded' | 'failed' | 'deleted';
  received_bytes: number | null;
  captured_at: string | null;
  uploaded_at: string | null;
  uploaded_by: string;
}

export interface FTicket {
  id: string;
  display_number: number;
  event_id: string;
  venue_id: string;
  status:
    | 'received'
    | 'parking'
    | 'parked'
    | 'requested'
    | 'assigned'
    | 'assigned_waiting'
    | 'retrieving'
    | 'ready'
    | 'delivered'
    | 'reparking'
    | 'voided';
  channel: 'whatsapp' | 'paper';
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  customer_phone: string | null;
  consent: boolean;
  wa_link_status: 'none' | 'pending_send' | 'pending_confirmation' | 'linked' | 'failed' | 'opted_out';
  paper_serial: string | null;
  key_tag: string | null;
  notes: string | null;
  inspection_status: 'pending' | 'complete' | 'incomplete' | 'exception_approved';
  payment_status: 'not_required' | 'due' | 'collected' | 'waived';
  fee_halalas: number;
  spot_id: string | null;
  spot_note: string | null;
  key_slot_id: string | null;
  vehicle_holder: { type: string; id: string | null };
  key_holder: { type: string; id: string | null };
  created_by: string;
  parked_by: string | null;
  retrieved_by: string | null;
  delivered_by: string | null;
  submitted_at: string | null;
  parked_at: string | null;
  delivered_at: string | null;
  version: number;
  created_at: string;
}

export interface FCycle {
  id: string;
  ticket_id: string;
  cycle_no: number;
  requested_at: string;
  request_source: 'whatsapp' | 'staff';
  request_reason: string | null;
  accepted_by: string | null;
  retrieved_by: string | null;
  delivered_by: string | null;
  started_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  outcome: 'delivered' | 'canceled' | 'reparked' | null;
  closed_at: string | null;
}

export interface FTask {
  id: string;
  ticket_id: string;
  cycle_id: string | null;
  event_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  type: 'park' | 'retrieve' | 'repark';
  status:
    | 'queued'
    | 'offered'
    | 'broadcast'
    | 'assigned_waiting'
    | 'accepted'
    | 'in_progress'
    | 'completed'
    | 'canceled';
  priority_at: string;
  seq: number;
  assignee_id: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  key_picked_up_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  version: number;
}

export interface FOffer {
  id: string;
  task_id: string;
  mode: 'single' | 'broadcast';
  status: 'active' | 'accepted' | 'expired' | 'revoked';
  recipients: string[];
  created_at: string;
  expires_at: string | null;
  version: number;
}

export interface FPayment {
  id: string;
  ticket_id: string;
  method: 'cash' | 'pos';
  amount_halalas: number;
  pos_reference: string | null;
  collected_by: string;
  collected_at: string;
}

export interface FCustodyEvent {
  ticket_id: string;
  subject: 'vehicle' | 'key';
  from: { type: string; id: string | null };
  to: { type: string; id: string | null };
  reason: string;
  actor_id: string;
  task_id: string | null;
}

export interface World {
  users: FUser[];
  assignments: FAssignment[];
  venues: FVenue[];
  pools: FPool[];
  zones: FZone[];
  spots: FSpot[];
  boards: FBoard[];
  slots: FSlot[];
  events: FEvent[];
  shifts: FShift[];
  duties: FDuty[];
  tickets: FTicket[];
  cycles: FCycle[];
  tasks: FTask[];
  offers: FOffer[];
  media: FMedia[];
  payments: FPayment[];
  custody: FCustodyEvent[];
}
