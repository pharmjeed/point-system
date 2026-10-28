/**
 * Analytics catalog of docs/15_Event_Tracking_Plan.md: names (§4), property allow-lists for the
 * server events (§7) and the client measurements (§8), the PII denylist (§3) and the wire format of
 * `POST /v1/telemetry` (§9).
 *
 * Every property schema is strict: an unknown key — and therefore any key of the §3 denylist —
 * rejects the event. String values are closed lists, uuids, canon error codes (§8 of the canon) or
 * staff screen ids (§14) only; durations are integers in `*_s` / `*_ms`.
 */
import { z } from 'zod';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  AUDIO_TEST_RESULTS,
  CONNECTION_STATES,
  CUSTODY_HOLDER_TYPES,
  CUSTODY_REASONS,
  CUSTODY_SUBJECTS,
  DEVICE_PLATFORMS,
  DISPLAY_MODES,
  DRIVER_STATES,
  DUTY_END_REASONS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  MANUAL_RECONCILE_TARGET_STATUSES,
  NOTIFICATION_PERMISSIONS,
  OFFER_ELIGIBILITIES,
  OFFER_MODES,
  PAYMENT_METHODS,
  PRICING_MODES,
  PUSH_NOTIFICATION_TYPES,
  REQUEST_SOURCES,
  TASK_STATUSES,
  TASK_TYPES,
  TICKET_CHANNELS,
  TICKET_STATUSES,
  WA_HEALTH_STATUSES,
  WA_LINK_METHODS,
  WA_LINK_STATUSES,
} from './canon/enums.js';
import { DOMAIN_EVENT_TYPES, type DomainEventType } from './canon/events.js';
import { STAFF_SCREEN_IDS } from './canon/screens.js';
import { SOUND_IDS } from './canon/sounds.js';
import { WA_MESSAGE_IDS } from './canon/wa-templates.js';
import { ERROR_CODES } from './errors.js';

// ---------------------------------------------------------------------------------------------
// §3 PII denylist and §4 naming
// ---------------------------------------------------------------------------------------------

/** Keys that never appear in `analytics_events.properties` (15 §3). */
export const ANALYTICS_PII_DENYLIST = [
  'phone',
  'phone_e164',
  'wa_id',
  'customer_id',
  'plate',
  'plate_digits',
  'plate_letters_ar',
  'plate_letters_en',
  'plate_raw',
  'key_tag',
  'key_slot_id',
  'key_slot_label',
  'parking_spot_id',
  'spot_label',
  'spot_note',
  'code',
  'claim_code',
  'link_code',
  'token',
  'action_token',
  'payload',
  'pos_reference',
  'notes',
  'reason',
  'description',
  'full_name',
  'name',
  'ip',
  'user_agent',
  'storage_key',
] as const;
export type AnalyticsDeniedKey = (typeof ANALYTICS_PII_DENYLIST)[number];

const DENIED: ReadonlySet<string> = new Set(ANALYTICS_PII_DENYLIST);

export function isDeniedAnalyticsKey(key: string): boolean {
  return DENIED.has(key);
}

/** Server analytics name (15 §4): the domain event type with the dot replaced by an underscore. */
export function analyticsName(type: DomainEventType): string {
  return type.replace('.', '_');
}

/** `analytics_events.actor_role` (15 §5): the user's role, `customer` or `system`. */
export const ANALYTICS_ACTOR_ROLES = [
  'owner',
  'admin',
  'supervisor',
  'driver',
  'customer',
  'system',
] as const;
export type AnalyticsActorRole = (typeof ANALYTICS_ACTOR_ROLES)[number];

// ---------------------------------------------------------------------------------------------
// Property value types (15 §3: no free text)
// ---------------------------------------------------------------------------------------------

