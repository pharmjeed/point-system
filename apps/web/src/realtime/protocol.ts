import { z } from 'zod';
import {
  AlertSeveritySchema,
  AlertStatusSchema,
  DriverStateSchema,
  OfferEligibilitySchema,
  OfferModeSchema,
} from '@shared/canon/enums';
import { WS_CLIENT_EVENTS, WS_SERVER_EVENTS, type WsServerEvent } from '@shared/canon/events';
import {
  ChannelStatusPayloadSchema,
  IncidentUpdatedPayloadSchema,
  realtimeEnvelopeSchema,
  SyncRequiredPayloadSchema,
  TicketUpdatedPayloadSchema,
} from '@shared/canon/realtime';
import type {
  Alert,
  DriverLive,
  DriverState,
  Incident,
  OfferCard,
  Task,
  TaskCard,
  TicketSummary,
  WaHealthStatus,
} from '@/api/types';

/**
 * The socket frames of 07 §4.2–§4.3, parsed with the canon's zod schemas (`@point/shared`): the envelope is
 * `realtimeEnvelopeSchema` (canon §7), and the payloads the notifications module publishes use their shared
 * schemas (`ticket.updated`, `sync.required`, `channel.status`, `incident.updated`). The dispatch payloads
 * (`task.*`, `offer.*`, `driver.state_changed`) and `alert.*` carry 07 components (`OfferCard`, `TaskCard`,
 * `Task`, `DriverLive`, `Alert`) that have no shared schema yet: their identifying fields are checked here and
 * the rest passes through. A frame that fails its schema is never applied: the client asks for a full sync
 * instead (11 §9.4).
 */
export { WS_CLIENT_EVENTS, WS_SERVER_EVENTS };
export type { WsServerEvent };

const id = z.guid();
const iso = z.iso.datetime({ offset: true });

const OfferCardPayload = z.looseObject({
  offer_id: id,
  task_id: id,
  mode: OfferModeSchema,
  eligible_as: OfferEligibilitySchema,
  expires_at: iso.nullable().optional(),
  reminder_at: iso.nullable().optional(),
  server_time: iso,
  requested_at: iso,
  ticket: z.looseObject({ display_number: z.number().int().min(1) }),
  can_accept: z.boolean(),
  can_reserve_next: z.boolean(),
});

/** `task.updated` for the assignee: a `TaskCard`. */
const TaskCardPayload = z.looseObject({
  task: z.looseObject({ id, status: z.string(), type: z.string(), version: z.number().int() }),
  ticket: z.looseObject({
    id,
    display_number: z.number().int(),
    status: z.string(),
    version: z.number().int(),
  }),
});

/** `task.updated` for supervisors, and for a driver whose task was withdrawn or reassigned away: a `Task`. */
const TaskViewPayload = z.looseObject({
  id,
  ticket_id: id,
  status: z.string(),
  type: z.string(),
  version: z.number().int(),
});

const AlertPayload = z.looseObject({
  id,
  venue_id: id,
  type: z.string(),
  severity: AlertSeveritySchema,
  status: AlertStatusSchema,
  raised_at: iso,
});

const PAYLOADS = {
  'task.offered': OfferCardPayload,
  'task.broadcast': OfferCardPayload,
  'task.claimed': z.looseObject({
    task_id: id,
    offer_ids: z.array(id),
    result: z.string().nullable().optional(),
    claimed_by: z.looseObject({ id }).nullable(),
  }),
  'task.updated': z.union([TaskCardPayload, TaskViewPayload]),
  'offer.reminder': z.looseObject({ offer_id: id, task_id: id }),
  'offer.closed': z.looseObject({
    offer_id: id,
    task_id: id,
    close_reason: z.string().nullable().optional(),
  }),
  'ticket.updated': TicketUpdatedPayloadSchema,
  'driver.state_changed': z.looseObject({
    driver: z.looseObject({ id }),
    driver_state: DriverStateSchema,
  }),
  'alert.raised': AlertPayload,
  'alert.updated': AlertPayload,
  'incident.updated': IncidentUpdatedPayloadSchema,
  'channel.status': ChannelStatusPayloadSchema,
  'sync.required': SyncRequiredPayloadSchema,
  'session.revoked': z.looseObject({ reason: z.string() }),
} satisfies Record<WsServerEvent, z.ZodType>;

