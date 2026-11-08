/**
 * Closed value lists from docs/00_Glossary_Canon.md §4–§5 and the extra closed lists of
 * docs/06_schema.sql. Values are literal and ordered exactly as in the canon; the schema wins
 * on column values (it is the source of truth for the database).
 *
 * Pattern for every list: `X_VALUES` (plural UPPER_SNAKE) `as const`, `type X` (PascalCase) and
 * `XSchema` (zod). Subsets (terminal/open/active...) are checked against their parent list with
 * `satisfies`. `test/canon.test.ts` and `test/schema.test.ts` fail on any difference.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// §4 Roles, actors, scopes
// ---------------------------------------------------------------------------------------------

/** `users.role` */
export const ROLES = ['owner', 'admin', 'supervisor', 'driver'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

/** `actor_type` in audit (`audit_log.actor_type`, `ticket_events.actor_type`) and event envelopes. */
export const ACTOR_TYPES = ['user', 'customer', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const ActorTypeSchema = z.enum(ACTOR_TYPES);

/** `role_scopes.scope_type` */
export const SCOPE_TYPES = ['org', 'venue'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export const ScopeTypeSchema = z.enum(SCOPE_TYPES);

// ---------------------------------------------------------------------------------------------
// §5.1 Ticket status
// ---------------------------------------------------------------------------------------------

/** `tickets.status` */
export const TICKET_STATUSES = [
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'delivered',
  'reparking',
  'voided',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TicketStatusSchema = z.enum(TICKET_STATUSES);

/** Terminal ticket statuses (§5.1): `delivered`, `voided`. */
export const TERMINAL_TICKET_STATUSES = ['delivered', 'voided'] as const satisfies readonly TicketStatus[];
export type TerminalTicketStatus = (typeof TERMINAL_TICKET_STATUSES)[number];
export const TerminalTicketStatusSchema = z.enum(TERMINAL_TICKET_STATUSES);

/** «Open» ticket = any non-terminal status (§5.1). */
export const OPEN_TICKET_STATUSES = [
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'reparking',
] as const satisfies readonly Exclude<TicketStatus, TerminalTicketStatus>[];
export type OpenTicketStatus = (typeof OPEN_TICKET_STATUSES)[number];
export const OpenTicketStatusSchema = z.enum(OPEN_TICKET_STATUSES);

export function isTerminalTicketStatus(status: TicketStatus): status is TerminalTicketStatus {
  return (TERMINAL_TICKET_STATUSES as readonly TicketStatus[]).includes(status);
}

// ---------------------------------------------------------------------------------------------
// §5.2 Other ticket status fields
// ---------------------------------------------------------------------------------------------

/** `tickets.channel` (`app`: the V2 customer app's entry pass, O-01; V2-013, DEC-501) */
export const TICKET_CHANNELS = ['whatsapp', 'paper', 'app'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const TicketChannelSchema = z.enum(TICKET_CHANNELS);

/**
 * `tickets.entitlement` (V2, docs/v2/03 §3, 04 §2; V2-014, DEC-502): decided at intake. `subscription` needs the
 * subscriptions of phase V4 and `app_paid` the in-app payment of V3; until then `event_included` or `none`.
 */
export const TICKET_ENTITLEMENTS = ['none', 'subscription', 'app_paid', 'event_included'] as const;
export type TicketEntitlement = (typeof TICKET_ENTITLEMENTS)[number];
export const TicketEntitlementSchema = z.enum(TICKET_ENTITLEMENTS);

/** `tickets.wa_link_status` */
export const WA_LINK_STATUSES = [
  'none',
  'pending_send',
  'pending_confirmation',
  'linked',
  'failed',
  'opted_out',
] as const;
export type WaLinkStatus = (typeof WA_LINK_STATUSES)[number];
export const WaLinkStatusSchema = z.enum(WA_LINK_STATUSES);

/** `tickets.inspection_status` */
export const INSPECTION_STATUSES = ['pending', 'complete', 'incomplete', 'exception_approved'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
export const InspectionStatusSchema = z.enum(INSPECTION_STATUSES);

/** `tickets.payment_status` (not to be confused with `payments.status` → {@link PAYMENT_RECORD_STATUSES}). */
export const PAYMENT_STATUSES = ['not_required', 'due', 'collected', 'waived'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** `tickets.vehicle_holder_type` */
export const VEHICLE_HOLDER_TYPES = ['customer', 'driver', 'spot', 'supervisor', 'unknown'] as const;
export type VehicleHolderType = (typeof VEHICLE_HOLDER_TYPES)[number];
export const VehicleHolderTypeSchema = z.enum(VEHICLE_HOLDER_TYPES);

/** `tickets.key_holder_type` */
export const KEY_HOLDER_TYPES = ['customer', 'driver', 'key_slot', 'supervisor', 'unknown'] as const;
export type KeyHolderType = (typeof KEY_HOLDER_TYPES)[number];
export const KeyHolderTypeSchema = z.enum(KEY_HOLDER_TYPES);

/**
 * `custody_events.from_holder_type` / `custody_events.to_holder_type` (schema): the union of the
 * vehicle and key holder types (`HolderType` in file 11).
 */
export const CUSTODY_HOLDER_TYPES = [
  'customer',
  'driver',
  'spot',
  'key_slot',
  'supervisor',
  'unknown',
] as const;
export type CustodyHolderType = (typeof CUSTODY_HOLDER_TYPES)[number];
export const CustodyHolderTypeSchema = z.enum(CUSTODY_HOLDER_TYPES);

// ---------------------------------------------------------------------------------------------
// §5.3 Retrieval cycle
// ---------------------------------------------------------------------------------------------

/** `retrieval_cycles.request_source` */
export const REQUEST_SOURCES = ['whatsapp', 'staff'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];
export const RequestSourceSchema = z.enum(REQUEST_SOURCES);

/** `retrieval_cycles.outcome` (set when the cycle closes; open while `closed_at IS NULL`). */
export const CYCLE_OUTCOMES = ['delivered', 'canceled', 'reparked'] as const;
export type CycleOutcome = (typeof CYCLE_OUTCOMES)[number];
export const CycleOutcomeSchema = z.enum(CYCLE_OUTCOMES);

// ---------------------------------------------------------------------------------------------
// §5.4 Task
// ---------------------------------------------------------------------------------------------

/** `tasks.type` */
export const TASK_TYPES = ['park', 'retrieve', 'repark'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TaskTypeSchema = z.enum(TASK_TYPES);

/** `tasks.status` (`expired` is an offer-round status, not a task status — DEC-11). */
export const TASK_STATUSES = [
  'queued',
  'offered',
  'broadcast',
  'assigned_waiting',
  'accepted',
  'in_progress',
  'completed',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatusSchema = z.enum(TASK_STATUSES);

/** «Active movement task» = `accepted` or `in_progress` (`uq_tasks_active_movement_driver`). */
export const ACTIVE_MOVEMENT_TASK_STATUSES = [
  'accepted',
  'in_progress',
] as const satisfies readonly TaskStatus[];
export type ActiveMovementTaskStatus = (typeof ACTIVE_MOVEMENT_TASK_STATUSES)[number];
export const ActiveMovementTaskStatusSchema = z.enum(ACTIVE_MOVEMENT_TASK_STATUSES);

/** Closed task statuses: `completed`, `canceled`. */
export const TERMINAL_TASK_STATUSES = ['completed', 'canceled'] as const satisfies readonly TaskStatus[];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];
export const TerminalTaskStatusSchema = z.enum(TERMINAL_TASK_STATUSES);

/** «Open task» = not `completed`/`canceled` (`uq_tasks_open_per_ticket`). */
export const OPEN_TASK_STATUSES = [
  'queued',
  'offered',
  'broadcast',
  'assigned_waiting',
  'accepted',
  'in_progress',
] as const satisfies readonly Exclude<TaskStatus, TerminalTaskStatus>[];
export type OpenTaskStatus = (typeof OPEN_TASK_STATUSES)[number];
export const OpenTaskStatusSchema = z.enum(OPEN_TASK_STATUSES);

/** Unassigned, waiting in the pool queue (`ck_tasks_unassigned_in_queue`, `v_pool_queue`). */
export const QUEUED_TASK_STATUSES = [
  'queued',
  'offered',
  'broadcast',
] as const satisfies readonly TaskStatus[];
export type QueuedTaskStatus = (typeof QUEUED_TASK_STATUSES)[number];
export const QueuedTaskStatusSchema = z.enum(QUEUED_TASK_STATUSES);

export function isOpenTaskStatus(status: TaskStatus): status is OpenTaskStatus {
  return (OPEN_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isActiveMovementTaskStatus(status: TaskStatus): status is ActiveMovementTaskStatus {
  return (ACTIVE_MOVEMENT_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

/** `tasks.cancel_reason` */
export const TASK_CANCEL_REASONS = [
  'customer_field_cancel',
  'supervisor_cancel',
  'repark_customer_absent',
  'manual_reconcile',
  'draft_discarded',
  'ticket_voided',
] as const;
export type TaskCancelReason = (typeof TASK_CANCEL_REASONS)[number];
export const TaskCancelReasonSchema = z.enum(TASK_CANCEL_REASONS);

// ---------------------------------------------------------------------------------------------
// §5.5 Offers
// ---------------------------------------------------------------------------------------------

/** `task_offers.mode` */
export const OFFER_MODES = ['single', 'broadcast'] as const;
export type OfferMode = (typeof OFFER_MODES)[number];
export const OfferModeSchema = z.enum(OFFER_MODES);

/** `task_offers.status` */
export const OFFER_STATUSES = ['active', 'accepted', 'expired', 'revoked'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OfferStatusSchema = z.enum(OFFER_STATUSES);

/** `task_offers.close_reason` */
export const OFFER_CLOSE_REASONS = [
  'accepted',
  'expired',
  'claimed_elsewhere',
  'task_canceled',
  'reassigned',
  'recipient_unavailable',
  'converted_to_broadcast',
  'converted_to_single',
  'transfer',
] as const;
export type OfferCloseReason = (typeof OFFER_CLOSE_REASONS)[number];
export const OfferCloseReasonSchema = z.enum(OFFER_CLOSE_REASONS);

/** `offer_recipients.eligible_as` */
export const OFFER_ELIGIBILITIES = ['accept', 'reserve_next', 'view_only'] as const;
export type OfferEligibility = (typeof OFFER_ELIGIBILITIES)[number];
export const OfferEligibilitySchema = z.enum(OFFER_ELIGIBILITIES);

/** `offer_recipients.response` (`rejected_late` only on `TASK_ALREADY_CLAIMED`, for analytics). */
export const OFFER_RESPONSES = ['accepted', 'rejected_late'] as const;
export type OfferResponse = (typeof OFFER_RESPONSES)[number];
export const OfferResponseSchema = z.enum(OFFER_RESPONSES);

// ---------------------------------------------------------------------------------------------
// §5.6 Derived driver state (computed, never stored — `v_driver_state`)
// ---------------------------------------------------------------------------------------------

export const DRIVER_STATES = [
  'off_duty',
  'on_break',
  'available',
  'intake_parking',
  'retrieving',
  'busy_with_next',
] as const;
export type DriverState = (typeof DRIVER_STATES)[number];
export const DriverStateSchema = z.enum(DRIVER_STATES);

/** `duty_sessions.connection_state` — separate indicator; never changes availability. */
export const CONNECTION_STATES = ['online', 'uncertain', 'offline'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];
export const ConnectionStateSchema = z.enum(CONNECTION_STATES);

// ---------------------------------------------------------------------------------------------
// §5.7 Other operational entities
// ---------------------------------------------------------------------------------------------

/** `events.status` (`closing` → `open` allowed via `POST /v1/events/{eventId}/open`). */
export const EVENT_STATUSES = ['draft', 'open', 'closing', 'closed', 'canceled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EventStatusSchema = z.enum(EVENT_STATUSES);

/** `events.pricing_mode` — also `pricing.default_mode` in venue settings. */
export const PRICING_MODES = ['included', 'per_vehicle'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const PricingModeSchema = z.enum(PRICING_MODES);

/** `shifts.status` */
export const SHIFT_STATUSES = ['scheduled', 'open', 'closed'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];
export const ShiftStatusSchema = z.enum(SHIFT_STATUSES);

/** `duty_sessions.status` */
export const DUTY_STATUSES = ['on_duty', 'on_break', 'ended'] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];
export const DutyStatusSchema = z.enum(DUTY_STATUSES);

/** `users.status` */
export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const UserStatusSchema = z.enum(USER_STATUSES);

/** `users.secret_kind`: `pin` (driver) · `password` (supervisor/admin/owner). */
export const SECRET_KINDS = ['pin', 'password'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const SecretKindSchema = z.enum(SECRET_KINDS);

/** `driver_assignments.status` */
export const ASSIGNMENT_STATUSES = ['scheduled', 'active', 'ended'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const AssignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);

/** `driver_transfers.status` */
export const TRANSFER_STATUSES = ['pending', 'blocked', 'completed', 'canceled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const TransferStatusSchema = z.enum(TRANSFER_STATUSES);

/** `link_codes.status` */
export const LINK_CODE_STATUSES = [
  'active',
  'pending_confirmation',
  'consumed',
  'expired',
  'revoked',
] as const;
export type LinkCodeStatus = (typeof LINK_CODE_STATUSES)[number];
export const LinkCodeStatusSchema = z.enum(LINK_CODE_STATUSES);

/** `payments.method` — also `events.allowed_payment_methods[]` and `pricing.allowed_methods`. */
export const PAYMENT_METHODS = ['cash', 'pos'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);

/** `payments.status` (not `tickets.payment_status` → {@link PAYMENT_STATUSES}). */
export const PAYMENT_RECORD_STATUSES = ['recorded', 'reversed'] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];
export const PaymentRecordStatusSchema = z.enum(PAYMENT_RECORD_STATUSES);

/** `incidents.type` */
export const INCIDENT_TYPES = [
  'key_missing',
  'vehicle_damage',
  'customer_absent',
  'manual_verification',
  'lost_ticket',
  'payment_discrepancy',
  'inspection_incomplete',
  'wrong_vehicle',
  'custody_mismatch',
  'other',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export const IncidentTypeSchema = z.enum(INCIDENT_TYPES);

/** `incidents.status` */
export const INCIDENT_STATUSES = ['open', 'in_review', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

/** `incidents.severity` */
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const IncidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);

/** `alerts.status` */
export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export const AlertStatusSchema = z.enum(ALERT_STATUSES);

/** `alerts.severity` */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);

/** `alerts.type` */
export const ALERT_TYPES = [
  'no_drivers_on_duty',
  'request_unaccepted',
  'next_task_waiting_long',
  'idle_driver_while_next_waiting',
  'ready_not_collected',
  'wa_send_failed',
  'wa_channel_down',
  'driver_connection_lost_with_custody',
  'handover_code_locked',
  'inspection_incomplete',
  'draft_abandoned',
  'transfer_blocked',
  'outbox_lag',
  'push_failed_repeatedly',
  'task_stuck',
  'wa_webhook_silent',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const AlertTypeSchema = z.enum(ALERT_TYPES);

/** `customer_consents.method` */
export const CONSENT_METHODS = ['verbal_staff_confirmed', 'customer_initiated'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
export const ConsentMethodSchema = z.enum(CONSENT_METHODS);

/** `customer_consents.revoke_source` */
export const CONSENT_REVOKE_SOURCES = ['customer_opt_out', 'staff', 'admin'] as const;
export type ConsentRevokeSource = (typeof CONSENT_REVOKE_SOURCES)[number];
export const ConsentRevokeSourceSchema = z.enum(CONSENT_REVOKE_SOURCES);

/** `custody_events.subject` */
export const CUSTODY_SUBJECTS = ['vehicle', 'key'] as const;
export type CustodySubject = (typeof CUSTODY_SUBJECTS)[number];
export const CustodySubjectSchema = z.enum(CUSTODY_SUBJECTS);

/** `custody_events.reason` */
export const CUSTODY_REASONS = [
  'intake',
  'parked',
  'key_deposited',
  'key_pickup',
  'retrieval_start',
  'handover',
  'repark',
  'official_transfer',
  'withdrawal_release',
  'manual_reconcile',
  'correction',
] as const;
export type CustodyReason = (typeof CUSTODY_REASONS)[number];
export const CustodyReasonSchema = z.enum(CUSTODY_REASONS);

/** `media_assets.kind` — also the items of `inspection.required_photos`. */
export const MEDIA_KINDS = [
  'photo_front',
  'photo_rear',
  'photo_left',
  'photo_right',
  'photo_extra',
  'photo_damage',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MediaKindSchema = z.enum(MEDIA_KINDS);

/** `media_assets.upload_status` */
export const MEDIA_UPLOAD_STATUSES = ['pending', 'uploaded', 'failed', 'deleted'] as const;
export type MediaUploadStatus = (typeof MEDIA_UPLOAD_STATUSES)[number];
export const MediaUploadStatusSchema = z.enum(MEDIA_UPLOAD_STATUSES);

/** `whatsapp_messages.direction` */
export const WA_DIRECTIONS = ['outbound', 'inbound'] as const;
export type WaDirection = (typeof WA_DIRECTIONS)[number];
export const WaDirectionSchema = z.enum(WA_DIRECTIONS);

/** `whatsapp_messages.status` */
export const WA_MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'received',
] as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUSES)[number];
export const WaMessageStatusSchema = z.enum(WA_MESSAGE_STATUSES);

/**
 * `whatsapp_messages.status_rank` — the rank is never lowered; `failed` and `skipped` are final
 * for an outbound message (§5.7).
 */
export const WA_MESSAGE_STATUS_RANK = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
} as const satisfies Partial<Record<WaMessageStatus, number>>;

/** `whatsapp_messages.kind` */
export const WA_MESSAGE_KINDS = [
  'template',
  'session_text',
  'inbound_text',
  'inbound_button',
  'inbound_interactive',
  'inbound_other',
] as const;
export type WaMessageKind = (typeof WA_MESSAGE_KINDS)[number];
export const WaMessageKindSchema = z.enum(WA_MESSAGE_KINDS);

/** `notifications.channel` */
export const NOTIFICATION_CHANNELS = ['whatsapp', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/** `notifications.status` */
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

/** `outbox_events.status` */
export const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'failed', 'dead', 'canceled'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const OutboxStatusSchema = z.enum(OUTBOX_STATUSES);

/** `devices.notification_permission` */
export const NOTIFICATION_PERMISSIONS = ['default', 'granted', 'denied', 'unsupported'] as const;
export type NotificationPermission = (typeof NOTIFICATION_PERMISSIONS)[number];
export const NotificationPermissionSchema = z.enum(NOTIFICATION_PERMISSIONS);

/** `devices.display_mode` */
export const DISPLAY_MODES = ['browser', 'standalone'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export const DisplayModeSchema = z.enum(DISPLAY_MODES);

/** `devices.audio_test_result` */
export const AUDIO_TEST_RESULTS = ['heard', 'not_heard', 'blocked'] as const;
export type AudioTestResult = (typeof AUDIO_TEST_RESULTS)[number];
export const AudioTestResultSchema = z.enum(AUDIO_TEST_RESULTS);

/** `devices.platform` */
export const DEVICE_PLATFORMS = ['ios', 'android', 'desktop', 'other'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);

/** `auth_sessions.revoked_reason` — sent as `reason` in the `session.revoked` WebSocket event. */
export const SESSION_REVOKED_REASONS = [
  'logout',
  'transfer',
  'disabled',
  'secret_reset',
  'admin',
  'expired_cleanup',
] as const;
export type SessionRevokedReason = (typeof SESSION_REVOKED_REASONS)[number];
export const SessionRevokedReasonSchema = z.enum(SESSION_REVOKED_REASONS);

/** `duty_sessions.end_reason` */
export const DUTY_END_REASONS = ['self', 'forced', 'transfer', 'disabled', 'shift_closed'] as const;
export type DutyEndReason = (typeof DUTY_END_REASONS)[number];
export const DutyEndReasonSchema = z.enum(DUTY_END_REASONS);

/** `tickets.vehicle_type` */
export const VEHICLE_TYPES = ['sedan', 'suv', 'pickup', 'van', 'other'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const VehicleTypeSchema = z.enum(VEHICLE_TYPES);

/** `media_assets.content_type` */
export const MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/webp', 'image/heic', 'image/png'] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];
export const MediaContentTypeSchema = z.enum(MEDIA_CONTENT_TYPES);

/**
 * Status of setup entities: `venues`, `dispatch_pools`, `parking_zones`, `parking_spots`,
 * `key_boards`, `key_slots` (`SetupStatus` in the OpenAPI file).
 */
export const SETUP_STATUSES = ['active', 'inactive'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];
export const SetupStatusSchema = z.enum(SETUP_STATUSES);

/** `retrieval_cycles.handover_method` */
export const HANDOVER_METHODS = ['code', 'paper_stub', 'supervisor_exception', 'manual_reconcile'] as const;
export type HandoverMethod = (typeof HANDOVER_METHODS)[number];
export const HandoverMethodSchema = z.enum(HANDOVER_METHODS);

/** `link_codes.revoke_reason` */
export const LINK_CODE_REVOKE_REASONS = [
  'driver_rejected_match',
  'regenerated',
  'linked_direct',
  'ticket_voided',
  'channel_paper',
] as const;
export type LinkCodeRevokeReason = (typeof LINK_CODE_REVOKE_REASONS)[number];
export const LinkCodeRevokeReasonSchema = z.enum(LINK_CODE_REVOKE_REASONS);

/** `claim_codes.revoke_reason` */
export const CLAIM_CODE_REVOKE_REASONS = [
  'resend',
  'reparked',
  'canceled',
  'exception_handover',
  'expired_cleanup',
] as const;
export type ClaimCodeRevokeReason = (typeof CLAIM_CODE_REVOKE_REASONS)[number];
export const ClaimCodeRevokeReasonSchema = z.enum(CLAIM_CODE_REVOKE_REASONS);

/** `spot_allocations.release_reason` */
export const SPOT_RELEASE_REASONS = [
  'retrieval_start',
  'repark',
  'correction',
  'manual_reconcile',
  'void',
  'official_transfer',
] as const;
export type SpotReleaseReason = (typeof SPOT_RELEASE_REASONS)[number];
export const SpotReleaseReasonSchema = z.enum(SPOT_RELEASE_REASONS);

/** `key_slot_allocations.release_reason` */
export const KEY_SLOT_RELEASE_REASONS = [
  'key_pickup',
  'correction',
  'manual_reconcile',
  'void',
  'official_transfer',
] as const;
export type KeySlotReleaseReason = (typeof KEY_SLOT_RELEASE_REASONS)[number];
export const KeySlotReleaseReasonSchema = z.enum(KEY_SLOT_RELEASE_REASONS);

/** `whatsapp_channel.mode` */
export const WA_CHANNEL_MODES = ['live', 'simulator'] as const;
export type WaChannelMode = (typeof WA_CHANNEL_MODES)[number];
export const WaChannelModeSchema = z.enum(WA_CHANNEL_MODES);

/** `whatsapp_channel.health_status` (`WaHealthStatus` in `channel.status` payloads). */
export const WA_HEALTH_STATUSES = ['healthy', 'degraded', 'down'] as const;
export type WaHealthStatus = (typeof WA_HEALTH_STATUSES)[number];
export const WaHealthStatusSchema = z.enum(WA_HEALTH_STATUSES);

/** `whatsapp_templates.category` */
export const WA_TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type WaTemplateCategory = (typeof WA_TEMPLATE_CATEGORIES)[number];
export const WaTemplateCategorySchema = z.enum(WA_TEMPLATE_CATEGORIES);

/** `whatsapp_templates.status` */
export const WA_TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number];
export const WaTemplateStatusSchema = z.enum(WA_TEMPLATE_STATUSES);

/** `exports.kind` */
export const EXPORT_KINDS = ['event_summary', 'tickets', 'payments', 'drivers', 'messages', 'audit'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const ExportKindSchema = z.enum(EXPORT_KINDS);

/** `exports.status` */
export const EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const ExportStatusSchema = z.enum(EXPORT_STATUSES);

/**
 * Staff Web Push notification types = the sound ids of §13 (without `test`) plus `closed`, the
 * quiet replacement notification with the same tag (DEC-23). No other types.
 */
export const PUSH_NOTIFICATION_TYPES = [
  'offer',
  'broadcast',
  'reminder',
  'next_due',
  'escalation',
  'closed',
] as const;
export type PushNotificationType = (typeof PUSH_NOTIFICATION_TYPES)[number];
export const PushNotificationTypeSchema = z.enum(PUSH_NOTIFICATION_TYPES);

// ---------------------------------------------------------------------------------------------
// §5 Extra closed lists from the schema (equally binding)
// ---------------------------------------------------------------------------------------------

/** `notifications.skipped_reason` */
export const NOTIFICATION_SKIPPED_REASONS = [
  'superseded',
  'opted_out',
  'no_consent',
  'channel_down',
  'stale',
  'no_subscription',
] as const;
export type NotificationSkippedReason = (typeof NOTIFICATION_SKIPPED_REASONS)[number];
export const NotificationSkippedReasonSchema = z.enum(NOTIFICATION_SKIPPED_REASONS);

/** `notification_attempts.outcome` */
export const NOTIFICATION_ATTEMPT_OUTCOMES = ['success', 'retryable_error', 'permanent_error'] as const;
export type NotificationAttemptOutcome = (typeof NOTIFICATION_ATTEMPT_OUTCOMES)[number];
export const NotificationAttemptOutcomeSchema = z.enum(NOTIFICATION_ATTEMPT_OUTCOMES);

/** `media_assets.delete_reason` */
export const MEDIA_DELETE_REASONS = ['retention', 'correction', 'admin'] as const;
export type MediaDeleteReason = (typeof MEDIA_DELETE_REASONS)[number];
export const MediaDeleteReasonSchema = z.enum(MEDIA_DELETE_REASONS);

/** `vehicle_inspections.kind` */
export const INSPECTION_KINDS = ['intake', 'handover', 'incident'] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];
export const InspectionKindSchema = z.enum(INSPECTION_KINDS);

/** `whatsapp_inbound_events.status` */
export const WA_INBOUND_EVENT_STATUSES = ['pending', 'processed', 'failed', 'ignored'] as const;
export type WaInboundEventStatus = (typeof WA_INBOUND_EVENT_STATUSES)[number];
export const WaInboundEventStatusSchema = z.enum(WA_INBOUND_EVENT_STATUSES);

/** `tickets.pending_retrieval_source` — early request from the WhatsApp button only (DEC-25). */
export const PENDING_RETRIEVAL_SOURCES = ['whatsapp'] as const;
export type PendingRetrievalSource = (typeof PENDING_RETRIEVAL_SOURCES)[number];
export const PendingRetrievalSourceSchema = z.enum(PENDING_RETRIEVAL_SOURCES);

/** `analytics_events.source` */
export const ANALYTICS_SOURCES = ['server', 'client'] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];
export const AnalyticsSourceSchema = z.enum(ANALYTICS_SOURCES);

/** `idempotency_keys.status` */
export const IDEMPOTENCY_KEY_STATUSES = ['in_progress', 'completed'] as const;
export type IdempotencyKeyStatus = (typeof IDEMPOTENCY_KEY_STATUSES)[number];
export const IdempotencyKeyStatusSchema = z.enum(IDEMPOTENCY_KEY_STATUSES);

/** `action_tokens.action` */
export const ACTION_TOKEN_ACTIONS = ['request_retrieval'] as const;
export type ActionTokenAction = (typeof ACTION_TOKEN_ACTIONS)[number];
export const ActionTokenActionSchema = z.enum(ACTION_TOKEN_ACTIONS);

/** `customer_consents.channel` */
export const CONSENT_CHANNELS = ['whatsapp'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const ConsentChannelSchema = z.enum(CONSENT_CHANNELS);

// ---------------------------------------------------------------------------------------------
// §5 API-level values (request bodies / projections, not columns)
// ---------------------------------------------------------------------------------------------

/** `POST /v1/tickets/{ticketId}/whatsapp-link` body `method`. */
export const WA_LINK_METHODS = ['direct', 'qr'] as const;
export type WaLinkMethod = (typeof WA_LINK_METHODS)[number];
export const WaLinkMethodSchema = z.enum(WA_LINK_METHODS);

/** `POST /v1/tickets/{ticketId}/handover` body `verification.method`. */
export const HANDOVER_VERIFICATION_METHODS = ['code', 'paper_stub'] as const;
export type HandoverVerificationMethod = (typeof HANDOVER_VERIFICATION_METHODS)[number];
export const HandoverVerificationMethodSchema = z.enum(HANDOVER_VERIFICATION_METHODS);

/** `TicketDetail.projection` */
export const TICKET_PROJECTIONS = ['minimal', 'full'] as const;
export type TicketProjection = (typeof TICKET_PROJECTIONS)[number];
export const TicketProjectionSchema = z.enum(TICKET_PROJECTIONS);

/** `POST /v1/tickets/{ticketId}/manual-reconcile` body `target_status`. */
export const MANUAL_RECONCILE_TARGET_STATUSES = [
  'parked',
  'delivered',
  'voided',
] as const satisfies readonly TicketStatus[];
export type ManualReconcileTargetStatus = (typeof MANUAL_RECONCILE_TARGET_STATUSES)[number];
export const ManualReconcileTargetStatusSchema = z.enum(MANUAL_RECONCILE_TARGET_STATUSES);

/** `POST /v1/staff` body `role` (the owner is created by the seed only). */
export const STAFF_CREATE_ROLES = ['admin', 'supervisor'] as const satisfies readonly Role[];
export type StaffCreateRole = (typeof STAFF_CREATE_ROLES)[number];
export const StaffCreateRoleSchema = z.enum(STAFF_CREATE_ROLES);

// ---------------------------------------------------------------------------------------------
// §12 Settings value lists
// ---------------------------------------------------------------------------------------------

/** Venue setting `parking.mode` (`ParkingMode` in the OpenAPI file). */
export const PARKING_MODES = ['assigned_spots', 'free_text', 'mixed'] as const;
export type ParkingMode = (typeof PARKING_MODES)[number];
export const ParkingModeSchema = z.enum(PARKING_MODES);

// ---------------------------------------------------------------------------------------------
// File 11 §8.1: aggregate types of the domain-event envelope
// ---------------------------------------------------------------------------------------------

export const AGGREGATE_TYPES = [
  'ticket',
  'task',
  'task_offer',
  'duty_session',
  'user',
  'driver_transfer',
  'payment',
  'alert',
  'incident',
  'event',
  'shift',
  'whatsapp_message',
  'whatsapp_channel',
  'customer',
  'claim_code',
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];
export const AggregateTypeSchema = z.enum(AGGREGATE_TYPES);

// ---------------------------------------------------------------------------------------------
// Every `CHECK (column IN (...))` of docs/06_schema.sql → its list (verified by test/schema.test.ts).
// `events.allowed_payment_methods` is an array checked by `ck_events_payment_methods` (<@ PAYMENT_METHODS).
// ---------------------------------------------------------------------------------------------

export const SCHEMA_COLUMN_ENUMS = {
  'venues.status': SETUP_STATUSES,
  'dispatch_pools.status': SETUP_STATUSES,
  'users.role': ROLES,
  'users.status': USER_STATUSES,
  'users.secret_kind': SECRET_KINDS,
  'role_scopes.scope_type': SCOPE_TYPES,
  'devices.platform': DEVICE_PLATFORMS,
  'devices.display_mode': DISPLAY_MODES,
  'devices.notification_permission': NOTIFICATION_PERMISSIONS,
  'devices.audio_test_result': AUDIO_TEST_RESULTS,
  'auth_sessions.revoked_reason': SESSION_REVOKED_REASONS,
  'driver_assignments.status': ASSIGNMENT_STATUSES,
  'driver_transfers.status': TRANSFER_STATUSES,
  'events.status': EVENT_STATUSES,
  'events.pricing_mode': PRICING_MODES,
  'shifts.status': SHIFT_STATUSES,
  'duty_sessions.status': DUTY_STATUSES,
  'duty_sessions.end_reason': DUTY_END_REASONS,
  'duty_sessions.connection_state': CONNECTION_STATES,
  'parking_zones.status': SETUP_STATUSES,
  'parking_spots.status': SETUP_STATUSES,
  'key_boards.status': SETUP_STATUSES,
  'key_slots.status': SETUP_STATUSES,
  'tickets.status': TICKET_STATUSES,
  // widened by migration 0010 with `app` (V2-013, DEC-501); the test reads the widening from the migration
  'tickets.channel': TICKET_CHANNELS,
  'tickets.wa_link_status': WA_LINK_STATUSES,
  'tickets.vehicle_type': VEHICLE_TYPES,
  'tickets.inspection_status': INSPECTION_STATUSES,
  'tickets.vehicle_holder_type': VEHICLE_HOLDER_TYPES,
  'tickets.key_holder_type': KEY_HOLDER_TYPES,
  'tickets.pending_retrieval_source': PENDING_RETRIEVAL_SOURCES,
  'tickets.payment_status': PAYMENT_STATUSES,
  'ticket_events.actor_type': ACTOR_TYPES,
  'customer_consents.channel': CONSENT_CHANNELS,
  'customer_consents.method': CONSENT_METHODS,
  'customer_consents.revoke_source': CONSENT_REVOKE_SOURCES,
  'vehicle_inspections.kind': INSPECTION_KINDS,
  'media_assets.kind': MEDIA_KINDS,
  'media_assets.content_type': MEDIA_CONTENT_TYPES,
  'media_assets.upload_status': MEDIA_UPLOAD_STATUSES,
  'media_assets.delete_reason': MEDIA_DELETE_REASONS,
  'spot_allocations.release_reason': SPOT_RELEASE_REASONS,
  'key_slot_allocations.release_reason': KEY_SLOT_RELEASE_REASONS,
  'retrieval_cycles.request_source': REQUEST_SOURCES,
  'retrieval_cycles.handover_method': HANDOVER_METHODS,
  'retrieval_cycles.outcome': CYCLE_OUTCOMES,
  'tasks.type': TASK_TYPES,
  'tasks.status': TASK_STATUSES,
  'tasks.cancel_reason': TASK_CANCEL_REASONS,
  'task_offers.mode': OFFER_MODES,
  'task_offers.status': OFFER_STATUSES,
  'task_offers.close_reason': OFFER_CLOSE_REASONS,
  'offer_recipients.eligible_as': OFFER_ELIGIBILITIES,
  'offer_recipients.response': OFFER_RESPONSES,
  'custody_events.subject': CUSTODY_SUBJECTS,
  'custody_events.from_holder_type': CUSTODY_HOLDER_TYPES,
  'custody_events.to_holder_type': CUSTODY_HOLDER_TYPES,
  'custody_events.reason': CUSTODY_REASONS,
  'whatsapp_channel.mode': WA_CHANNEL_MODES,
  'whatsapp_channel.health_status': WA_HEALTH_STATUSES,
  'whatsapp_templates.category': WA_TEMPLATE_CATEGORIES,
  'whatsapp_templates.status': WA_TEMPLATE_STATUSES,
  'notifications.channel': NOTIFICATION_CHANNELS,
  'notifications.status': NOTIFICATION_STATUSES,
  'notifications.skipped_reason': NOTIFICATION_SKIPPED_REASONS,
  'notification_attempts.outcome': NOTIFICATION_ATTEMPT_OUTCOMES,
  'whatsapp_messages.direction': WA_DIRECTIONS,
  'whatsapp_messages.kind': WA_MESSAGE_KINDS,
  'whatsapp_messages.status': WA_MESSAGE_STATUSES,
  'whatsapp_inbound_events.status': WA_INBOUND_EVENT_STATUSES,
  'action_tokens.action': ACTION_TOKEN_ACTIONS,
  'link_codes.status': LINK_CODE_STATUSES,
  'link_codes.revoke_reason': LINK_CODE_REVOKE_REASONS,
  'claim_codes.revoke_reason': CLAIM_CODE_REVOKE_REASONS,
  'payments.method': PAYMENT_METHODS,
  'payments.status': PAYMENT_RECORD_STATUSES,
  'incidents.type': INCIDENT_TYPES,
  'incidents.status': INCIDENT_STATUSES,
  'incidents.severity': INCIDENT_SEVERITIES,
  'alerts.type': ALERT_TYPES,
  'alerts.severity': ALERT_SEVERITIES,
  'alerts.status': ALERT_STATUSES,
  'outbox_events.status': OUTBOX_STATUSES,
  'idempotency_keys.status': IDEMPOTENCY_KEY_STATUSES,
  'audit_log.actor_type': ACTOR_TYPES,
  'analytics_events.source': ANALYTICS_SOURCES,
  'exports.kind': EXPORT_KINDS,
  'exports.status': EXPORT_STATUSES,
} as const satisfies Record<string, readonly string[]>;
export type SchemaEnumColumn = keyof typeof SCHEMA_COLUMN_ENUMS;