const MAX_INT = Number.MAX_SAFE_INTEGER;
const nonNegative = () => z.number().int().min(0).max(MAX_INT);
const p = {
  /** non-negative integer (counts, `*_s`, `*_ms`, halalas) */
  int: () => nonNegative().nullable().optional(),
  /** integer that may be negative (differences, client clock skew) */
  signed: () => z.number().int().min(-MAX_INT).max(MAX_INT).nullable().optional(),
  bool: () => z.boolean().nullable().optional(),
  uuid: () => z.guid().nullable().optional(),
  one: <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values).nullable().optional(),
  list: <const T extends readonly [string, ...string[]]>(values: T) =>
    z.array(z.enum(values)).max(16).nullable().optional(),
  /** provider (Meta) numeric error codes only (15 §7.6) */
  providerCode: () =>
    z
      .string()
      .regex(/^[0-9]{1,10}$/)
      .nullable()
      .optional(),
  /** an application version (`1.0.3`, `dev`, a git sha) */
  version: () =>
    z
      .string()
      .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/)
      .nullable()
      .optional(),
};

const INSPECTION_AT_SUBMIT = ['complete', 'incomplete', 'exception_approved'] as const;
const DELIVERY_VERIFICATION = ['code', 'paper_stub', 'supervisor_exception'] as const;
const OFFER_REVOKE_REASONS = [
  'claimed_elsewhere',
  'task_canceled',
  'reassigned',
  'recipient_unavailable',
  'converted_to_broadcast',
  'converted_to_single',
  'transfer',
] as const;

// ---------------------------------------------------------------------------------------------
// §7 Server events (one per domain event of canon §7.1)
// ---------------------------------------------------------------------------------------------

