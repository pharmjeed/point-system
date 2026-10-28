import type { Incident, IncidentSeverity, IncidentStatus } from '@/api/types';

/**
 * `incidents.status` machine (11 §6.11): open → in_review → resolved → closed, open → resolved directly,
 * resolved → in_review to reopen; closed is final. resolved/closed need a resolution text (schema check;
 * 02 S-12 «اكتب الحل قبل إغلاق الواقعة.»).
 */
export const INCIDENT_NEXT: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['in_review', 'resolved'],
  in_review: ['resolved'],
  resolved: ['closed', 'in_review'],
  closed: [],
};

export const needsResolution = (status: IncidentStatus) => status === 'resolved' || status === 'closed';

export interface IncidentEdit {
  status: IncidentStatus;
  severity: IncidentSeverity;
  ownerId: string | null;
  description: string;
  resolution: string;
}

export const editFrom = (i: Incident): IncidentEdit => ({
  status: i.status,
  severity: i.severity,
  ownerId: i.owner?.id ?? null,
  description: i.description,
  resolution: i.resolution ?? '',
});

/** The PATCH body (07 `updateIncident`): `expected_version` and the changed fields only. */
export function incidentPatch(
  original: Incident,
  edit: IncidentEdit,
): { body: Record<string, unknown> & { expected_version: number }; changed: boolean } {
  const body: Record<string, unknown> & { expected_version: number } = { expected_version: original.version };
  if (edit.status !== original.status) body.status = edit.status;
  if (edit.severity !== original.severity) body.severity = edit.severity;
  if (edit.ownerId !== (original.owner?.id ?? null)) body.owner_id = edit.ownerId;
  if (edit.description.trim() !== original.description) body.description = edit.description.trim();
  const resolution = edit.resolution.trim();
  if (resolution !== (original.resolution ?? '')) body.resolution = resolution || null;
  return { body, changed: Object.keys(body).length > 1 };
}

/** Local check before sending (the server is the judge): a resolution when moving to resolved/closed. */
export function incidentEditError(edit: IncidentEdit): 'resolution' | 'description' | null {
  if (edit.description.trim().length < 3) return 'description';
  if (needsResolution(edit.status) && edit.resolution.trim().length === 0) return 'resolution';
  return null;
}
