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

export interface User {
  id: string;
  employee_code: string;
  full_name: string;
  phone_e164?: string | null;
  phone_masked?: string;
  role: Role;
  can_drive?: boolean;
  status: 'active' | 'disabled';
  mfa_enabled?: boolean;
  must_change_secret?: boolean;
  last_login_at?: string | null;
  version: number;
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
  status: 'scheduled' | 'active' | 'ended';
  starts_at: string;
  ends_at?: string | null;
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

// ================================================================== staff screens (S-02…S-13)
// Appended for the supervisor/admin/owner screens (PNT-074…PNT-092). Shapes from docs/07_openapi.yaml
// components.schemas, same names; `User` and `DriverAssignment` above are widened by declaration merging.

export interface User {
  disabled_at?: string | null;
  disabled_reason?: string | null;
  created_at?: string;
}

export interface DriverAssignment {
  reason?: string | null;
  transfer_id?: string | null;
}

export interface PageMeta extends Meta {
  next_cursor: string | null;
}

export interface UserRef {
  id: string;
  full_name: string;
  employee_code?: string;
}

export type TicketChannel = 'whatsapp' | 'paper';
export type WaLinkStatus =
  'none' | 'pending_send' | 'pending_confirmation' | 'linked' | 'failed' | 'opted_out';
export type PaymentStatus = 'not_required' | 'due' | 'collected' | 'waived';
export type PaymentMethod = 'cash' | 'pos';
export type PaymentRecordStatus = 'recorded' | 'reversed';
export type InspectionStatus = 'pending' | 'complete' | 'incomplete' | 'exception_approved';
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
export type RequestSource = 'whatsapp' | 'staff';
export type CycleOutcome = 'delivered' | 'canceled' | 'reparked';
export type CustodySubject = 'vehicle' | 'key';
export type CustodyHolderType = 'customer' | 'driver' | 'spot' | 'key_slot' | 'supervisor' | 'unknown';
export type CustodyReason =
  | 'intake'
  | 'parked'
  | 'key_deposited'
  | 'key_pickup'
  | 'retrieval_start'
  | 'handover'
  | 'repark'
  | 'official_transfer'
  | 'withdrawal_release'
  | 'manual_reconcile'
  | 'correction';
export type MediaKind =
  'photo_front' | 'photo_rear' | 'photo_left' | 'photo_right' | 'photo_extra' | 'photo_damage';
export type MediaContentType = 'image/jpeg' | 'image/webp' | 'image/heic' | 'image/png';
export type MediaUploadStatus = 'pending' | 'uploaded' | 'failed' | 'deleted';
export type ActorType = 'user' | 'customer' | 'system';
export type VehicleType = 'sedan' | 'suv' | 'pickup' | 'van' | 'other';
export type ConsentMethod = 'verbal_staff_confirmed' | 'customer_initiated';
export type WaDirection = 'outbound' | 'inbound';
export type WaMessageKind =
  'template' | 'session_text' | 'inbound_text' | 'inbound_button' | 'inbound_interactive' | 'inbound_other';
export type WaMessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'received';
export type WaHealthStatus = 'healthy' | 'degraded' | 'down';
export type AlertType =
  | 'no_drivers_on_duty'
  | 'request_unaccepted'
  | 'next_task_waiting_long'
  | 'idle_driver_while_next_waiting'
  | 'ready_not_collected'
  | 'wa_send_failed'
  | 'wa_channel_down'
  | 'driver_connection_lost_with_custody'
  | 'handover_code_locked'
  | 'inspection_incomplete'
  | 'draft_abandoned'
  | 'transfer_blocked'
  | 'outbox_lag'
  | 'push_failed_repeatedly'
  | 'task_stuck'
  | 'wa_webhook_silent';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentType =
  | 'key_missing'
  | 'vehicle_damage'
  | 'customer_absent'
  | 'manual_verification'
  | 'lost_ticket'
  | 'payment_discrepancy'
  | 'inspection_incomplete'
  | 'wrong_vehicle'
  | 'custody_mismatch'
  | 'other';
export type IncidentStatus = 'open' | 'in_review' | 'resolved' | 'closed';
export type IncidentSeverity = 'low' | 'medium' | 'high';
export type EventStatus = 'draft' | 'open' | 'closing' | 'closed' | 'canceled';
export type PricingMode = 'included' | 'per_vehicle';
export type SetupStatus = 'active' | 'inactive';
export type TransferStatus = 'pending' | 'blocked' | 'completed' | 'canceled';
export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead' | 'canceled';
export type WaChannelMode = 'live' | 'simulator';
export type WaTemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
export type WaTemplateStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
export type ExportKind = 'event_summary' | 'tickets' | 'payments' | 'drivers' | 'messages' | 'audit';
export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';
export type PaymentIntegrityCheck =
  'collected_without_payment' | 'payment_without_collected' | 'amount_mismatch' | 'snapshot_inconsistent';

export interface Plate {
  country: string;
  digits?: string | null;
  letters_ar?: string | null;
  letters_en?: string | null;
  raw?: string | null;
  display: string;
}

export interface VehicleInfo {
  make?: string | null;
  model?: string | null;
  color?: string | null;
  type?: VehicleType | null;
}

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

export interface HolderRef {
  type: CustodyHolderType;
  id?: string | null;
  label?: string | null;
}

export interface ConsentInfo {
  method: ConsentMethod;
  captured_at: string;
  revoked_at?: string | null;
}

export interface RetrievalCycle {
  id: string;
  ticket_id: string;
  cycle_no: number;
  requested_at: string;
  request_source: RequestSource;
  requested_early: boolean;
  request_reason?: string | null;
  assigned_at?: string | null;
  assigned_waiting_at?: string | null;
  accepted_by?: string | null;
  started_at?: string | null;
  ready_at?: string | null;
  delivered_at?: string | null;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  reparked_at?: string | null;
  retrieved_by?: string | null;
  delivered_by?: string | null;
  outcome?: CycleOutcome | null;
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
  queued_at?: string | null;
  first_offered_at?: string | null;
  broadcast_at?: string | null;
  claimed_at?: string | null;
  assigned_waiting_at?: string | null;
  accepted_at?: string | null;
  key_picked_up_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  escalated_at?: string | null;
  version: number;
}

export interface Payment {
  id: string;
  ticket_id: string;
  cycle_id?: string | null;
  event_id: string;
  method: PaymentMethod;
  amount_halalas: number;
  currency: 'SAR';
  pos_reference?: string | null;
  collected_by: UserRef;
  collected_at: string;
  status: PaymentRecordStatus;
  reversed_at?: string | null;
  reversed_by?: UserRef | null;
  reversal_reason?: string | null;
  cash_handover_id?: string | null;
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
  sent_status?: WaMessageStatus | null;
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

export interface SignedUrl {
  url: string;
  expires_at: string;
}

export interface DamageMark {
  area: string;
  note?: string;
}

export interface TicketDetail extends TicketSummary {
  projection: 'minimal' | 'full';
  vehicle_detail?: VehicleInfo;
  customer?: { phone_masked?: string | null; consent?: ConsentInfo | null; opted_out?: boolean } | null;
  paper_serial?: string | null;
  key_tag?: string | null;
  inspection_status?: InspectionStatus;
  damage_marks?: DamageMark[];
  notes?: string | null;
  current_spot?: { id: string; label: string; zone_name?: string } | null;
  current_spot_note?: string | null;
  current_key_slot?: { id: string; label: string; board_name?: string } | null;
  vehicle_holder?: HolderRef;
  key_holder?: HolderRef;
  pending_retrieval_at?: string | null;
  active_cycle?: RetrievalCycle | null;
  open_task?: Task | null;
  fee_halalas?: number;
  payment?: Payment | null;
  payment_waiver_reason?: string | null;
  claim_code?: ClaimCodeState | null;
  media?: Media[];
  created_by?: UserRef;
  parked_by?: UserRef | null;
  retrieved_by?: UserRef | null;
  delivered_by?: UserRef | null;
  submitted_at?: string | null;
  parked_at?: string | null;
  delivered_at?: string | null;
  voided_at?: string | null;
  void_reason?: string | null;
}

export interface TicketEvent {
  id: number;
  type: string;
  actor_type: ActorType;
  actor_id?: string | null;
  ticket_version: number;
  data?: Record<string, unknown>;
  occurred_at: string;
}

export interface CustodyEvent {
  id: string;
  ticket_id: string;
  subject: CustodySubject;
  from_holder_type: CustodyHolderType;
  from_holder_id?: string | null;
  to_holder_type: CustodyHolderType;
  to_holder_id?: string | null;
  reason: CustodyReason;
  task_id?: string | null;
  actor: UserRef;
  note?: string | null;
  occurred_at: string;
}

export interface WhatsAppMessage {
  id: string;
  direction: WaDirection;
  kind: WaMessageKind;
  purpose?: string | null;
  template_name?: string | null;
  status: WaMessageStatus;
  status_rank: number;
  error_code?: string | null;
  error_title?: string | null;
  body_redacted?: string | null;
  ticket_id?: string | null;
  venue_id?: string | null;
  queued_at?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  failed_at?: string | null;
  received_at?: string | null;
}

export interface Incident {
  id: string;
  venue_id: string;
  event_id?: string | null;
  ticket_id?: string | null;
  type: IncidentType;
  status: IncidentStatus;
  severity: IncidentSeverity;
  description: string;
  opened_by: UserRef;
  owner?: UserRef | null;
  resolution?: string | null;
  resolved_by?: UserRef | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  version: number;
  created_at: string;
  updated_at?: string;
}

export interface TicketTimeline {
  ticket: TicketSummary;
  events: TicketEvent[];
  custody: CustodyEvent[];
  cycles: RetrievalCycle[];
  tasks: Task[];
  messages: WhatsAppMessage[];
  payments: Payment[];
  incidents: Incident[];
}

/** `QueueItem` of 07 (a queue entry of the operations board). */
export interface QueueItem {
  task_id: string;
  ticket: TicketSummary;
  status: TaskStatus;
  requested_at: string;
  waiting_seconds: number;
  offer?: {
    offer_id: string;
    mode: OfferMode;
    round_no?: number;
    expires_at?: string | null;
    recipients?: number;
  } | null;
  escalated_at?: string | null;
  assignee?: UserRef | null;
}

/** `TaskCard` of 07 (the driver's current/next task; also the board's active and next tasks). */
export interface TaskCard {
  task: Task;
  ticket: {
    id: string;
    display_number: number;
    event_name_ar?: string;
    plate?: Plate;
    vehicle?: VehicleInfo;
    status: TicketStatus;
    version?: number;
  };
  parking?: { spot_label?: string | null; zone_name?: string | null; spot_note?: string | null } | null;
  key_slot?: { id: string; board_name: string; label: string } | null;
  requested_at?: string | null;
  waiting_seconds?: number | null;
  payment_due?: { amount_halalas: number; allowed_methods: PaymentMethod[] } | null;
  claim_code?: ClaimCodeState | null;
}

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

export interface Alert {
  id: string;
  venue_id: string;
  dispatch_pool_id?: string | null;
  event_id?: string | null;
  ticket_id?: string | null;
  task_id?: string | null;
  user_id?: string | null;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  details?: Record<string, unknown>;
  raised_at: string;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  resolution_note?: string | null;
}

/** `VenueEvent` of 07 (the `events` table; named to avoid DOM `Event`). */
export interface VenueEvent {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  host_name?: string | null;
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
  close_summary?: Record<string, unknown> | null;
  version: number;
  created_at?: string;
}

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

export interface OperationsKpis {
  open_requests: number;
  oldest_wait_seconds: number | null;
  avg_accept_seconds_30m: number | null;
  drivers_available: number;
  drivers_busy: number;
  drivers_on_break: number;
  drivers_on_duty: number;
  vehicles_parked: number;
  ready_waiting: number;
}

export interface CustodyIssue {
  ticket: TicketSummary;
  subject: CustodySubject;
  holder: HolderRef;
  since: string;
}

/** `OperationsBoard` of 07 (`GET /v1/events/{eventId}/operations`). */
export interface OperationsBoard {
  event: VenueEvent;
  kpis: OperationsKpis;
  queue: QueueItem[];
  active_tasks: TaskCard[];
  next_tasks: TaskCard[];
  drivers: DriverLive[];
  alerts: Alert[];
  failed_messages: WhatsAppMessage[];
  custody_issues: CustodyIssue[];
  channel_health: WaHealthStatus;
}

/** The parts of `VenueSettings` the staff screens read (thresholds for escalation badges). */
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
  ready?: { uncollected_alert_min?: number };
  handover?: { code_ttl_min?: number; max_attempts?: number; max_resends?: number };
  pricing?: { default_mode?: PricingMode; default_fee_halalas?: number; allowed_methods?: PaymentMethod[] };
  [section: string]: unknown;
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

export interface KeyBoard {
  id: string;
  venue_id: string;
  name: string;
  status: SetupStatus;
}

export interface ParkingSpot {
  id: string;
  venue_id?: string;
  zone_id: string;
  zone_name?: string;
  label: string;
  status: SetupStatus;
  occupied?: boolean;
}

export interface CashOutstanding {
  driver: UserRef;
  amount_halalas: number;
}

export interface PaymentIntegrityViolation {
  check: PaymentIntegrityCheck;
  entity_id: string;
}

export interface ReconciliationBlockers {
  open_tickets: TicketSummary[];
  keys_not_in_slots: TicketSummary[];
  open_requests: QueueItem[];
  open_tasks: Task[];
  unsettled_payments: TicketSummary[];
  cash_outstanding: CashOutstanding[];
  payment_integrity: PaymentIntegrityViolation[];
}

/** `Reconciliation` of 07; `blockers` is also `details.blockers` of EVENT_CLOSE_BLOCKED. */
export interface Reconciliation {
  event_id: string;
  can_close: boolean;
  blockers: ReconciliationBlockers;
  warnings: {
    open_incidents: Incident[];
    failed_messages: WhatsAppMessage[];
    cash_discrepancies: Array<{ cash_handover_id?: string; driver?: UserRef; difference_halalas?: number }>;
  };
}

export interface CashHandover {
  id: string;
  event_id: string;
  venue_id?: string;
  driver: UserRef;
  received_by: UserRef;
  amount_halalas: number;
  expected_halalas: number;
  difference_halalas: number;
  payment_ids?: string[];
  note?: string | null;
  handed_at: string;
  incident_id?: string | null;
}

export interface CountHalalas {
  count: number;
  halalas: number;
}

/** `Settlement` of 07 (13 §11). */
export interface Settlement {
  event: {
    id: string;
    name_ar: string;
    status: EventStatus;
    pricing_mode: PricingMode;
    fee_halalas: number;
    allowed_payment_methods: PaymentMethod[];
  };
  currency: 'SAR';
  tickets: {
    total: number;
    delivered: number;
    open: number;
    voided: number;
    by_payment_status: Record<PaymentStatus, number>;
  };
  amounts: {
    billable_halalas: number;
    collected_halalas: number;
    waived_halalas: number;
    due_halalas: number;
    by_method: { cash: CountHalalas; pos: CountHalalas };
    reversed: CountHalalas;
  };
  drivers: Array<{
    driver: UserRef;
    cash: {
      count: number;
      collected_halalas: number;
      handed_over_halalas: number;
      outstanding_halalas: number;
      difference_adjusted_halalas: number;
    };
    pos: CountHalalas;
  }>;
  cash_handovers: CashHandover[];
  discrepancies: Array<{
    type: 'cash_difference' | 'delivered_due' | 'reversed_without_replacement';
    driver_id?: string | null;
    ticket_id?: string | null;
    cash_handover_id?: string | null;
    difference_halalas?: number | null;
    incident_id?: string | null;
  }>;
  close_blockers: {
    unsettled_payments: TicketSummary[];
    cash_outstanding: CashOutstanding[];
    payment_integrity: PaymentIntegrityViolation[];
  };
  integrity: { ok: boolean; violations: PaymentIntegrityViolation[] };
}

/** `DriverListItem` of 07 (`GET /v1/drivers`, `GET /v1/drivers/{driverId}`). */
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
  blocked_details?: Record<string, unknown> | null;
  requested_by?: string;
  approved_by?: string | null;
  completed_at?: string | null;
  canceled_at?: string | null;
  version: number;
}

/** One element of `details.items` (CUSTODY_OPEN, TRANSFER_BLOCKED_CUSTODY, DUTY_END_BLOCKED_CUSTODY). */
export interface CustodyBlockItem {
  type: string;
  ticket_id?: string;
  task_id?: string;
  display_number?: number;
  status?: string;
  holder_type?: CustodyHolderType;
}

export interface EventSummaryReport {
  event: VenueEvent;
  counts: {
    tickets_total?: number;
    delivered?: number;
    voided?: number;
    open?: number;
    reparks?: number;
    canceled_requests?: number;
    whatsapp_linked?: number;
    paper?: number;
  };
  timings_seconds: Partial<
    Record<
      'accept' | 'start' | 'request_to_ready' | 'ready_to_delivered',
      { p50?: number | null; p90?: number | null; max?: number | null }
    >
  >;
  offers: { single?: number; broadcast?: number; expired?: number; escalations?: number };
  messages: { sent?: number; delivered?: number; read?: number; failed?: number; skipped?: number };
  payments: { cash_halalas?: number; pos_halalas?: number; waived?: number; outstanding?: number };
  incidents: { open?: number; resolved?: number };
  by_driver: Array<{
    driver: UserRef;
    parked?: number;
    retrieved?: number;
    delivered?: number;
    accept_p50_s?: number | null;
  }>;
}

export interface DriverReportRow {
  driver: UserRef;
  venue_id?: string | null;
  duty_hours: number;
  parked: number;
  retrieved: number;
  delivered: number;
  offers_received?: number;
  offers_expired?: number;
  accept_p50_s?: number | null;
  handover_code_failures?: number;
}

export interface PaymentsReportTotals {
  cash_halalas?: number;
  pos_halalas?: number;
  waived?: number;
  reversed?: number;
  outstanding?: number;
}

export interface PaymentsReport {
  from: string;
  to: string;
  totals: PaymentsReportTotals;
  rows: Array<PaymentsReportTotals & { event_id: string; event_name_ar?: string; venue_id?: string }>;
}

export interface MessagesReport {
  from: string;
  to: string;
  totals: Partial<Record<WaMessageStatus, number>>;
  failures: WhatsAppMessage[];
}

export interface Export {
  id: string;
  kind: ExportKind;
  filters?: Record<string, unknown>;
  status: ExportStatus;
  row_count?: number | null;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
  expires_at?: string | null;
  download_url?: string | null;
}

export interface WhatsAppChannel {
  id: string;
  display_name: string;
  business_account_id: string;
  phone_number_id: string;
  phone_display?: string | null;
  api_version: string;
  mode: WaChannelMode;
  is_active: boolean;
  health_status: WaHealthStatus;
  health_changed_at?: string | null;
  quality_rating?: string | null;
  messaging_limit_tier?: string | null;
  secrets_configured: { access_token?: boolean; app_secret?: boolean; verify_token?: boolean };
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: WaTemplateCategory;
  status: WaTemplateStatus;
  components: Array<Record<string, unknown>>;
  meta_template_id?: string | null;
  rejection_reason?: string | null;
  version?: number;
  last_synced_at?: string | null;
}

export interface OutboxEvent {
  id: string;
  type: string;
  aggregate_type?: string | null;
  aggregate_id?: string | null;
  aggregate_version?: number | null;
  venue_id?: string | null;
  ordering_key?: string | null;
  dedupe_key?: string | null;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_by?: string | null;
  locked_until?: string | null;
  last_error?: string | null;
  created_at: string;
  processed_at?: string | null;
  payload_preview?: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  occurred_at: string;
  actor_type: ActorType;
  actor_id?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  venue_id?: string | null;
  request_id?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface RetentionPolicy {
  photos_days: number;
  wa_messages_days: number;
  tickets_months: number;
  audit_months: number;
  wa_raw_days: number;
  analytics_months: number;
  approved_by_owner: boolean;
  updated_at?: string | null;
}

/** `OrgSettings` of 07 — the editable `security.*` (without `pin_length`) and `heartbeat.*` (DEC-39, DEC-66). */
export interface OrgSettings {
  security: {
    supervisor_mfa_required: boolean;
    driver_session_hours: number;
    staff_session_hours: number;
    max_login_attempts: number;
    admin_idle_minutes: number;
    reveal_phone_per_hour: number;
  };
  heartbeat: { interval_s: number; uncertain_after_s: number; offline_after_s: number };
  updated_at?: string | null;
}