/** Property allow-list of every server analytics event, keyed by its domain event type (15 §7). */
export const SERVER_ANALYTICS_PROPERTIES = {
  // §7.1 ticket
  'ticket.created': { channel: p.one(TICKET_CHANNELS), pricing_mode: p.one(PRICING_MODES) },
  'ticket.intake_submitted': {
    channel: p.one(TICKET_CHANNELS),
    inspection_status: p.one(INSPECTION_AT_SUBMIT),
    photos_count: p.int(),
    has_customer_phone: p.bool(),
    wa_link_method: p.one(['direct', 'qr', 'none']),
    intake_duration_s: p.int(),
  },
  'ticket.parked': {
    parking_duration_s: p.int(),
    spot_mode: p.one(['spot', 'note']),
    key_slot_used: p.bool(),
    had_pending_retrieval: p.bool(),
    is_repark: p.bool(),
  },
  'ticket.retrieval_requested': {
    request_source: p.one(REQUEST_SOURCES),
    cycle_no: p.int(),
    requested_early: p.bool(),
    queue_depth: p.int(),
    available_drivers: p.int(),
    ingest_latency_ms: p.int(),
  },
  'ticket.retrieval_requested_early': {
    request_source: p.one(['whatsapp']),
    status_at_request: p.one(['received', 'parking', 'reparking']),
  },
  'ticket.assigned': { wait_s: p.int(), offer_mode: p.one(OFFER_MODES), offer_round_no: p.int() },
  'ticket.assigned_waiting': { wait_s: p.int(), offer_round_no: p.int() },
  'ticket.retrieving': { start_after_claim_s: p.int(), from_next_task: p.bool() },
  'ticket.ready': { request_to_ready_s: p.int(), retrieval_duration_s: p.int() },
  'ticket.delivered': {
    ready_to_delivered_s: p.int(),
    request_to_delivered_s: p.int(),
    verification_method: p.one(DELIVERY_VERIFICATION),
    payment_status: p.one(['not_required', 'collected', 'waived']),
    cycle_no: p.int(),
    ticket_lifetime_s: p.int(),
  },
  'ticket.reparking': {
    cause: p.one(['customer_absent', 'supervisor_cancel']),
    ready_wait_s: p.int(),
    cycle_no: p.int(),
  },
  'ticket.retrieval_canceled': {
    status_at_cancel: p.one(['requested', 'assigned', 'assigned_waiting', 'retrieving', 'ready']),
    canceled_by_role: p.one(['driver', 'supervisor']),
    after_s: p.int(),
  },
  'ticket.voided': { voided_from_status: p.one(['received', 'parking']), had_data: p.bool() },
  'ticket.customer_phone_changed': { changed_by_role: p.one(['driver', 'supervisor', 'admin']) },
  'ticket.wa_link_changed': {
    from_status: p.one(WA_LINK_STATUSES),
    to_status: p.one(WA_LINK_STATUSES),
    method: p.one(WA_LINK_METHODS),
  },
  'ticket.inspection_completed': { photos_count: p.int(), after_submit_s: p.int() },
  'ticket.inspection_exception_approved': { missing_photos_count: p.int() },
  'ticket.manually_reconciled': {
    target_status: p.one(MANUAL_RECONCILE_TARGET_STATUSES),
    from_status: p.one(TICKET_STATUSES),
    had_payment: p.bool(),
  },
  // §7.2 task and offer
  'task.created': { type: p.one(TASK_TYPES) },
  'task.offered': { round_no: p.int(), available_drivers: p.int() },
  'task.broadcast_opened': {
    round_no: p.int(),
    recipient_count: p.int(),
    eligible_accept_count: p.int(),
    eligible_reserve_count: p.int(),
    view_only_count: p.int(),
  },
  'task.broadcast_extended': { added_recipients: p.int() },
  'task.claimed': {
    mode: p.one(OFFER_MODES),
    round_no: p.int(),
    result: p.one(['accepted', 'assigned_waiting']),
    claim_latency_s: p.int(),
    offer_latency_s: p.int(),
  },
  'task.promoted': { waited_as_next_s: p.int() },
  'task.key_picked_up': { after_accept_s: p.int() },
  'task.started': { type: p.one(TASK_TYPES), after_claim_s: p.int() },
  'task.completed': { type: p.one(TASK_TYPES), duration_s: p.int() },
  'task.canceled': {
    type: p.one(TASK_TYPES),
    status_at_cancel: p.one([
      'queued',
      'offered',
      'broadcast',
      'assigned_waiting',
      'accepted',
      'in_progress',
    ]),
  },
  'task.withdrawn': {
    status_at_withdrawal: p.one(['assigned_waiting', 'accepted']),
    key_was_picked_up: p.bool(),
  },
  'task.reassigned': { from_status: p.one(TASK_STATUSES), target: p.one(['queue', 'driver']) },
  'task.escalated': {
    after_s: p.int(),
    mode_at_escalation: p.one(['none', 'single', 'broadcast']),
    on_duty_drivers: p.int(),
  },
  'offer.reminded': { mode: p.one(OFFER_MODES), round_no: p.int() },
  'offer.expired': {
    mode: p.one(OFFER_MODES),
    round_no: p.int(),
    next_action: p.one(['next_single', 'broadcast']),
  },
  'offer.revoked': { mode: p.one(OFFER_MODES), close_reason: p.one(OFFER_REVOKE_REASONS) },
  // §7.3 driver and custody
  'driver.duty_started': {
    audio_test_result: p.one([...AUDIO_TEST_RESULTS, 'none']),
    notification_permission: p.one(NOTIFICATION_PERMISSIONS),
    display_mode: p.one(DISPLAY_MODES),
    platform: p.one(DEVICE_PLATFORMS),
  },
  'driver.break_started': {},
  'driver.break_ended': { break_duration_s: p.int() },
  'driver.duty_ended': {
    duty_duration_s: p.int(),
    end_reason: p.one(DUTY_END_REASONS),
    tasks_completed: p.int(),
  },
  'driver.availability_changed': { from_state: p.one(DRIVER_STATES), to_state: p.one(DRIVER_STATES) },
  'driver.connection_changed': {
    from: p.one(CONNECTION_STATES),
    to: p.one(CONNECTION_STATES),
    had_custody: p.bool(),
    had_active_task: p.bool(),
  },
  'driver.transfer_requested': { scheduled_in_s: p.int() },
  'driver.transfer_blocked': { blocker_types: p.list(['vehicle', 'key', 'active_task']) },
  'driver.transferred': {},
  'driver.disabled': {},
  'driver.enabled': {},
  'custody.changed': {
    subject: p.one(CUSTODY_SUBJECTS),
    custody_reason: p.one(CUSTODY_REASONS),
    from_holder_type: p.one(CUSTODY_HOLDER_TYPES),
    to_holder_type: p.one(CUSTODY_HOLDER_TYPES),
  },
  // §7.4 handover and payment
  'handover.code_issued': { resend_no: p.int() },
  'handover.code_attempt_failed': { attempt_no: p.int(), attempts_left: p.int() },
  'handover.code_locked': {},
  'handover.completed': { verification_method: p.one(DELIVERY_VERIFICATION), failed_attempts: p.int() },
  'handover.exception_approved': { had_payment: p.bool() },
  'payment.recorded': {
    method: p.one(PAYMENT_METHODS),
    amount_halalas: p.int(),
    source: p.one(['separate', 'handover', 'exception', 'reconcile', 'replacement']),
  },
  'payment.reversed': {
    method: p.one(PAYMENT_METHODS),
    amount_halalas: p.int(),
    with_replacement: p.bool(),
    after_cash_handover: p.bool(),
  },
  'payment.waived': { amount_halalas: p.int() },
  'cash.handover_recorded': {
    amount_halalas: p.int(),
    expected_halalas: p.int(),
    difference_halalas: p.signed(),
    linked_payments_count: p.int(),
  },
  // §7.5 alerts, incidents, event, shift
  'alert.raised': { type: p.one(ALERT_TYPES), severity: p.one(ALERT_SEVERITIES) },
  'alert.acknowledged': { type: p.one(ALERT_TYPES), ack_after_s: p.int() },
  'alert.resolved': { type: p.one(ALERT_TYPES), resolved_by_system: p.bool(), open_duration_s: p.int() },
  'incident.opened': {
    type: p.one(INCIDENT_TYPES),
    severity: p.one(INCIDENT_SEVERITIES),
    auto_created: p.bool(),
  },
  'incident.updated': { type: p.one(INCIDENT_TYPES), status: p.one(INCIDENT_STATUSES) },
  'incident.resolved': { type: p.one(INCIDENT_TYPES), open_duration_s: p.int() },
  'event.opened': { pricing_mode: p.one(PRICING_MODES) },
  'event.closing_started': { open_tickets: p.int() },
  'event.closed': {
    tickets_total: p.int(),
    delivered: p.int(),
    voided: p.int(),
    reparked_cycles: p.int(),
    canceled_cycles: p.int(),
    closing_duration_s: p.int(),
  },
  'shift.opened': {},
  'shift.closed': { duty_sessions_count: p.int() },
  // §7.6 WhatsApp
  'wa.inbound_received': {
    kind: p.one(['text', 'button', 'interactive', 'other']),
    matched: p.one(['action_token', 'link_code', 'opt_out', 'none']),
  },
  'wa.button_pressed': {
    result: p.one(['request_created', 'status_reply', 'rejected_sender', 'rejected_stale', 'ticket_closed']),
  },
  'wa.message_status_changed': {
    purpose: p.one(WA_MESSAGE_IDS),
    status: p.one(['sent', 'delivered', 'read', 'failed']),
    error_code: p.providerCode(),
    since_queued_ms: p.int(),
  },
  'wa.channel_health_changed': { from: p.one(WA_HEALTH_STATUSES), to: p.one(WA_HEALTH_STATUSES) },
  'wa.customer_opted_out': {},
} as const satisfies Record<DomainEventType, z.ZodRawShape>;

