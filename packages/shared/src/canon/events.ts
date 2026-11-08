/**
 * Domain events (canon §7.1), deferred job types (§7.2), realtime events and rooms (§7.3) and the
 * shared event envelope (§7; file 11 §8.1; file 07 §4.2).
 */
import { z } from 'zod';
import type { ActorType, AggregateType } from './enums.js';
import { ActorTypeSchema, AggregateTypeSchema, ConnectionStateSchema } from './enums.js';

// ---------------------------------------------------------------------------------------------
// §7.1 Domain events (written to `outbox_events` in the same transaction as the change)
// ---------------------------------------------------------------------------------------------

export const TICKET_EVENT_TYPES = [
  'ticket.created',
  'ticket.intake_submitted',
  'ticket.parked',
  'ticket.retrieval_requested',
  'ticket.retrieval_requested_early',
  'ticket.assigned',
  'ticket.assigned_waiting',
  'ticket.retrieving',
  'ticket.ready',
  'ticket.delivered',
  'ticket.reparking',
  'ticket.retrieval_canceled',
  'ticket.voided',
  'ticket.customer_phone_changed',
  'ticket.wa_link_changed',
  'ticket.inspection_completed',
  'ticket.inspection_exception_approved',
  'ticket.manually_reconciled',
] as const;

export const TASK_EVENT_TYPES = [
  'task.created',
  'task.offered',
  'task.broadcast_opened',
  'task.broadcast_extended',
  'task.claimed',
  'task.promoted',
  'task.key_picked_up',
  'task.started',
  'task.completed',
  'task.canceled',
  'task.withdrawn',
  'task.reassigned',
  'task.escalated',
] as const;

export const OFFER_EVENT_TYPES = ['offer.reminded', 'offer.expired', 'offer.revoked'] as const;

export const DRIVER_EVENT_TYPES = [
  'driver.duty_started',
  'driver.break_started',
  'driver.break_ended',
  'driver.duty_ended',
  'driver.availability_changed',
  'driver.connection_changed',
  'driver.transfer_requested',
  'driver.transfer_blocked',
  'driver.transferred',
  'driver.disabled',
  'driver.enabled',
] as const;

export const CUSTODY_EVENT_TYPES = ['custody.changed'] as const;

export const HANDOVER_EVENT_TYPES = [
  'handover.code_issued',
  'handover.code_attempt_failed',
  'handover.code_locked',
  'handover.completed',
  'handover.exception_approved',
] as const;

export const PAYMENT_EVENT_TYPES = [
  'payment.recorded',
  'payment.reversed',
  'payment.waived',
  'cash.handover_recorded',
  // V2-022 (DEC-522): an online visit payment made the ticket collected (app_paid), and its full refund undid it
  'payment.online_paid',
  'payment.online_refunded',
] as const;

export const ALERT_INCIDENT_EVENT_TYPES = [
  'alert.raised',
  'alert.acknowledged',
  'alert.resolved',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
] as const;

/** Canceling a `draft` event is audit-only, without a domain event. */
export const EVENT_SHIFT_EVENT_TYPES = [
  'event.opened',
  'event.closing_started',
  'event.closed',
  'shift.opened',
  'shift.closed',
] as const;

export const WA_EVENT_TYPES = [
  'wa.inbound_received',
  'wa.button_pressed',
  'wa.message_status_changed',
  'wa.channel_health_changed',
  'wa.customer_opted_out',
] as const;

