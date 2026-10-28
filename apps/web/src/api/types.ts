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
    /**
     * The `devices` row this sign-in linked (09 §9.5) — needed by `POST /v1/me/audio-test` and
     * `PUT /v1/me/devices/{deviceId}`. Proposed in docs/progress/notes/pnt-035.md (not in 07 yet): without
     * it the app keeps the D-03 checks on the device only.
     */
    device_id?: string | null;
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

// ---------------------------------------------------------------- tickets, tasks, offers (07 §2.1–§2.3)

export type TicketChannel = 'whatsapp' | 'paper';
export type WaLinkStatus =
  'none' | 'pending_send' | 'pending_confirmation' | 'linked' | 'failed' | 'opted_out';
export type InspectionStatus = 'pending' | 'complete' | 'incomplete' | 'exception_approved';
export type PaymentStatus = 'not_required' | 'due' | 'collected' | 'waived';
export type TaskType = 'park' | 'retrieve' | 'repark';
export type TaskStatus =
  | 'queued'
  | 'offered'
  | 'broadcast'
  | 'assigned_waiting'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'canceled';
export type OfferMode = 'single' | 'broadcast';
export type OfferEligibility = 'accept' | 'reserve_next' | 'view_only';
export type MediaUploadStatus = 'pending' | 'uploaded' | 'failed' | 'deleted';
export type MediaContentType = 'image/jpeg' | 'image/webp' | 'image/heic' | 'image/png';
export type WaHealthStatus = 'healthy' | 'degraded' | 'down';
export type HolderType = 'customer' | 'driver' | 'spot' | 'key_slot' | 'supervisor' | 'unknown';

export interface Plate {
  country: string;
  digits?: string | null;
  letters_ar?: string | null;
  letters_en?: string | null;
  raw?: string | null;
  display: string;
}

/** `PlateInput` body: SA = digits + letters_ar; any other country = raw (PLATE_INVALID otherwise). */
export interface PlateBody {
  country: string;
  digits?: string;
  letters_ar?: string;
  letters_en?: string;
  raw?: string;
}

export interface VehicleInfo {
  make?: string | null;
  model?: string | null;
  color?: string | null;
  type?: 'sedan' | 'suv' | 'pickup' | 'van' | 'other' | null;
}

export interface ConsentInput {
  method: 'verbal_staff_confirmed';
  confirmed: true;
}

export interface HolderRef {
  type: HolderType;
  id?: string | null;
  label?: string | null;
}

export interface Media {
  id: string;
  ticket_id: string;
  kind: MediaKind;
  content_type: MediaContentType;
  byte_size?: number | null;
  upload_status: MediaUploadStatus;
  captured_at?: string | null;
  uploaded_at?: string | null;
  uploaded_by?: string;
}