const serverSchemas = new Map<string, z.ZodType<Record<string, unknown>>>(
  DOMAIN_EVENT_TYPES.map((t) => [t, z.strictObject(SERVER_ANALYTICS_PROPERTIES[t])]),
);

/** Strict properties schema of a server analytics event. */
export function serverAnalyticsSchema(type: DomainEventType): z.ZodType<Record<string, unknown>> {
  return serverSchemas.get(type)!;
}

/** Server analytics names in canon order. */
export const SERVER_ANALYTICS_NAMES: readonly string[] = DOMAIN_EVENT_TYPES.map(analyticsName);

// ---------------------------------------------------------------------------------------------
// §8 Client measurements (POST /v1/telemetry)
// ---------------------------------------------------------------------------------------------

/** Property allow-list of every client measurement (15 §8). */
export const CLIENT_TELEMETRY_PROPERTIES = {
  app_started: {
    display_mode: p.one(DISPLAY_MODES),
    platform: p.one(DEVICE_PLATFORMS),
    browser_family: p.one(['safari', 'chrome', 'samsung', 'firefox', 'edge', 'other']),
    browser_major: p.int(),
  },
  audio_test_completed: {
    result: p.one(AUDIO_TEST_RESULTS),
    audio_api: p.one(['web_audio', 'html_audio']),
    context: p.one(['duty_start', 'account']),
  },
  audio_blocked_detected: { sound: p.one(SOUND_IDS), recovered_by_tap: p.bool() },
  notification_permission_changed: {
    from: p.one(NOTIFICATION_PERMISSIONS),
    to: p.one(NOTIFICATION_PERMISSIONS),
    context: p.one(['duty_start', 'account', 'banner']),
  },
  push_subscription_changed: {
    status: p.one(['subscribed', 'unsubscribed', 'failed']),
    error_name: p.one(['not_allowed', 'abort', 'network', 'invalid_state', 'unknown']),
  },
  push_notification_clicked: { kind: p.one(PUSH_NOTIFICATION_TYPES), age_ms: p.int() },
  pwa_installed: {
    platform: p.one(DEVICE_PLATFORMS),
    method: p.one(['install_prompt', 'ios_manual', 'detected_standalone']),
  },
  connection_changed: {
    from: p.one(CONNECTION_STATES),
    to: p.one(CONNECTION_STATES),
    cause: p.one(['ws_disconnect', 'navigator_offline', 'heartbeat_timeout', 'recovered']),
    offline_ms: p.int(),
  },
  sync_completed: {
    sync_reason: p.one(['startup', 'reconnect', 'visibility', 'sync_required', 'manual']),
    duration_ms: p.int(),
    stale_ms: p.int(),
    changed: p.bool(),
  },
  offer_card_seen: {
    offer_id: z.guid(),
    mode: p.one(OFFER_MODES),
    via: p.one(['ws', 'push', 'sync']),
    receive_latency_ms: p.signed(),
    eligible_as: p.one(OFFER_ELIGIBILITIES),
  },
  offer_card_removed: {
    offer_id: z.guid(),
    removal_reason: p.one(['claimed_elsewhere', 'expired', 'accepted', 'revoked']),
    visible_ms: p.int(),
  },
  ui_error_shown: {
    error_code: p.one(ERROR_CODES),
    screen: p.one(STAFF_SCREEN_IDS),
    http_status: z.number().int().min(100).max(599).nullable().optional(),
    presentation: p.one(['toast', 'inline', 'dialog', 'banner']),
  },
  page_hidden_during_duty: { hidden_ms: p.int(), had_active_task: p.bool(), had_open_offer: p.bool() },
  wake_lock_changed: { supported: p.bool(), state: p.one(['acquired', 'released', 'failed']) },
  form_draft_restored: { screen: p.one(['D-05', 'D-06', 'D-08', 'D-11']), age_ms: p.int() },
  app_update_applied: { from_version: p.version(), to_version: p.version() },
} as const satisfies Record<string, z.ZodRawShape>;

