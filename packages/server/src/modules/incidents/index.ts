/**
 * incidents module (04 §4.2 item 7; PNT-075, PNT-083): the supervisor alerts center on top of the core alert writer
 * (DEC-79), the AlertAutoResolver projector, and internal incidents. It imports venues-events and core only.
 */
export { IncidentsHttpModule } from './http/incidents-http.module.js';
export { incidentsJobs, incidentsProjectors } from './jobs/index.js';
export { AlertsService, type ListAlertsQuery } from './application/alerts.service.js';
export {
  IncidentsService,
  openIncident,
  type OpenIncidentInput,
  type ListIncidentsQuery,
  type CreateIncidentBody,
  type UpdateIncidentBody,
} from './application/incidents.service.js';
export {
  INCIDENT_SELECT,
  incidentView,
  incidentChanged,
  type IncidentRow,
  type IncidentReadRow,
  type IncidentView,
} from './application/views.js';
export { AUTO_RESOLVE_RULES, createAlertAutoResolver } from './application/alert-auto-resolver.js';
export { scopeStillGranted, staffEligibleForVenue } from './application/scope.js';