/** A presigned PUT to the private object storage (07 §2.2). */
export interface UploadInstruction {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface ClaimCodeState {
  issued_at: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  attempts_left: number;
  locked_at?: string | null;
  consumed_at?: string | null;
  revoked_at?: string | null;
  resend_no: number;
  resends_left?: number;
  sent_status?: string | null;
}

export interface Payment {
  id: string;
  ticket_id: string;
  method: PaymentMethod;
  amount_halalas: number;
  currency: 'SAR';
  pos_reference?: string | null;
  collected_by: UserRef;
  collected_at: string;
  status: 'recorded' | 'reversed';
}

export interface RetrievalCycle {
  id: string;
  ticket_id: string;
  cycle_no: number;
  requested_at: string;
  request_source: 'whatsapp' | 'staff';
  requested_early: boolean;
  accepted_by?: string | null;
  started_at?: string | null;
  ready_at?: string | null;
  delivered_at?: string | null;
  retrieved_by?: string | null;
  delivered_by?: string | null;
  outcome?: 'delivered' | 'canceled' | 'reparked' | null;
  closed_at?: string | null;
}

export interface Task {
  id: string;
  ticket_id: string;
  cycle_id?: string | null;
  event_id?: string;
  venue_id?: string;
  dispatch_pool_id?: string;
  type: TaskType;
  status: TaskStatus;
  priority_at: string;
  seq: number;
  assignee?: UserRef | null;
  claimed_at?: string | null;
  accepted_at?: string | null;
  key_picked_up_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  version: number;
}

/** Minimal projection (`ticket.read_minimal`). */
export interface TicketSummary {
  id: string;
  display_number: number;
  event_id: string;
  event_name_ar?: string;
  venue_id: string;
  venue_name_ar?: string;
  status: TicketStatus;
  channel: TicketChannel;
  plate: Plate;
  vehicle?: { make?: string | null; color?: string | null };
  wa_link_status: WaLinkStatus;
  payment_status: PaymentStatus;
  requested_at?: string | null;
  created_at?: string;
  version: number;
}

/** Full projection for the creator during intake, the assignee of an open task, and staff (07 §1.10). */
export interface TicketDetail extends TicketSummary {
  projection: 'minimal' | 'full';
  vehicle_detail?: VehicleInfo;
  customer?: {
    phone_masked?: string | null;
    consent?: { method: string; captured_at: string; revoked_at?: string | null } | null;
    opted_out?: boolean;
  } | null;
  wa_link_pending?: { link_code_id: string; inbound_phone_masked: string; received_at: string } | null;
  paper_serial?: string | null;
  key_tag?: string | null;
  inspection_status?: InspectionStatus;
  notes?: string | null;
  current_spot?: { id: string; label: string; zone_name: string } | null;
  current_spot_note?: string | null;
  current_key_slot?: { id: string; label: string; board_name: string } | null;
  vehicle_holder?: HolderRef;
  key_holder?: HolderRef;
  pending_retrieval_at?: string | null;
  active_cycle?: RetrievalCycle | null;
  open_task?: Task | null;
  fee_halalas?: number;
  payment?: Payment | null;
  claim_code?: ClaimCodeState | null;
  media?: Media[];
  created_by?: UserRef;
  parked_by?: UserRef | null;
  retrieved_by?: UserRef | null;
  delivered_by?: UserRef | null;
  submitted_at?: string | null;
  parked_at?: string | null;
  delivered_at?: string | null;
}

/** The driver's current or next task (D-04 / D-10). `parking` and `key_slot` are for the assignee only. */
export interface TaskCard {
  task: Task;
  ticket: {
    id: string;
    display_number: number;
    event_name_ar?: string;
    plate?: Plate;
    vehicle?: VehicleInfo;
    status: TicketStatus;
    version: number;
  };
  parking?: { spot_label?: string | null; zone_name?: string | null; spot_note?: string | null } | null;
  key_slot?: { id: string; board_name: string; label: string } | null;
  requested_at?: string | null;
  waiting_seconds?: number | null;
  payment_due?: { amount_halalas: number; allowed_methods: PaymentMethod[] } | null;
  claim_code?: ClaimCodeState | null;
}

/** The single offer card shown to the driver: the oldest actionable request (D-09). */
export interface OfferCard {
  offer_id: string;
  task_id: string;
  mode: OfferMode;
  eligible_as: OfferEligibility;
  expires_at?: string | null;
  reminder_at?: string | null;
  server_time: string;
  ticket: {
    display_number: number;
    event_name_ar?: string;
    plate?: Plate;
    vehicle?: { make?: string | null; color?: string | null };
  };
  requested_at: string;
  waiting_seconds: number;
  can_accept: boolean;
  can_reserve_next: boolean;
  safety_note_ar?: string | null;
}

/** `GET /v1/me/home` — the driver's full sync source (02 §1.7). */
export interface DriverHome {
  server_time: string;
  user: UserRef;
  venue?: { id: string; code: string; name_ar: string } | null;
  open_events: Array<{ id: string; name_ar: string; status: EventStatus }>;
  active_assignment?: DriverAssignment | null;
  shift_open: boolean;
  /**
   * Proposed (docs/progress/notes/pnt-035.md): the pool's shift, for D-03 «الوردية: مفتوحة منذ 6:30 م»;
   * without it D-03 shows «الوردية: مفتوحة».
   */
  shift?: { id: string; status: ShiftStatus; opened_at?: string | null } | null;
  /**
   * Proposed (pnt-035.md): the venue settings a driver screen needs but cannot read (`venue.read` is not a
   * driver permission): D-06 photos, D-08 parking rules, the D-09 ring. Defaults apply when absent.
   */
  settings?: {
    inspection?: { required_photos?: MediaKind[]; max_extra_photos?: number };
    parking?: { mode?: ParkingMode };
    keys?: { require_slot?: boolean };
    dispatch?: { single_offer_ttl_s?: number };
  } | null;
  duty_session?: DutySession | null;
  driver_state: DriverState;
  connection_state?: ConnectionState | null;
  current_task?: TaskCard | null;
  next_task?: TaskCard | null;
  offer?: OfferCard | null;
  draft_ticket_id?: string | null;
  cash_outstanding_halalas?: number;
  checks: { audio_tested?: boolean; push_enabled?: boolean; pwa_installed?: boolean };
  channel_health: WaHealthStatus;
}

export interface DriverStateResult {
  driver_state: DriverState;
  promoted_next_task?: TaskCard | null;
}

export type AudioTestResult = 'heard' | 'not_heard' | 'blocked';
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';
export type DisplayMode = 'browser' | 'standalone';
export type DevicePlatform = 'ios' | 'android' | 'desktop' | 'other';

export interface Device {
  id: string;
  label?: string | null;
  platform: DevicePlatform;
  display_mode: DisplayMode;
  notification_permission: NotificationPermissionState;
  push_subscribed: boolean;
  audio_tested_at?: string | null;
  audio_test_result?: AudioTestResult | null;
  last_seen_at?: string | null;
  created_at?: string;
}

/** A short-lived signed GET for a private photo (≤ 300 s, 07 §1.10); kept in memory only (02 §1.11). */
export interface SignedUrl {
  url: string;
  expires_at: string;
}

export interface StartDutyResult {
  duty_session: DutySession;
  driver_state: DriverState;
  checks: { audio_tested?: boolean; push_enabled?: boolean };
}

/** `POST /v1/tickets`: the draft ticket and its park task, created atomically (07 §2.2). */
export interface CreateTicketResult {
  ticket: TicketDetail;
  task: Task;
  driver_state: DriverState;
}

export interface MediaUploadResult {
  media: Media;
  upload: UploadInstruction;
}

export interface CompleteParkingResult {
  ticket: TicketDetail;
  task: Task;
  driver: DriverStateResult;
}

export interface AcceptOfferResult {
  result: 'accepted' | 'assigned_waiting';
  task: Task;
  ticket: TicketSummary;
  driver_state: DriverState;
}

export interface HandoverResult {
  ticket: TicketDetail;
  cycle: RetrievalCycle;
  payment?: Payment | null;
  driver: DriverStateResult;
}
