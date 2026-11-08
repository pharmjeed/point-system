import { paths } from '@/app/paths';

/**
 * Staff routes of 02 §9.1 that take a parameter (`/ops/tickets/:ticketId`, `/drivers/:driverId/transfer`,
 * `/events/:eventId/close`), plus the two this stream adds (DEC-PROPOSED): `/incidents/:incidentId` (S-12
 * detail) and `/admin/:section` (S-13 sections).
 */
export const staffPaths = {
  ticket: (ticketId: string, action?: string) =>
    `${paths.ops}/tickets/${encodeURIComponent(ticketId)}${action ? `?action=${encodeURIComponent(action)}` : ''}`,
  transfer: (driverId: string) => `${paths.drivers}/${encodeURIComponent(driverId)}/transfer`,
  driver: (driverId: string) => `${paths.drivers}/${encodeURIComponent(driverId)}`,
  eventClose: (eventId: string) => `/events/${encodeURIComponent(eventId)}/close`,
  incident: (incidentId: string) => `${paths.incidents}/${encodeURIComponent(incidentId)}`,
  incidentsFor: (q: { ticket?: string; event?: string; create?: boolean }) => {
    const p = new URLSearchParams();
    if (q.ticket) p.set('ticket', q.ticket);
    if (q.event) p.set('event', q.event);
    if (q.create) p.set('create', '1');
    const s = p.toString();
    return s ? `${paths.incidents}?${s}` : paths.incidents;
  },
  adminSection: (section: string) => `${paths.admin}/${section}`,
  reportsFor: (eventId: string) => `${paths.reports}?event=${encodeURIComponent(eventId)}`,
} as const;

export const routePatterns = {
  ticket: `${paths.ops}/tickets/:ticketId`,
  transfer: `${paths.drivers}/:driverId/transfer`,
  eventClose: '/events/:eventId/close',
  incident: `${paths.incidents}/:incidentId`,
  adminSection: `${paths.admin}/:section`,
} as const;
