import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalOpeningHours,
  categoryAllowsSubscriptions,
  normalizeOpeningHours,
  type PutVenuePublicProfileBody,
  type VenuePublicStatus,
} from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import {
  OBJECT_STORAGE,
  isSupportedContentType,
  mediaTooLarge,
  mediaTypeUnsupported,
  normalizeContentType,
  uploadIncomplete,
  uploadUrlTtlSeconds,
  type ObjectStorage,
} from '../../media/index.js';
import {
  EDITABLE_FROM,
  ENTITY_TYPE,
  OPERATOR_OPERATIONS,
  SUBMIT_FROM,
  assertFrom,
  missingForSubmit,
  photoUploadKey,
  profileVersionConflict,
} from '../domain/profile-policy.js';
import { findProfile, findReviewNote, lockProfile, num, type ProfileRow } from '../infra/profile-rows.js';
import type { PhotoIngestPlan } from './photo-ingest.js';
import type { PhotoSigner } from './photo-urls.js';
import {
  emptyProfileView,
  profileAuditState,
  profileView,
  type VenuePublicProfileDto,
} from './profile-views.js';

/** Per-request facts of the audit row (09 §11). */
export interface ProfileCommandMeta {
  operation: string;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

interface VenueRow {
  id: string;
  org_id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  status: 'active' | 'inactive';
  address: string | null;
  city: string | null;
  version: number;
}

const VENUE_COLUMNS = `v.id, v.org_id, v.code, v.name_ar, v.name_en, v.status, v.address, v.city, v.version`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `{venueId}` of the caller's organization (owner/admin: org scope, `venue.manage`). Anything else — another
 * operator's venue, a missing one, a malformed id — is `RESOURCE_NOT_FOUND` (`resource: venue`), the same answer,
 * so another operator learns nothing (08 §1.3 rule 4, V2-007). Only org-scope roles hold `venue.manage` (canon §10).
 */
function assertOwnVenue(actor: ActorContext, venueId: string): void {
  if (!UUID_RE.test(venueId) || !actor.venueIds.has(venueId))
    throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
}

/** TOCTOU (09 §8.4): the org scope the guard saw is still granted inside the transaction. */
async function recheckOrgScope(tx: Tx, actor: ActorContext): Promise<void> {
  if (actor.role === 'owner') return;
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM role_scopes rs
                     WHERE rs.user_id = $1 AND rs.org_id = $2 AND rs.revoked_at IS NULL AND rs.scope_type = 'org') AS ok`,
    [actor.userId, actor.orgId],
  );
  if (!r.rows[0]?.ok) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
}

/**
 * O-04 — the operator's side of the public profile (S-13 «الملف العام للموقع», V2-004): read it, save it as a draft
 * (full replacement), request a photo upload and submit it for the platform's review. Prices and the
 * subscription switch are the platform's (V2-D05): the operator sees them and cannot write them.
 */
@Injectable()
export class OperatorProfileService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private signer(now: Date): PhotoSigner {
    return { storage: this.storage, now, ttlS: this.env.MEDIA_READ_URL_TTL_S };
  }

  /** `GET /v1/venues/{venueId}/public-profile` — the profile, or the empty one (`status: null`, `version: 0`). */
  async get(actor: ActorContext, venueId: string): Promise<VenuePublicProfileDto> {
    assertOwnVenue(actor, venueId);
    const row = await findProfile(this.db, venueId, actor.orgId);
    if (row) return this.view(this.db, row, this.clock.now());
    const venue = await this.db.query<VenueRow>(
      `SELECT ${VENUE_COLUMNS} FROM venues v WHERE v.id = $1 AND v.org_id = $2`,
      [venueId, actor.orgId],
    );
    if (!venue.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    return emptyProfileView(venue.rows[0]);
  }

  private async view(q: Pick<Database, 'query'> | Pick<Tx, 'query'>, row: ProfileRow, now: Date) {
    const note = await findReviewNote(q, row.org_id, row.venue_id, row.status);
    return profileView(row, note, this.signer(now));
  }

  /** The photo ids a PUT body names: what the storage phase must verify before the transaction. */
  photoIdsToVerify(actor: ActorContext, venueId: string, body: unknown): string[] | null {
    if (!UUID_RE.test(venueId) || !actor.venueIds.has(venueId)) return null;
    const ids = (body as { photo_ids?: unknown } | null)?.photo_ids;
    if (!Array.isArray(ids) || ids.length > 6 || !ids.every((x) => typeof x === 'string' && UUID_RE.test(x)))
      return null;
    return ids as string[];
  }

  /**
   * `PUT /v1/venues/{venueId}/public-profile` — L0 → venue row → profile row → audit (L10). `expected_version` 0
   * creates the draft; otherwise it must equal the profile's version. A change of any reviewed field returns the
   * profile to `draft` (a submission is withdrawn; an approved listing leaves the map until approved again,
   * DEC-492); an identical body is a no-op. Hidden by the platform → INVALID_STATE_TRANSITION.
   */
  async put(
    tx: Tx,
    actor: ActorContext,
    meta: ProfileCommandMeta,
    venueId: string,
    body: PutVenuePublicProfileBody,
    plan: PhotoIngestPlan | undefined,
  ): Promise<VenuePublicProfileDto> {
    assertOwnVenue(actor, venueId);
    const venue = await tx.maybeOne<VenueRow>(
      `SELECT ${VENUE_COLUMNS} FROM venues v WHERE v.id = $1 AND v.org_id = $2 FOR NO KEY UPDATE OF v`,
      [venueId, actor.orgId],
    );
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    await recheckOrgScope(tx, actor);
    const current = await lockProfile(tx, venueId, actor.orgId);
    const currentVersion = current?.version ?? 0;
    if (body.expected_version !== currentVersion) throw profileVersionConflict(venueId, currentVersion);
    if (current) assertFrom(current, OPERATOR_OPERATIONS.put, EDITABLE_FROM, 'hidden_by_platform');

    // the photos: every id must be a sanitized object of this venue (verified before the transaction)
    if (plan?.kind === 'error') throw plan.error;
    for (const id of body.photo_ids)
      if (plan?.kind !== 'ready' || !plan.verified.has(id.toLowerCase()))
        throw uploadIncomplete(id, 'pending');
    const photoIds = body.photo_ids.map((i) => i.toLowerCase());
    const hours = canonicalOpeningHours(body.opening_hours);

    // V2-D07: halls sell no subscription; the platform must switch it off before the category becomes a hall
    if (current?.subscriptions_enabled && !categoryAllowsSubscriptions(body.category)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'category', issue: 'subscriptions_enabled' }],
      });
    }

    const before = current
      ? profileAuditState({
          status: current.status,
          category: current.category,
          address: current.address,
          city: current.city,
          lat: num(current.lat),
          lng: num(current.lng),
          opening_hours: normalizeOpeningHours(current.opening_hours),
          photo_ids: current.photo_asset_ids,
          version: current.version,
        })
      : null;
    const same =
      !!current &&
      current.category === body.category &&
      venue.address === body.address &&
      venue.city === body.city &&
      num(current.lat) === body.lat &&
      num(current.lng) === body.lng &&
      JSON.stringify(normalizeOpeningHours(current.opening_hours)) === JSON.stringify(hours) &&
      current.photo_asset_ids.join(',') === photoIds.join(',');

    if (!same) {
      if (venue.address !== body.address || venue.city !== body.city) {
        await tx.query(
          `UPDATE venues SET address = $3, city = $4, version = version + 1 WHERE id = $1 AND org_id = $2`,
          [venueId, actor.orgId, body.address, body.city],
        );
      }
      if (current) {
        await tx.query(
          `UPDATE venue_public_profiles
              SET status = 'draft', category = $3, lat = $4, lng = $5, opening_hours = $6, photo_asset_ids = $7,
                  approved_by = NULL, approved_at = NULL, version = version + 1
            WHERE venue_id = $1 AND org_id = $2`,
          [venueId, actor.orgId, body.category, body.lat, body.lng, JSON.stringify(hours), photoIds],
        );
      } else {
        await tx.query(
          `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, lat, lng, opening_hours,
                                              photo_asset_ids, version, created_at, updated_at)
           VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, 1, $8, $8)`,
          [venueId, actor.orgId, body.category, body.lat, body.lng, JSON.stringify(hours), photoIds, tx.now],
        );
      }
    }
    const row = (await lockProfile(tx, venueId, actor.orgId))!;
    await this.audit(tx, actor, meta, venueId, {
      before,
      after: profileAuditState({
        status: row.status,
        category: row.category,
        address: row.address,
        city: row.city,
        lat: num(row.lat),
        lng: num(row.lng),
        opening_hours: normalizeOpeningHours(row.opening_hours),
        photo_ids: row.photo_asset_ids,
        version: row.version,
      }),
      ...(same ? { metadata: { noop: true } } : {}),
    });
    return this.view(tx, row, tx.now);
  }

  /**
   * `POST /v1/venues/{venueId}/public-profile/photos` — a presigned PUT for one new photo (DEC-494): the original
   * goes to its `incoming/` key, the next PUT of the profile sanitizes and attaches it. Nothing is stored but the
   * audit row; the photo id is the key.
   */
  async requestPhoto(
    tx: Tx,
    actor: ActorContext,
    meta: ProfileCommandMeta,
    venueId: string,
    body: { content_type: string; byte_size: number },
  ) {
    assertOwnVenue(actor, venueId);
    const contentType = normalizeContentType(body.content_type);
    if (!isSupportedContentType(contentType)) throw mediaTypeUnsupported();
    if (body.byte_size > this.env.MEDIA_MAX_BYTES) throw mediaTooLarge(this.env.MEDIA_MAX_BYTES);
    const venue = await tx.maybeOne<{ id: string }>(`SELECT id FROM venues WHERE id = $1 AND org_id = $2`, [
      venueId,
      actor.orgId,
    ]);
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    await recheckOrgScope(tx, actor);
    const current = await findProfile(tx, venueId, actor.orgId);
    if (current) assertFrom(current, OPERATOR_OPERATIONS.photos, EDITABLE_FROM, 'hidden_by_platform');
    const photoId = newId();
    const upload = await this.storage.presignUpload(photoUploadKey(actor.orgId, venueId, photoId), {
      contentType,
      contentLength: body.byte_size,
      expiresInS: uploadUrlTtlSeconds(this.env.MEDIA_UPLOAD_URL_TTL_S),
      now: tx.now,
    });
    await this.audit(tx, actor, meta, venueId, {
      after: { photo_id: photoId, content_type: contentType, byte_size: body.byte_size },
    });
    return {
      photo_id: photoId,
      upload: {
        method: 'PUT' as const,
        url: upload.url,
        headers: upload.headers,
        expires_at: upload.expiresAt.toISOString(),
      },
    };
  }

  /**
   * `POST /v1/venues/{venueId}/public-profile/submit` — `draft` → `submitted` once complete (DEC-491: address, city,
   * position, opening hours; else VALIDATION_FAILED with `required_to_submit` per field).
   */
  async submit(
    tx: Tx,
    actor: ActorContext,
    meta: ProfileCommandMeta,
    venueId: string,
    body: { expected_version: number },
  ): Promise<VenuePublicProfileDto> {
    assertOwnVenue(actor, venueId);
    await recheckOrgScope(tx, actor);
    const current = await lockProfile(tx, venueId, actor.orgId);
    if (!current) throw new AppError('RESOURCE_NOT_FOUND', { resource: ENTITY_TYPE });
    if (body.expected_version !== current.version) throw profileVersionConflict(venueId, current.version);
    assertFrom(current, OPERATOR_OPERATIONS.submit, SUBMIT_FROM);
    const missing = missingForSubmit({
      address: current.address,
      city: current.city,
      lat: num(current.lat),
      lng: num(current.lng),
      opening_hours: normalizeOpeningHours(current.opening_hours),
    });
    if (missing.length) throw new AppError('VALIDATION_FAILED', { fields: missing });
    await tx.query(
      `UPDATE venue_public_profiles SET status = 'submitted', version = version + 1
        WHERE venue_id = $1 AND org_id = $2`,
      [venueId, actor.orgId],
    );
    const row = (await lockProfile(tx, venueId, actor.orgId))!;
    await this.audit(tx, actor, meta, venueId, {
      before: { status: current.status, version: current.version },
      after: { status: row.status satisfies VenuePublicStatus, version: row.version },
    });
    return this.view(tx, row, tx.now);
  }

  private audit(
    tx: Tx,
    actor: ActorContext,
    meta: ProfileCommandMeta,
    venueId: string,
    e: {
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    return audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'venue.manage',
      entityType: ENTITY_TYPE,
      entityId: venueId,
      venueId,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: e.before ?? null,
      after: e.after ?? null,
      metadata: { command: meta.operation, ...(e.metadata ?? {}) },
    });
  }
}