export type ClientTelemetryName = keyof typeof CLIENT_TELEMETRY_PROPERTIES;
export const CLIENT_TELEMETRY_NAMES = Object.keys(CLIENT_TELEMETRY_PROPERTIES) as ClientTelemetryName[];

const clientSchemas = new Map<string, z.ZodType<Record<string, unknown>>>(
  CLIENT_TELEMETRY_NAMES.map((n) => [n, z.strictObject(CLIENT_TELEMETRY_PROPERTIES[n])]),
);

export function isClientTelemetryName(name: string): name is ClientTelemetryName {
  return clientSchemas.has(name);
}

/** Strict properties schema of a client measurement. */
export function clientTelemetrySchema(name: ClientTelemetryName): z.ZodType<Record<string, unknown>> {
  return clientSchemas.get(name)!;
}

// ---------------------------------------------------------------------------------------------
// §9 POST /v1/telemetry
// ---------------------------------------------------------------------------------------------

/** 15 §9.3 limits. */
export const TELEMETRY_LIMITS = {
  /** events per batch */
  maxEvents: 50,
  /** request body bytes */
  maxBytes: 64 * 1024,
  /** events per device and minute (RATE_LIMITED beyond) */
  perDevicePerMinute: 120,
  /** `occurred_at` may be up to 24 h before the server time … */
  pastWindowMs: 24 * 60 * 60 * 1000,
  /** … and up to 5 minutes after it */
  futureWindowMs: 5 * 60 * 1000,
} as const;

