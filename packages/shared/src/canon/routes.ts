/**
 * Every HTTP route of canon §9, in canon order. Rows written `GET / POST` in the canon are split
 * into one entry per method; path parameters keep the canon `{name}` form.
 *
 * `idempotent` = ✓ in canon §9: the `Idempotency-Key` header is required (`IDEMPOTENCY_KEY_REQUIRED`
 * otherwise). `idempotency` mirrors `x-idempotency` of docs/07_openapi.yaml (`optional` = the key is
 * honoured when sent). Both are verified against the canon and the OpenAPI file by test/routes.test.ts.
 *
 * Drives the boot-time guard check (every controller route must be listed here with its permission)
 * and the idempotency interceptor.
 */
import type { Permission } from './permissions.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * `public`: no session (login, MFA verify with an `mfa_token`, health).
 * `webhook`: WhatsApp webhook — `hub.verify_token` (GET) or `X-Hub-Signature-256` over the raw body (POST).
 * `internal`: internal network only (`/metrics`).
 */
export const NON_PERMISSION_GUARDS = ['public', 'webhook', 'internal'] as const;
export type NonPermissionGuard = (typeof NON_PERMISSION_GUARDS)[number];
export type RoutePermission = Permission | NonPermissionGuard;

export const IDEMPOTENCY_MODES = ['required', 'optional', 'none'] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