type EnvelopeSchemas = { [E in WsServerEvent]: ReturnType<typeof realtimeEnvelopeSchema> };
let envelopes: EnvelopeSchemas | null = null;
function schemaOf(event: WsServerEvent) {
  envelopes ??= Object.fromEntries(
    WS_SERVER_EVENTS.map((e) => [e, realtimeEnvelopeSchema(e, PAYLOADS[e])]),
  ) as unknown as EnvelopeSchemas;
  return envelopes[event];
}

export interface EnvelopeMeta {
  id: string;
  occurred_at: string;
  venue_id: string | null;
  dispatch_pool_id: string | null;
  event_id: string | null;
  aggregate: { type: string; id: string; version: number | null } | null;
}

interface Cause {
  cause?: string;
}

/** A server event the client understands, with the payload typed as the 07 component it carries. */
export type ServerEvent = EnvelopeMeta &
  (
    | { type: 'task.offered' | 'task.broadcast'; payload: OfferCard & Cause }
    | {
        type: 'task.claimed';
        payload: Cause & {
          task_id: string;
          offer_ids: string[];
          result?: string | null;
          claimed_by: { id: string; full_name?: string } | null;
        };
      }
    | { type: 'task.updated'; payload: (TaskCard | Task) & Cause }
    | { type: 'offer.reminder'; payload: Cause & { offer_id: string; task_id: string } }
    | {
        type: 'offer.closed';
        payload: Cause & { offer_id: string; task_id: string; close_reason?: string | null };
      }
    | { type: 'ticket.updated'; payload: TicketSummary & Cause & Record<string, unknown> }
    | { type: 'driver.state_changed'; payload: DriverLive & Cause & { driver_state: DriverState } }
    | { type: 'alert.raised' | 'alert.updated'; payload: Alert & Cause }
    | { type: 'incident.updated'; payload: Incident & Cause }
    | { type: 'channel.status'; payload: Cause & { whatsapp: WaHealthStatus; changed_at: string } }
    | {
        type: 'sync.required';
        payload: Cause & { reason: string; scope?: 'events' | 'home' | 'me' };
      }
    | { type: 'session.revoked'; payload: Cause & { reason: string } }
  );

export type ParseResult =
  | { ok: true; event: ServerEvent }
  | { ok: false; type: string; id: string | null; reason: 'unknown_event' | 'invalid' };

const isServerEvent = (type: string): type is WsServerEvent =>
  (WS_SERVER_EVENTS as readonly string[]).includes(type);

/** Validates one frame received under the socket event name `type`. */
export function parseServerEvent(type: string, frame: unknown): ParseResult {
  const frameId =
    frame && typeof frame === 'object' && typeof (frame as { id?: unknown }).id === 'string'
      ? ((frame as { id: string }).id as string)
      : null;
  if (!isServerEvent(type)) return { ok: false, type, id: frameId, reason: 'unknown_event' };
  const parsed = schemaOf(type).safeParse(frame);
  if (!parsed.success) return { ok: false, type, id: frameId, reason: 'invalid' };
  return { ok: true, event: parsed.data as unknown as ServerEvent };
}

/** `client.heartbeat` (07 §4.4; canon §7.3). */
export interface HeartbeatBody {
  visible: boolean;
  audio_unlocked: boolean;
  last_event_id: string | null;
  app_version: string;
}

/** The ack of `client.heartbeat` and the reply of `POST /v1/me/heartbeat`. */
export interface HeartbeatAck {
  server_time: string;
  connection_state: 'online' | 'uncertain' | 'offline' | null;
  sync_required: boolean;
}

const HeartbeatAckSchema = z.looseObject({
  data: z.looseObject({
    server_time: iso,
    connection_state: z.enum(['online', 'uncertain', 'offline']).nullable(),
    sync_required: z.boolean(),
  }),
});

/** `{data: HeartbeatAck}` or null for an error ack (`{error: {code}}`) or anything else. */
export function parseHeartbeatAck(ack: unknown): HeartbeatAck | null {
  const parsed = HeartbeatAckSchema.safeParse(ack);
  return parsed.success ? (parsed.data.data as HeartbeatAck) : null;
}