/** Every domain event type of canon §7.1, in canon order. */
export const DOMAIN_EVENT_TYPES = [
  ...TICKET_EVENT_TYPES,
  ...TASK_EVENT_TYPES,
  ...OFFER_EVENT_TYPES,
  ...DRIVER_EVENT_TYPES,
  ...CUSTODY_EVENT_TYPES,
  ...HANDOVER_EVENT_TYPES,
  ...PAYMENT_EVENT_TYPES,
  ...ALERT_INCIDENT_EVENT_TYPES,
  ...EVENT_SHIFT_EVENT_TYPES,
  ...WA_EVENT_TYPES,
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const DomainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

// ---------------------------------------------------------------------------------------------
// §7.2 Deferred job types (`outbox_events.type`). Every timer carries the entity `version` at
// scheduling time; on execution it is re-checked and a changed entity ends the timer without effect.
// ---------------------------------------------------------------------------------------------

export const JOB_TYPES = [
  'job.dispatch_pass',
  'job.dispatch_sweep',
  'job.offer_remind',
  'job.offer_expire',
  'job.broadcast_remind',
  'job.escalate_unaccepted',
  'job.next_task_wait_check',
  'job.ready_uncollected_check',
  'job.claim_code_expire',
  'job.link_code_expire',
  'job.transfer_activate',
  'job.wa_send',
  'job.wa_process_inbound',
  'job.push_send',
  'job.ws_publish',
  'job.heartbeat_sweep',
  'job.retention_purge',
  'job.export_generate',
  // V2 (V2-010, DEC-496): the customer app's sign-in code over WhatsApp, sent after COMMIT
  'job.customer_otp_send',
  // V2 (V2-021, DEC-512 … DEC-514): online payments — a gateway webhook processed once, a refund sent after COMMIT,
  // the daily reconciliation with the gateway
  'job.payment_webhook_process',
  'job.payment_refund_send',
  'job.payments_reconcile',
  'job.payment_method_token_delete',
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JobTypeSchema = z.enum(JOB_TYPES);

/** Anything that may appear in `outbox_events.type`. */
export const OUTBOX_EVENT_TYPES = [...DOMAIN_EVENT_TYPES, ...JOB_TYPES] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
export const OutboxEventTypeSchema = z.enum(OUTBOX_EVENT_TYPES);

// ---------------------------------------------------------------------------------------------
// §7.3 Realtime (Socket.IO on `/ws`)
// ---------------------------------------------------------------------------------------------

/** Server → client events. */
export const WS_SERVER_EVENTS = [
  'task.offered',
  'task.broadcast',
  'task.claimed',
  'task.updated',
  'offer.reminder',
  'offer.closed',
  'ticket.updated',
  'driver.state_changed',
  'alert.raised',
  'alert.updated',
  'incident.updated',
  'channel.status',
  'sync.required',
  'session.revoked',
] as const;
export type WsServerEvent = (typeof WS_SERVER_EVENTS)[number];
export const WsServerEventSchema = z.enum(WS_SERVER_EVENTS);

/** Client → server events. */
export const WS_CLIENT_EVENTS = ['client.heartbeat', 'client.offer_seen'] as const;
export type WsClientEvent = (typeof WS_CLIENT_EVENTS)[number];
export const WsClientEventSchema = z.enum(WS_CLIENT_EVENTS);

/** The Socket.IO path. */
export const WS_PATH = '/ws';

/**
 * Room name templates, exactly as canon §7.3. The server decides membership after its checks;
 * the client never chooses a room.
 */
export const ROOM_PATTERNS = [
  'user:{userId}',
  'pool:{poolId}:drivers',
  'venue:{venueId}:supervisors',
  'org:{orgId}:admins',
] as const;
export type RoomPattern = (typeof ROOM_PATTERNS)[number];

/** Room name helpers built from {@link ROOM_PATTERNS}. */
export const rooms = {
  user: (userId: string) => `user:${userId}` as const,
  poolDrivers: (poolId: string) => `pool:${poolId}:drivers` as const,
  venueSupervisors: (venueId: string) => `venue:${venueId}:supervisors` as const,
  orgAdmins: (orgId: string) => `org:${orgId}:admins` as const,
};
export type RoomName = ReturnType<(typeof rooms)[keyof typeof rooms]>;

/** `client.heartbeat` payload (sent every `heartbeat.interval_s`). */
export const ClientHeartbeatSchema = z.strictObject({
  visible: z.boolean(),
  audio_unlocked: z.boolean(),
  last_event_id: z.string().nullable().optional(),
  app_version: z.string().max(32).optional(),
});
export type ClientHeartbeat = z.infer<typeof ClientHeartbeatSchema>;

/** `POST /v1/me/heartbeat` body: the same fields plus `ws_connected`. */
export const HttpHeartbeatSchema = ClientHeartbeatSchema.extend({ ws_connected: z.boolean() });
export type HttpHeartbeat = z.infer<typeof HttpHeartbeatSchema>;

/** Ack of `client.heartbeat` (file 07 §4.4). */
export const ClientHeartbeatAckSchema = z.object({
  server_time: z.string(),
  connection_state: ConnectionStateSchema,
  sync_required: z.boolean(),
});
export type ClientHeartbeatAck = z.infer<typeof ClientHeartbeatAckSchema>;

/** `client.offer_seen` payload. */
export const ClientOfferSeenSchema = z.strictObject({ offer_id: z.guid() });
export type ClientOfferSeen = z.infer<typeof ClientOfferSeenSchema>;

// ---------------------------------------------------------------------------------------------
// §7 Event envelope (Outbox and WebSocket). For WebSocket, `type` is the realtime event name and
// `payload.cause` the causing domain event when there is one (file 07 §4.2).
// ---------------------------------------------------------------------------------------------

export interface EventEnvelope<P = Record<string, unknown>, T extends string = DomainEventType> {
  /** = `outbox_events.id` */
  id: string;
  type: T;
  /** ISO-8601 UTC */
  occurred_at: string;
  org_id: string;
  venue_id: string | null;
  dispatch_pool_id: string | null;
  /** The venue event (حفل), not a domain event. */
  event_id: string | null;
  aggregate: { type: AggregateType; id: string; version: number };
  actor: { type: ActorType; id: string | null };
  payload: P;
}

/** A realtime message: the same envelope with a {@link WsServerEvent} type. */
export type WsEnvelope<P = Record<string, unknown>> = EventEnvelope<P, WsServerEvent>;

const envelopeBase = {
  id: z.guid(),
  occurred_at: z.iso.datetime({ offset: true }),
  org_id: z.guid(),
  venue_id: z.guid().nullable(),
  dispatch_pool_id: z.guid().nullable(),
  event_id: z.guid().nullable(),
  aggregate: z.object({ type: AggregateTypeSchema, id: z.guid(), version: z.number().int() }),
  actor: z.object({ type: ActorTypeSchema, id: z.string().nullable() }),
};

/** zod schema of a domain-event envelope with a given payload schema. */
export function eventEnvelopeSchema<P extends z.ZodType>(payload: P) {
  return z.object({ ...envelopeBase, type: DomainEventTypeSchema, payload });
}

/** zod schema of a realtime envelope with a given payload schema. */
export function wsEnvelopeSchema<P extends z.ZodType>(payload: P) {
  return z.object({ ...envelopeBase, type: WsServerEventSchema, payload });
}
