import type { IncidentSeverity, IncidentStatus, IncidentType } from '@point/shared';

/** An `incidents` row (06_schema.sql §13). */
export interface IncidentRow {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string | null;
  ticket_id: string | null;
  type: IncidentType;
  status: IncidentStatus;
  severity: IncidentSeverity;
  description: string;
  opened_by: string;
  owner_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** The row with the names of the users it references (UserRef of 07). */
export type IncidentReadRow = IncidentRow & {
  opened_by_full_name: string;
  opened_by_employee_code: string | null;
  owner_full_name: string | null;
  owner_employee_code: string | null;
  resolved_by_full_name: string | null;
  resolved_by_employee_code: string | null;
};

export const INCIDENT_SELECT = `SELECT i.*,
       ob.full_name AS opened_by_full_name, ob.employee_code AS opened_by_employee_code,
       ow.full_name AS owner_full_name, ow.employee_code AS owner_employee_code,
       rb.full_name AS resolved_by_full_name, rb.employee_code AS resolved_by_employee_code
  FROM incidents i
  JOIN users ob ON ob.id = i.opened_by
  LEFT JOIN users ow ON ow.id = i.owner_id
  LEFT JOIN users rb ON rb.id = i.resolved_by`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

const ref = (id: string | null, name: string | null, code: string | null) =>
  id ? { id, full_name: name ?? '', ...(code ? { employee_code: code } : {}) } : null;

/** `Incident` of 07. */
export function incidentView(r: IncidentReadRow) {
  return {
    id: r.id,
    venue_id: r.venue_id,
    event_id: r.event_id,
    ticket_id: r.ticket_id,
    type: r.type,
    status: r.status,
    severity: r.severity,
    description: r.description,
    opened_by: ref(r.opened_by, r.opened_by_full_name, r.opened_by_employee_code)!,
    owner: ref(r.owner_id, r.owner_full_name, r.owner_employee_code),
    resolution: r.resolution,
    resolved_by: ref(r.resolved_by, r.resolved_by_full_name, r.resolved_by_employee_code),
    resolved_at: iso(r.resolved_at),
    closed_at: iso(r.closed_at),
    version: r.version,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

export type IncidentView = ReturnType<typeof incidentView>;

/** Payload of `incident.opened` / `incident.updated` / `incident.resolved` (11 §8.8 IncidentChanged). */
export function incidentChanged(r: IncidentRow) {
  return {
    incident_id: r.id,
    type: r.type,
    status: r.status,
    severity: r.severity,
    ticket_id: r.ticket_id,
  };
}
