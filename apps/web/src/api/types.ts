/**
 * Wire types used by the web app, from docs/07_openapi.yaml (components.schemas). Kept local until
 * @point/shared publishes the zod wire schemas (05 §3); field names follow the contract exactly.
 */
export type Role = 'owner' | 'admin' | 'supervisor' | 'driver';
export type DriverState =
  'off_duty' | 'on_break' | 'available' | 'intake_parking' | 'retrieving' | 'busy_with_next';
export type ConnectionState = 'online' | 'uncertain' | 'offline';
export type TicketStatus =
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
export type DutyStatus = 'on_duty' | 'on_break' | 'ended';
/** auth_sessions.revoked_reason (canon §5.7) as carried by `AUTH_SESSION_REVOKED` / `session.revoked`. */
export type RevokedReason =
  'logout' | 'transfer' | 'disabled' | 'secret_reset' | 'admin' | 'expired' | 'expired_cleanup';

export interface Meta {
  request_id: string;
  server_time: string;
  replayed?: boolean;
  next_cursor?: string | null;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export interface FieldError {
  field: string;
  issue: string;
  message_ar?: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  message_ar: string;
  request_id: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export type UserStatus = 'active' | 'disabled';
/** Status of setup items: venues, dispatch pools, parking zones and spots, key boards and slots. */
export type SetupStatus = 'active' | 'inactive';
export type EventStatus = 'draft' | 'open' | 'closing' | 'closed' | 'canceled';
export type ShiftStatus = 'scheduled' | 'open' | 'closed';
export type PricingMode = 'included' | 'per_vehicle';
export type PaymentMethod = 'cash' | 'pos';
export type ParkingMode = 'assigned_spots' | 'free_text' | 'mixed';
export type MediaKind =
  'photo_front' | 'photo_rear' | 'photo_left' | 'photo_right' | 'photo_extra' | 'photo_damage';
export type AssignmentStatus = 'scheduled' | 'active' | 'ended';
export type TransferStatus = 'pending' | 'blocked' | 'completed' | 'canceled';

export interface User {
  id: string;
  employee_code: string;
  full_name: string;
  /** Shown to the account holder and the administration; masked for everyone else. */
  phone_e164?: string | null;
  phone_masked?: string;
  role: Role;
  can_drive?: boolean;
  status: UserStatus;
  mfa_enabled?: boolean;
  must_change_secret?: boolean;
  last_login_at?: string | null;
  disabled_at?: string | null;
  disabled_reason?: string | null;
  version: number;
  created_at?: string;
}

export interface UserRef {
  id: string;
  full_name: string;
  employee_code?: string;
}

export interface RoleScope {
  id: string;
  scope_type: 'org' | 'venue';
  venue_id: string | null;
  granted_at?: string;
}

export interface DriverAssignment {
  id: string;
  driver_id: string;
  venue_id: string;
  venue_name_ar?: string;
  status: AssignmentStatus;
  starts_at: string;
  ends_at?: string | null;
  reason?: string | null;
  transfer_id?: string | null;
}

export interface DutySession {
  id: string;
  user_id: string;
  shift_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  status: DutyStatus;
  started_at: string;
  ended_at?: string | null;
  available_since?: string | null;
  connection_state: ConnectionState;
  version: number;
}

export interface Me {
  user: User;
  permissions: string[];
  scopes: RoleScope[];
  active_assignment?: DriverAssignment | null;
  duty_session?: DutySession | null;
  driver_state?: DriverState | null;
  session: {
    expires_at?: string;
    mfa_verified?: boolean;
    /** true while the session is limited to `auth.self` (secret change and/or MFA setup pending). */
    restricted?: boolean;
    /** What the restricted session must still do, in order (DEC-82); empty when not restricted. */
    pending?: ('secret_change' | 'mfa_setup')[];
  };
  brand: {
    staff_name_ar?: string;
    staff_name_en?: string;
    customer_name_ar?: string;
  };
  heartbeat?: {
    interval_s?: number;
    uncertain_after_s?: number;
    offline_after_s?: number;
  };
}

export interface LoginRequest {
  phone: string;
  secret: string;
  device_label?: string;
}

export interface LoginResult {
  mfa_required: boolean;
  mfa_token?: string | null;
  mfa_setup_required: boolean;
  must_change_secret: boolean;
  me?: Me | null;
}

export interface MfaSetup {
  otpauth_uri: string;
  secret_base32: string;
}

// ---------------------------------------------------------------- venues, events, shifts (07 §2.5)

export interface Venue {
  id: string;
  code: string;
  name_ar: string;
  name_en?: string | null;
  address?: string | null;
  city?: string | null;
  timezone: string;
  status: SetupStatus;
  default_dispatch_pool_id?: string;
  version: number;
  created_at?: string;
}

/** `VenueSettings` — canon §12 dotted keys as nested objects; missing values take the defaults. */
export interface VenueSettings {
  dispatch?: {
    single_offer_reminder_s?: number;
    single_offer_ttl_s?: number;
    broadcast_reminder_s?: number;
    unaccepted_escalation_s?: number;
    next_task_wait_alert_s?: number;
    idle_driver_alert?: boolean;
    accept_grace_ms?: number;
    offline_drivers_last?: boolean;
  };
  intake?: { draft_abandoned_alert_min?: number };
  handover?: { code_ttl_min?: number; max_attempts?: number; max_resends?: number };
  ready?: { uncollected_alert_min?: number };
  inspection?: { required_photos?: MediaKind[]; max_extra_photos?: number };
  link?: { qr_ttl_min?: number };
  parking?: { mode?: ParkingMode };
  keys?: { require_slot?: boolean };
  pricing?: {
    default_mode?: PricingMode;
    default_fee_halalas?: number;
    allowed_methods?: PaymentMethod[];
  };
}

export interface VenueSettingsResult {
  settings: VenueSettings;
  version: number;
}

export interface DispatchPool {
  id: string;
  venue_id: string;
  name: string;
  is_default: boolean;
  status: SetupStatus;
  created_at?: string;
}

export interface ParkingZone {
  id: string;
  venue_id: string;
  name: string;
  sort_order?: number;
  status: SetupStatus;
}

export interface ParkingSpot {
  id: string;
  venue_id?: string;
  zone_id: string;
  zone_name?: string;
  label: string;
  status: SetupStatus;
  /** An active allocation holds it (07: drivers see `occupied` without the ticket). */
  occupied?: boolean;
}

export interface KeyBoard {
  id: string;
  venue_id: string;
  name: string;
  status: SetupStatus;
}

export interface KeySlot {
  id: string;
  venue_id?: string;
  key_board_id: string;
  board_name?: string;
  label: string;
  status: SetupStatus;
  occupied?: boolean;
}

/** One entry of `GET /v1/venues/{venueId}/key-boards`. */
export interface KeyBoardWithSlots {
  board: KeyBoard;
  slots: KeySlot[];
}

/** Bulk creation body: `labels` or `range` (one of them). */
export interface BulkLabels {
  labels?: string[];
  range?: { prefix?: string; from: number; to: number };
}

/** The `events` table (`VenueEvent` in TypeScript to avoid the DOM `Event`). */
export interface VenueEvent {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  host_name?: string | null;
  /** Local date in Asia/Riyadh, `YYYY-MM-DD`. */
  event_date: string;
  starts_at?: string | null;
  ends_at?: string | null;
  status: EventStatus;
  pricing_mode: PricingMode;
  fee_halalas: number;
  allowed_payment_methods?: PaymentMethod[];
  opened_at?: string | null;
  closing_started_at?: string | null;
  closed_at?: string | null;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  version: number;
  created_at?: string;
}

export interface EventInput {
  name_ar: string;
  host_name?: string | null;
  event_date: string;
  starts_at?: string | null;
  ends_at?: string | null;
  dispatch_pool_id?: string;
  pricing_mode: PricingMode;
  fee_halalas: number;
  allowed_payment_methods: PaymentMethod[];
}

export interface Shift {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name?: string | null;
  starts_at: string;
  ends_at?: string | null;
  status: ShiftStatus;
  opened_at?: string | null;
  closed_at?: string | null;
  version: number;
}

export interface ShiftInput {
  name?: string | null;
  starts_at: string;
  ends_at?: string | null;
  dispatch_pool_id?: string;
}

// ---------------------------------------------------------------- drivers (07 §2.6)

export interface DriverLive {
  driver: UserRef;
  driver_state: DriverState;
  connection_state?: ConnectionState | null;
  last_heartbeat_at?: string | null;
  available_since?: string | null;
  active_task_id?: string | null;
  next_task_id?: string | null;
  duty_started_at?: string | null;
}

export interface DriverListItem {
  user: User;
  active_assignment?: DriverAssignment | null;
  live?: DriverLive | null;
}

export interface DriverTransfer {
  id: string;
  driver_id: string;
  from_venue_id?: string | null;
  to_venue_id: string;
  scheduled_at: string;
  status: TransferStatus;
  reason: string;
  completed_at?: string | null;
  canceled_at?: string | null;
  version: number;
}

export interface DriverAssignmentsResult {
  assignments: DriverAssignment[];
  transfers: DriverTransfer[];
}

/** `POST /v1/drivers` reply: the temporary PIN is shown once and never stored (07 §2.6). */
export interface CreatedDriver {
  driver: User;
  temporary_secret: string;
  assignment?: DriverAssignment | null;
}

/** `details.items` of CUSTODY_OPEN / DUTY_END_BLOCKED_CUSTODY / TRANSFER_BLOCKED_CUSTODY (08 §4). */
export interface CustodyItem {
  type: 'vehicle' | 'key' | 'task' | 'next_task' | 'draft' | string;
  ticket_id?: string;
  display_number?: number;
  holder_type?: string;
}

/** `details.blocking_drivers` of SHIFT_CLOSE_BLOCKED (08 §4). */
export interface BlockingDriver {
  driver: UserRef;
  items: CustodyItem[];
}
