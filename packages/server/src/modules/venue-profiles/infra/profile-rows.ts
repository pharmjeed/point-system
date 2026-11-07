import type { OpeningHours, OperatorStatus, VenueCategory, VenuePublicStatus } from '@point/shared';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { ENTITY_TYPE, OPERATOR_OPERATIONS, REVIEW_ACTIONS } from '../domain/profile-policy.js';

export type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/** A `venue_public_profiles` row with its venue and operator (the address and city live on `venues`, DEC-491). */
export interface ProfileRow {
  venue_id: string;
  org_id: string;
  status: VenuePublicStatus;
  category: VenueCategory;
  lat: string | null;
  lng: string | null;
  opening_hours: OpeningHours;
  photo_asset_ids: string[];
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  venue_code: string;
  venue_name_ar: string;
  venue_name_en: string | null;
  venue_status: 'active' | 'inactive';
  address: string | null;
  city: string | null;
  org_name_ar: string;
  org_name_en: string | null;
  operator_status: OperatorStatus;
}

export const PROFILE_COLUMNS = `
  p.venue_id, p.org_id, p.status, p.category, p.lat::text AS lat, p.lng::text AS lng, p.opening_hours,
  p.photo_asset_ids, p.subscriptions_enabled, p.pay_per_visit_halalas::text AS pay_per_visit_halalas,
  p.approved_by, p.approved_at, p.version, p.created_at, p.updated_at,
  v.code AS venue_code, v.name_ar AS venue_name_ar, v.name_en AS venue_name_en, v.status AS venue_status,
  v.address, v.city, o.name_ar AS org_name_ar, o.name_en AS org_name_en, o.operator_status`;

export const PROFILE_FROM = `
  venue_public_profiles p
  JOIN venues v ON v.id = p.venue_id AND v.org_id = p.org_id
  JOIN organizations o ON o.id = p.org_id`;

export async function findProfile(q: Q, venueId: string, orgId?: string): Promise<ProfileRow | null> {
  const r = await q.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM ${PROFILE_FROM}
      WHERE p.venue_id = $1 ${orgId ? 'AND p.org_id = $2' : ''}`,
    orgId ? [venueId, orgId] : [venueId],
  );
  return r.rows[0] ?? null;
}

/** The profile row locked for a command (after the venue row when the venue is also written). */
export async function lockProfile(tx: Tx, venueId: string, orgId?: string): Promise<ProfileRow | null> {
  return tx.maybeOne<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM ${PROFILE_FROM}
      WHERE p.venue_id = $1 ${orgId ? 'AND p.org_id = $2' : ''}
      FOR NO KEY UPDATE OF p`,
    orgId ? [venueId, orgId] : [venueId],
  );
}

export const num = (v: string | null): number | null => (v === null ? null : Number(v));

export interface ReviewNote {
  /** `sent_back`: the reviewer returned the submission to draft; `hidden`: the platform took the listing down */
  kind: 'sent_back' | 'hidden';
  reason: string;
  at: string;
}

/**
 * The reviewer's note the operator sees (O-04): the reason of the platform action that produced the current status
 * — a send-back while the profile is a draft not yet resubmitted, or the hide while it is hidden. Read from the
 * organization's own `audit_log` copy of the platform action (`platformAudit`), so no column is needed (DEC-491).
 */
export async function findReviewNote(
  q: Q,
  orgId: string,
  venueId: string,
  status: VenuePublicStatus,
): Promise<ReviewNote | null> {
  if (status !== 'draft' && status !== 'hidden') return null;
  const r = await q.query<{ action: string; reason: string | null; occurred_at: Date }>(
    `SELECT action, reason, occurred_at FROM audit_log
      WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3
        AND (action = ANY($4::text[]) OR metadata->>'command' = $5)
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [
      orgId,
      ENTITY_TYPE,
      venueId,
      [REVIEW_ACTIONS.approve, REVIEW_ACTIONS.sendBack, REVIEW_ACTIONS.hide, REVIEW_ACTIONS.unhide],
      OPERATOR_OPERATIONS.submit,
    ],
  );
  const last = r.rows[0];
  if (!last?.reason) return null;
  if (status === 'draft' && last.action === REVIEW_ACTIONS.sendBack)
    return { kind: 'sent_back', reason: last.reason, at: last.occurred_at.toISOString() };
  if (status === 'hidden' && last.action === REVIEW_ACTIONS.hide)
    return { kind: 'hidden', reason: last.reason, at: last.occurred_at.toISOString() };
  return null;
}