export const ROUTE_SECTIONS = ['9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '9.7', '9.8'] as const;
export type RouteSection = (typeof ROUTE_SECTIONS)[number];

/** `x-rate-limit-class` of docs/07_openapi.yaml; limits per class in 07 §1.9. */
export const RATE_LIMIT_CLASSES = [
  'auth',
  'command',
  'write',
  'read',
  'device',
  'export',
  'webhook',
  'health',
] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export interface RouteDef {
  method: HttpMethod;
  /** Canon path template, e.g. `/v1/tickets/{ticketId}/void`. */
  path: string;
  permission: RoutePermission;
  /** ✓ in canon §9 — `Idempotency-Key` required. */
  idempotent: boolean;
  idempotency: IdempotencyMode;
  /** Extra fields gated by another permission (`GET /v1/tickets/{ticketId}` + `ticket.read_full`). */
  fieldPermission?: Permission;
  section: RouteSection;
  /** Rate-limit class (07 §1.9, `x-rate-limit-class`): reads `read`, other methods `command`, except the listed ones. */
  rateLimitClass: RateLimitClass;
}

type Row = readonly [HttpMethod, string, RoutePermission, IdempotencyMode, RouteSection, Permission?];

// [method, path, permission, x-idempotency, canon section, field permission]
const ROWS: readonly Row[] = [
  // §9.1 Sign-in, session and device
  ['POST', '/v1/auth/login', 'public', 'none', '9.1'],
  ['POST', '/v1/auth/mfa/verify', 'public', 'none', '9.1'], // temporary MFA token
  ['POST', '/v1/auth/mfa/setup', 'auth.self', 'none', '9.1'],
  ['POST', '/v1/auth/mfa/confirm', 'auth.self', 'none', '9.1'],
  ['POST', '/v1/auth/secret/change', 'auth.self', 'none', '9.1'],
  ['POST', '/v1/auth/logout', 'auth.self', 'none', '9.1'],
  ['GET', '/v1/me', 'auth.self', 'none', '9.1'],
  ['GET', '/v1/me/home', 'duty.self', 'none', '9.1'],
  ['POST', '/v1/me/devices', 'auth.self', 'optional', '9.1'],
  ['PUT', '/v1/me/devices/{deviceId}', 'auth.self', 'optional', '9.1'],
  ['POST', '/v1/me/audio-test', 'auth.self', 'optional', '9.1'],
  ['POST', '/v1/me/duty/start', 'duty.self', 'required', '9.1'],
  ['POST', '/v1/me/duty/break', 'duty.self', 'required', '9.1'],
  ['POST', '/v1/me/duty/end', 'duty.self', 'required', '9.1'],
  ['POST', '/v1/me/heartbeat', 'auth.self', 'none', '9.1'],

  // §9.2 Intake and tickets
  ['POST', '/v1/tickets', 'ticket.intake', 'required', '9.2'],
  ['POST', '/v1/tickets/intake-pass', 'ticket.intake', 'required', '9.2'], // V2-013 (O-01, DEC-500)
  ['PATCH', '/v1/tickets/{ticketId}/intake', 'ticket.intake', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/media', 'ticket.intake', 'required', '9.2'],
  ['POST', '/v1/media/{mediaId}/complete', 'ticket.intake', 'required', '9.2'],
  ['GET', '/v1/media/{mediaId}/url', 'ticket.read_photos', 'none', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/submit-intake', 'ticket.intake', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/discard-draft', 'ticket.discard_empty_draft', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/void', 'ticket.void', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/inspection-exception', 'ticket.inspection_exception', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/whatsapp-link', 'wa.link', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/whatsapp-link/confirm', 'wa.link', 'required', '9.2'],
  ['PATCH', '/v1/tickets/{ticketId}/customer-phone', 'ticket.change_phone', 'required', '9.2'],
  ['POST', '/v1/tickets/{ticketId}/reveal-phone', 'ticket.reveal_phone', 'required', '9.2'],
  ['GET', '/v1/tickets', 'ticket.read_minimal', 'none', '9.2'],
  ['GET', '/v1/tickets/{ticketId}', 'ticket.read_minimal', 'none', '9.2', 'ticket.read_full'],
  ['GET', '/v1/tickets/{ticketId}/timeline', 'ticket.read_full', 'none', '9.2'],

  // §9.3 Parking, retrieval and handover
  ['POST', '/v1/tasks/{taskId}/complete-parking', 'task.execute', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/retrievals', 'retrieval.request_on_behalf', 'required', '9.3'],
  ['POST', '/v1/retrieval-cycles/{cycleId}/cancel', 'retrieval.cancel', 'required', '9.3'],
  ['POST', '/v1/task-offers/{offerId}/accept', 'offer.accept', 'required', '9.3'],
  ['POST', '/v1/tasks/{taskId}/key-pickup', 'task.execute', 'required', '9.3'],
  ['POST', '/v1/tasks/{taskId}/start-retrieval', 'task.execute', 'required', '9.3'],
  ['POST', '/v1/tasks/{taskId}/ready', 'task.execute', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/handover', 'handover.verify', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/handover-code/resend', 'handover.resend_code', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/handover-exception', 'handover.exception', 'required', '9.3'],
  ['POST', '/v1/tasks/{taskId}/reassign', 'task.reassign', 'required', '9.3'],
  ['POST', '/v1/tasks/{taskId}/release-custody', 'task.release_custody', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/repark', 'ticket.repark', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/custody-transfers', 'ticket.custody_transfer', 'required', '9.3'],
  ['POST', '/v1/tickets/{ticketId}/manual-reconcile', 'ticket.manual_reconcile', 'required', '9.3'],

  // §9.4 Collection
  ['POST', '/v1/tickets/{ticketId}/payments', 'payment.record', 'required', '9.4'],
  ['POST', '/v1/payments/{paymentId}/reverse', 'payment.reverse', 'required', '9.4'],
  ['POST', '/v1/tickets/{ticketId}/payment-waiver', 'payment.waive', 'required', '9.4'],
  ['POST', '/v1/cash-handovers', 'cash.handover_confirm', 'required', '9.4'],
  ['GET', '/v1/events/{eventId}/settlement', 'report.read', 'none', '9.4'],

  // §9.5 Venues, events and shifts
  ['GET', '/v1/venues', 'venue.read', 'none', '9.5'],
  ['POST', '/v1/venues', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}', 'venue.read', 'none', '9.5'],
  ['PATCH', '/v1/venues/{venueId}', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/settings', 'venue.read', 'none', '9.5'],
  ['PUT', '/v1/venues/{venueId}/settings', 'venue.manage', 'required', '9.5'],
  // V2-004 (O-04, DEC-490): the venue's public profile, reviewed by the platform before the map lists it
  ['GET', '/v1/venues/{venueId}/public-profile', 'venue.manage', 'none', '9.5'],
  ['PUT', '/v1/venues/{venueId}/public-profile', 'venue.manage', 'required', '9.5'],
  ['POST', '/v1/venues/{venueId}/public-profile/photos', 'venue.manage', 'required', '9.5'],
  ['POST', '/v1/venues/{venueId}/public-profile/submit', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/dispatch-pools', 'venue.read', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/dispatch-pools', 'venue.manage', 'required', '9.5'],
  ['PATCH', '/v1/dispatch-pools/{poolId}', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/parking-zones', 'venue.layout_read', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/parking-zones', 'venue.manage', 'required', '9.5'],
  ['PATCH', '/v1/parking-zones/{zoneId}', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/parking-spots', 'venue.layout_read', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/parking-spots', 'venue.manage', 'required', '9.5'], // bulk create supported
  ['PATCH', '/v1/parking-spots/{spotId}', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/key-boards', 'venue.layout_read', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/key-boards', 'venue.manage', 'required', '9.5'],
  ['POST', '/v1/key-boards/{boardId}/slots', 'venue.manage', 'required', '9.5'],
  ['PATCH', '/v1/key-slots/{slotId}', 'venue.manage', 'required', '9.5'],
  ['GET', '/v1/venues/{venueId}/events', 'event.manage', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/events', 'event.manage', 'required', '9.5'],
  ['GET', '/v1/events/{eventId}', 'event.manage', 'none', '9.5'],
  ['PATCH', '/v1/events/{eventId}', 'event.manage', 'required', '9.5'],
  ['POST', '/v1/events/{eventId}/open', 'event.manage', 'required', '9.5'],
  ['POST', '/v1/events/{eventId}/start-closing', 'event.manage', 'required', '9.5'],
  ['GET', '/v1/events/{eventId}/reconciliation', 'event.manage', 'none', '9.5'],
  ['POST', '/v1/events/{eventId}/close', 'event.manage', 'required', '9.5'],
  ['POST', '/v1/events/{eventId}/cancel', 'event.manage', 'required', '9.5'],
  ['GET', '/v1/events/{eventId}/operations', 'alert.read', 'none', '9.5'],
  ['GET', '/v1/venues/{venueId}/shifts', 'shift.manage', 'none', '9.5'],
  ['POST', '/v1/venues/{venueId}/shifts', 'shift.manage', 'required', '9.5'],
  ['POST', '/v1/shifts/{shiftId}/open', 'shift.manage', 'required', '9.5'],
  ['POST', '/v1/shifts/{shiftId}/close', 'shift.manage', 'required', '9.5'],

  // §9.6 Drivers and staff
  ['GET', '/v1/drivers', 'driver.read', 'none', '9.6'],
  ['POST', '/v1/drivers', 'driver.manage', 'required', '9.6'],
  ['GET', '/v1/drivers/{driverId}', 'driver.read', 'none', '9.6'],
  ['PATCH', '/v1/drivers/{driverId}', 'driver.manage', 'required', '9.6'],
  ['POST', '/v1/drivers/{driverId}/disable', 'driver.manage', 'required', '9.6'],
  ['POST', '/v1/drivers/{driverId}/enable', 'driver.manage', 'required', '9.6'],
  ['POST', '/v1/drivers/{driverId}/reset-secret', 'driver.manage', 'required', '9.6'],
  ['GET', '/v1/drivers/{driverId}/assignments', 'driver.read', 'none', '9.6'],
  ['POST', '/v1/drivers/{driverId}/assignments', 'driver.assign', 'required', '9.6'],
  ['POST', '/v1/drivers/{driverId}/transfers', 'driver.transfer', 'required', '9.6'],
  ['POST', '/v1/transfers/{transferId}/cancel', 'driver.transfer', 'required', '9.6'],
  ['POST', '/v1/duty-sessions/{sessionId}/force-end', 'duty.force_end', 'required', '9.6'],
  ['GET', '/v1/staff', 'staff.manage', 'none', '9.6'],
  ['POST', '/v1/staff', 'staff.manage', 'required', '9.6'],
  ['PATCH', '/v1/staff/{userId}', 'staff.manage', 'required', '9.6'],
  ['POST', '/v1/staff/{userId}/scopes', 'staff.manage', 'required', '9.6'],
  ['POST', '/v1/staff/{userId}/reset-mfa', 'staff.manage', 'required', '9.6'],

  // §9.7 Alerts, incidents, reports and administration
  ['GET', '/v1/alerts', 'alert.read', 'none', '9.7'],
  ['POST', '/v1/alerts/{alertId}/acknowledge', 'alert.manage', 'required', '9.7'],
  ['POST', '/v1/alerts/{alertId}/resolve', 'alert.manage', 'required', '9.7'],
  ['GET', '/v1/incidents', 'incident.read', 'none', '9.7'],
  ['POST', '/v1/incidents', 'incident.create', 'required', '9.7'],
  ['GET', '/v1/incidents/{incidentId}', 'incident.read', 'none', '9.7'],
  ['PATCH', '/v1/incidents/{incidentId}', 'incident.manage', 'required', '9.7'],
  ['GET', '/v1/reports/events/{eventId}/summary', 'report.read', 'none', '9.7'],
  ['GET', '/v1/reports/drivers', 'report.read', 'none', '9.7'],
  ['GET', '/v1/reports/payments', 'report.read', 'none', '9.7'],
  ['GET', '/v1/reports/messages', 'report.read', 'none', '9.7'],
  ['POST', '/v1/exports', 'export.create', 'required', '9.7'],
  ['GET', '/v1/exports/{exportId}', 'export.create', 'none', '9.7'],
  ['GET', '/v1/admin/whatsapp/channel', 'wa.channel_read', 'none', '9.7'],
  ['PUT', '/v1/admin/whatsapp/channel', 'wa.channel_manage', 'required', '9.7'],
  ['GET', '/v1/admin/whatsapp/templates', 'wa.channel_read', 'none', '9.7'],
  ['POST', '/v1/admin/whatsapp/templates/sync', 'wa.templates_manage', 'required', '9.7'],
  ['GET', '/v1/admin/outbox', 'outbox.manage', 'none', '9.7'],
  ['POST', '/v1/admin/outbox/{outboxId}/retry', 'outbox.manage', 'required', '9.7'],
  ['GET', '/v1/admin/audit-log', 'audit.read', 'none', '9.7'],
  ['GET', '/v1/admin/retention-policy', 'audit.read', 'none', '9.7'],
  ['PUT', '/v1/admin/retention-policy', 'retention.manage', 'required', '9.7'],
  ['GET', '/v1/admin/org-settings', 'org.settings_manage', 'none', '9.7'],
  ['PUT', '/v1/admin/org-settings', 'org.settings_manage', 'required', '9.7'],
  ['POST', '/v1/telemetry', 'telemetry.write', 'none', '9.7'],

  // §9.8 Webhooks and health (outside /v1)
  ['GET', '/webhooks/whatsapp', 'webhook', 'none', '9.8'], // hub.verify_token
  ['POST', '/webhooks/whatsapp', 'webhook', 'none', '9.8'], // X-Hub-Signature-256 over the raw body
  ['GET', '/health/live', 'public', 'none', '9.8'], // no data
  ['GET', '/health/ready', 'public', 'none', '9.8'], // no data
  ['GET', '/metrics', 'internal', 'none', '9.8'], // internal network only
];

/**
 * Routes whose `x-rate-limit-class` is not the default of their method (`GET` → `read`, anything else →
 * `command`). Checked against every operation of docs/07_openapi.yaml by test/routes.test.ts.
 */
const RATE_LIMIT_CLASS_OF: Readonly<Record<string, RateLimitClass>> = {
  'POST /v1/auth/login': 'auth',
  'POST /v1/auth/mfa/verify': 'auth',
  'POST /v1/auth/mfa/setup': 'write',
  'POST /v1/auth/mfa/confirm': 'write',
  'POST /v1/auth/secret/change': 'write',
  'POST /v1/auth/logout': 'write',
  'POST /v1/me/devices': 'device',
  'PUT /v1/me/devices/{deviceId}': 'device',
  'POST /v1/me/audio-test': 'device',
  'POST /v1/me/heartbeat': 'device',
  'POST /v1/telemetry': 'device',
  'POST /v1/exports': 'export',
  'GET /webhooks/whatsapp': 'webhook',
  'POST /webhooks/whatsapp': 'webhook',
  'GET /health/live': 'health',
  'GET /health/ready': 'health',
  'GET /metrics': 'health',
};

export const ROUTES: readonly RouteDef[] = ROWS.map(
  ([method, path, permission, idempotency, section, fieldPermission]): RouteDef => ({
    method,
    path,
    permission,
    idempotent: idempotency === 'required',
    idempotency,
    section,
    ...(fieldPermission ? { fieldPermission } : {}),
    rateLimitClass: RATE_LIMIT_CLASS_OF[`${method} ${path}`] ?? (method === 'GET' ? 'read' : 'command'),
  }),
);

/** `"<METHOD> <path template>"` — also the `idempotency_keys.operation` value (file 07 §1.4). */
export function routeKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

const BY_KEY = new Map(ROUTES.map((r) => [routeKey(r.method, r.path), r]));

/** Looks a route up by method and canon path template. */
export function findRoute(method: HttpMethod, path: string): RouteDef | undefined {
  return BY_KEY.get(routeKey(method, path));
}

/** Routes whose `Idempotency-Key` is required (✓). */
export const IDEMPOTENT_ROUTES: readonly RouteDef[] = ROUTES.filter((r) => r.idempotent);

/** Canon `{param}` template → Express/NestJS `:param` form. */
export function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

/** Express/NestJS `:param` form → canon `{param}` template. */
export function fromExpressPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}