/** One event of a batch (`TelemetryEvent` in 07_openapi plus the 15 §9.1 context fields). */
export const TelemetryEventSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  occurred_at: z.iso.datetime({ offset: true }),
  /** client sequence number (stored as `properties.client_seq`) */
  seq: nonNegative().optional(),
  screen: z.enum(STAFF_SCREEN_IDS).nullable().optional(),
  task_id: z.guid().nullable().optional(),
  ticket_id: z.guid().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/**
 * Body of `POST /v1/telemetry` (07_openapi). Events are validated one by one by the server: a rejected
 * event is dropped without failing the batch (15 §9.2), so the batch schema keeps them opaque.
 */
export const TelemetryBatchSchema = z.strictObject({
  app_version: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[\x21-\x7e]+$/),
  device_id: z.guid().nullable().optional(),
  client_session_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .nullable()
    .optional(),
  events: z.array(z.unknown()).min(1).max(TELEMETRY_LIMITS.maxEvents),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

// ---------------------------------------------------------------------------------------------
// PII value scan (15 §15 item 3) and event validation shared by the client and the server
// ---------------------------------------------------------------------------------------------

const PHONE_LIKE = /^(?:\+?9665[0-9]{8}|05[0-9]{8}|5[0-9]{8})$/;
const SIX_DIGITS = /^[0-9]{6}$/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
/**
 * Keys whose values are provider (Meta) numeric error codes, many of them six digits (`131026`): the
 * six-digit rule does not apply to them (15 §7.6); the phone and Arabic rules still do.
 */
const PROVIDER_CODE_KEYS: ReadonlySet<string> = new Set(['error_code']);

/** Dotted paths of string values that look like a Saudi phone, a 6-digit code or carry Arabic text. */
export function findPiiValues(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const v = value.trim();
    const key = prefix.split('.').at(-1) ?? '';
    const sixDigits = SIX_DIGITS.test(v) && !PROVIDER_CODE_KEYS.has(key);
    return PHONE_LIKE.test(v) || sixDigits || ARABIC.test(v) ? [prefix || '(value)'] : [];
  }
  if (typeof value !== 'object') return [];
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return entries.flatMap(([k, v]) => findPiiValues(v, prefix ? `${prefix}.${k}` : k, depth + 1));
}

export type TelemetryRejectReason =
  'invalid_event' | 'unknown_name' | 'denied_property' | 'invalid_properties' | 'pii_value';

export type ParsedTelemetryEvent =
  | { ok: true; event: TelemetryEvent & { name: ClientTelemetryName }; properties: Record<string, unknown> }
  | { ok: false; reason: TelemetryRejectReason; name?: string };

/**
 * Validates one client event against the catalog (15 §9.3): known name, strict properties, no
 * denylisted key, no PII-looking value. Time window and device checks are the server's.
 */
export function parseTelemetryEvent(raw: unknown): ParsedTelemetryEvent {
  const shape = TelemetryEventSchema.safeParse(raw);
  if (!shape.success) {
    const name = (raw as { name?: unknown } | null)?.name;
    return { ok: false, reason: 'invalid_event', name: typeof name === 'string' ? name : undefined };
  }
  const event = shape.data;
  if (!isClientTelemetryName(event.name)) return { ok: false, reason: 'unknown_name', name: event.name };
  const props = event.properties ?? {};
  if (Object.keys(props).some(isDeniedAnalyticsKey))
    return { ok: false, reason: 'denied_property', name: event.name };
  const parsed = clientTelemetrySchema(event.name).safeParse(props);
  if (!parsed.success) return { ok: false, reason: 'invalid_properties', name: event.name };
  if (findPiiValues(parsed.data).length) return { ok: false, reason: 'pii_value', name: event.name };
  return {
    ok: true,
    event: event as TelemetryEvent & { name: ClientTelemetryName },
    properties: parsed.data,
  };
}
