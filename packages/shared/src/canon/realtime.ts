/**
 * Realtime payload contracts (file 07 §4.2–§4.3, 11 §9.2) for the messages published by the
 * notifications module: `ticket.updated`, `sync.required`, `channel.status`, `incident.updated`. Schema
 * names follow the 07 components they mirror (`TicketSummary`, `Plate`, `UserRef`, `Incident`); every
 * payload carries `cause`, the domain event (or timer) that produced it.
 *
 * The payload schemas are strict: a field outside the allow-list of 09 §5 (a phone, a key slot, a spot, a
 * code) fails the contract.
 */
import { z } from 'zod';
import {
  ActorTypeSchema,
  AggregateTypeSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  IncidentTypeSchema,
  PaymentStatusSchema,
  TicketChannelSchema,
  TicketStatusSchema,
  WaHealthStatusSchema,
  WaLinkStatusSchema,
} from './enums.js';
import { DomainEventTypeSchema, JobTypeSchema, type WsServerEvent } from './events.js';

const uuid = z.guid();
const isoDateTime = z.iso.datetime({ offset: true });

/** `UserRef` (07). */
export const UserRefSchema = z.object({
  id: uuid,
  full_name: z.string(),
  employee_code: z.string().optional(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

/** `Plate` (07). */
export const PlateSchema = z.object({
  country: z.string(),
  digits: z
    .string()
    .regex(/^[0-9]{1,4}$/)
    .nullable()
    .optional(),
  letters_ar: z.string().nullable().optional(),
  letters_en: z.string().nullable().optional(),
  raw: z.string().nullable().optional(),
  display: z.string(),
});
export type Plate = z.infer<typeof PlateSchema>;

/** `TicketSummary` (07): the minimal projection of 09 §5.1 — no phone, key, spot, holder or code. */
export const TicketSummarySchema = z.strictObject({
  id: uuid,
  display_number: z.number().int().min(1),
  event_id: uuid,
  event_name_ar: z.string().optional(),
  venue_id: uuid,
  venue_name_ar: z.string().optional(),
  status: TicketStatusSchema,
  channel: TicketChannelSchema,
  plate: PlateSchema,
  // DEC-642: `type` draws the car next to the plate (optional: older payloads have none)
  vehicle: z
    .object({
      make: z.string().nullable(),
      color: z.string().nullable(),
      type: z.string().nullable().optional(),
    })
    .optional(),
  wa_link_status: WaLinkStatusSchema,
  payment_status: PaymentStatusSchema,
  requested_at: isoDateTime.nullable().optional(),
  /** an early request waiting for the parking to finish (DEC-13) */
  pending_retrieval_at: isoDateTime.nullable().optional(),
  created_at: isoDateTime.optional(),
  version: z.number().int().min(1),
});
export type TicketSummary = z.infer<typeof TicketSummarySchema>;

/** `Incident` (07). */
export const IncidentSchema = z.strictObject({
  id: uuid,
  venue_id: uuid,
  event_id: uuid.nullable().optional(),
  ticket_id: uuid.nullable().optional(),
  type: IncidentTypeSchema,
  status: IncidentStatusSchema,
  severity: IncidentSeveritySchema,
  description: z.string(),
  opened_by: UserRefSchema,
  owner: UserRefSchema.nullable().optional(),
  resolution: z.string().nullable().optional(),
  resolved_by: UserRefSchema.nullable().optional(),
  resolved_at: isoDateTime.nullable().optional(),
  closed_at: isoDateTime.nullable().optional(),
  version: z.number().int().min(1),
  created_at: isoDateTime,
  updated_at: isoDateTime.optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

/** `cause` of a realtime message: a canon §7.1 domain event, or the §7.2 timer that changed the state. */
export const RealtimeCauseSchema = z.union([DomainEventTypeSchema, JobTypeSchema]);

/** The pending QR-link confirmation shown to the creator in D-07 (masked number only, 09 §5.1). */
export const WaLinkPendingSchema = z.strictObject({
  link_code_id: uuid,
  inbound_phone_masked: z.string(),
  received_at: isoDateTime,
});

/** Delivery state of a WhatsApp message (D-07 / S-03; drivers see W-01 and W-05 only, 09 §5.1). */
export const TicketMessageStatusSchema = z.strictObject({
  id: uuid,
  purpose: z.string().nullable(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  status_rank: z.number().int(),
});

/** `ticket.updated` (07 §4.3): `TicketSummary` + `cause` (+ `wa_link_pending`, + `message`). */
export const TicketUpdatedPayloadSchema = TicketSummarySchema.extend({
  cause: RealtimeCauseSchema,
  wa_link_pending: WaLinkPendingSchema.nullable().optional(),
  message: TicketMessageStatusSchema.optional(),
});
export type TicketUpdatedPayload = z.infer<typeof TicketUpdatedPayloadSchema>;

/** Snapshot to fetch again (11 §8.9): `events` (event list), `home` (D-04 / shift), `me` (settings). */
export const SYNC_SCOPES = ['events', 'home', 'me'] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];
export const SyncScopeSchema = z.enum(SYNC_SCOPES);

/** `sync.required` (07 §4.3 `{reason}`; 11 §8.9 `scope`). */
export const SyncRequiredPayloadSchema = z.strictObject({
  reason: z.string().min(1),
  scope: SyncScopeSchema.optional(),
  cause: RealtimeCauseSchema.optional(),
  event_id: uuid.optional(),
  shift_id: uuid.optional(),
  dispatch_pool_id: uuid.optional(),
});
export type SyncRequiredPayload = z.infer<typeof SyncRequiredPayloadSchema>;

/** `channel.status` (07 §4.3): `{whatsapp: WaHealthStatus, changed_at}`. */
export const ChannelStatusPayloadSchema = z.strictObject({
  cause: z.literal('wa.channel_health_changed'),
  whatsapp: WaHealthStatusSchema,
  changed_at: isoDateTime,
});
export type ChannelStatusPayload = z.infer<typeof ChannelStatusPayloadSchema>;

/** `incident.updated` (07 §4.3): `Incident` + `cause`. */
export const IncidentUpdatedPayloadSchema = IncidentSchema.extend({
  cause: z.enum(['incident.opened', 'incident.updated', 'incident.resolved']),
});
export type IncidentUpdatedPayload = z.infer<typeof IncidentUpdatedPayloadSchema>;

/** Payload schema per realtime event, for the events the notifications module publishes. */
export const REALTIME_PAYLOAD_SCHEMAS = {
  'ticket.updated': TicketUpdatedPayloadSchema,
  'sync.required': SyncRequiredPayloadSchema,
  'channel.status': ChannelStatusPayloadSchema,
  'incident.updated': IncidentUpdatedPayloadSchema,
} as const satisfies Partial<Record<WsServerEvent, z.ZodType>>;
export type PublishedRealtimeEvent = keyof typeof REALTIME_PAYLOAD_SCHEMAS;

/**
 * The same payloads for a client to parse (review:8): unknown top-level keys are dropped instead of failing the
 * frame, so an additive field the server ships later (07: new optional fields) does not make an installed PWA
 * bundle reject every frame and resync until it updates. The strict REALTIME_PAYLOAD_SCHEMAS stay the server's
 * contract (09 §5.1: no field outside the projection is published), checked by the contract tests.
 */
export const REALTIME_CLIENT_PAYLOAD_SCHEMAS = {
  'ticket.updated': z.object(TicketUpdatedPayloadSchema.shape),
  'sync.required': z.object(SyncRequiredPayloadSchema.shape),
  'channel.status': z.object(ChannelStatusPayloadSchema.shape),
  'incident.updated': z.object(IncidentUpdatedPayloadSchema.shape),
} as const satisfies Record<PublishedRealtimeEvent, z.ZodType>;

/**
 * The frame a socket receives (canon §7 envelope, 07 §4.2) for one realtime event. `aggregate` is the
 * entity whose state changed; its `version` is null for entities without a version column (the channel).
 */
export function realtimeEnvelopeSchema<E extends WsServerEvent, P extends z.ZodType>(event: E, payload: P) {
  return z.strictObject({
    id: uuid,
    type: z.literal(event),
    occurred_at: isoDateTime,
    org_id: uuid,
    venue_id: uuid.nullable(),
    dispatch_pool_id: uuid.nullable(),
    event_id: uuid.nullable(),
    aggregate: z
      .object({ type: AggregateTypeSchema, id: uuid, version: z.number().int().nullable() })
      .nullable(),
    actor: z.object({ type: ActorTypeSchema, id: z.string().nullable() }),
    payload,
  });
}
