/**
 * The customer app's live channels (V2-015 realtime, V2-016 push; docs/v2/01 §3, docs/v2/05 §1 «الاتصال الفوري
 * للعميل»; DEC-519, DEC-520): device registration for push, the shape of what reaches the lock screen, and the
 * customer Socket.IO namespace.
 */
import { z } from 'zod';
import { TicketStatusSchema } from '../canon/enums.js';

const iso = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------------------------
// Push registration — `POST /v1/customer/devices`
// ---------------------------------------------------------------------------------------------

/** An Expo push token as `expo-notifications` returns it (`getExpoPushTokenAsync`). */
export const EXPO_PUSH_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,160}\]$/;

/**
 * The push token of the signed-in device (one per session): a token registers or replaces the session's one, `null`
 * removes it (C-19 «الإشعارات» off). Sign-out and account deletion drop it on the server.
 */
export const CustomerDeviceBodySchema = z.strictObject({
  provider: z.literal('expo'),
  push_token: z.string().regex(EXPO_PUSH_TOKEN_RE).nullable(),
});
export type CustomerDeviceBody = z.infer<typeof CustomerDeviceBodySchema>;

/** `POST /v1/customer/devices` → `data`: never echoes the token. */
export const CustomerDeviceSchema = z.object({
  push_registered: z.boolean(),
  provider: z.literal('expo').nullable(),
  registered_at: iso.nullable(),
});
export type CustomerDevice = z.infer<typeof CustomerDeviceSchema>;

// ---------------------------------------------------------------------------------------------
// Push messages (docs/v2/01 §3)
// ---------------------------------------------------------------------------------------------

/** The kinds of customer pushes; the subscription ones are reserved for V4 (V2-03x) and never sent before. */
export const CUSTOMER_PUSH_KINDS = [
  'car_received',
  'request_accepted',
  'car_ready',
  'pickup_reminder',
  'subscription_renewal',
  'subscription_payment_failed',
  'subscription_expired',
] as const;
export type CustomerPushKind = (typeof CUSTOMER_PUSH_KINDS)[number];

/**
 * The `data` of a customer push: what the app reads to open the right screen. Opaque ids only (DEC-23, DEC-520): the
 * ticket id is a random UUID worth nothing without the account's own session — no plate, spot, key, code or name.
 */
export const CustomerPushDataSchema = z.strictObject({
  type: z.literal('visit'),
  kind: z.enum(CUSTOMER_PUSH_KINDS),
  visit_id: z.uuid(),
});
export type CustomerPushData = z.infer<typeof CustomerPushDataSchema>;

// ---------------------------------------------------------------------------------------------
// Realtime — Socket.IO on WS_PATH (`/ws`), namespace `/customer`
// ---------------------------------------------------------------------------------------------

/**
 * The customer namespace (DEC-520): the handshake carries `Authorization: Bearer <access token>` (a native client
 * sets it as a header; no cookie is read), the server joins the socket to its account's room only.
 */
export const CUSTOMER_REALTIME_NAMESPACE = '/customer';
export const customerRoom = (accountId: string) => `customer:${accountId}`;

/** Server → app events of the customer namespace. */
export const CUSTOMER_REALTIME_EVENTS = ['visit.updated', 'subscription.updated', 'session.revoked'] as const;
export type CustomerRealtimeEvent = (typeof CUSTOMER_REALTIME_EVENTS)[number];

/**
 * `visit.updated`: a minimal projection — the app reads `GET /v1/customer/visits/{ticketId}` again (the server is the
 * source of truth; at-most-once delivery, the app also re-reads on every (re)connection).
 */
export const CustomerVisitUpdatedSchema = z.object({
  ticket_id: z.uuid(),
  status: TicketStatusSchema,
  open: z.boolean(),
});
export type CustomerVisitUpdated = z.infer<typeof CustomerVisitUpdatedSchema>;

/** `subscription.updated` (reserved for V4): the app reads its subscriptions again. */
export const CustomerSubscriptionUpdatedSchema = z.object({ subscription_id: z.uuid() });

/** The envelope of every customer realtime message (no organization, venue, pool or staff ids). */
export const CustomerRealtimeEnvelopeSchema = z.object({
  id: z.string(),
  type: z.enum(CUSTOMER_REALTIME_EVENTS),
  occurred_at: iso,
  payload: z.record(z.string(), z.unknown()),
});
export type CustomerRealtimeEnvelope = z.infer<typeof CustomerRealtimeEnvelopeSchema>;
