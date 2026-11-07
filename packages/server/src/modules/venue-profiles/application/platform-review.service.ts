import { Inject, Injectable } from '@nestjs/common';
import { categoryAllowsSubscriptions, type VenuePublicStatus } from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../media/index.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';
import {
  APPROVE_FROM,
  ENTITY_TYPE,
  HIDE_FROM,
  PLATFORM_OPERATIONS,
  REVIEW_ACTIONS,
  SEND_BACK_FROM,
  UNHIDE_FROM,
  assertFrom,
  profileNotFound,
  profileVersionConflict,
} from '../domain/profile-policy.js';
import {
  PROFILE_COLUMNS,
  PROFILE_FROM,
  findProfile,
  findReviewNote,
  lockProfile,
  num,
  type ProfileRow,
} from '../infra/profile-rows.js';
import type { PhotoSigner } from './photo-urls.js';
import { platformProfileView, type PlatformVenueProfileDto } from './profile-views.js';

export interface PlatformCommandMeta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PlatformVenueListQuery {
  status?: VenuePublicStatus | undefined;
  org_id?: string | undefined;
  city?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** 07 `PlatformVenueListItem`: one row of P-04 (no photo links in the list). */
export interface PlatformVenueListItem {
  venue_id: string;
  venue: { code: string; name_ar: string; status: 'active' | 'inactive' };
  org: { id: string; name_ar: string; operator_status: string };
  status: VenuePublicStatus;
  category: string;
  city: string | null;
  photo_count: number;
  subscriptions_enabled: boolean;
  pay_per_visit_halalas: number | null;
  version: number;
  updated_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * P-04 — the platform's review of the venue listings (V2-004): list the submissions, open one, approve, send back
 * or hide/unhide with a reason (`platform.venue_review`, owner/admin), and set the venue's subscription switch and
 * pay-per-visit price (`platform.plan_manage`, owner/finance — P-05's permission: only the platform prices, V2-D05,
 * DEC-493). Every command writes `platform_audit_log` and the operator's `audit_log` (`platformAudit` with orgId).
 * Lock order (DEC-462): L0 platform key → the profile row → the append-only rows. The platform never touches a V1
 * operational row.
 */
@Injectable()
export class PlatformReviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly cursors: ListCursorCodec,
  ) {}

  private signer(now: Date): PhotoSigner {
    return { storage: this.storage, now, ttlS: this.env.MEDIA_READ_URL_TTL_S };
  }

  /** `GET /v1/platform/venues` — every operator's profiles (the platform reads across operators), newest first. */
  async list(q: PlatformVenueListQuery) {
    const scope = `platform-venues|${q.status ?? ''}|${q.org_id ?? ''}|${q.city ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) {
      params.push(q.status);
      where.push(`p.status = $${params.length}`);
    }
    if (q.org_id) {
      params.push(q.org_id);
      where.push(`p.org_id = $${params.length}`);
    }
    if (q.city) {
      params.push(q.city);
      where.push(`v.city = $${params.length}`);
    }
    if (after) {
      params.push(after[0], after[1]);
      where.push(
        `(p.updated_at, p.venue_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM ${PROFILE_FROM}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.updated_at DESC, p.venue_id DESC
        LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, toListItem, (r) =>
      this.cursors.encode(scope, [r.updated_at_us, r.venue_id]),
    );
  }

  /** `GET /v1/platform/venues/{venueId}` — one profile with signed photo links and the operator. */
  async get(venueId: string): Promise<PlatformVenueProfileDto> {
    if (!UUID_RE.test(venueId)) throw profileNotFound();
    const row = await findProfile(this.db, venueId);
    if (!row) throw profileNotFound();
    return this.view(this.db, row, this.clock.now());
  }

  private async view(q: Pick<Database, 'query'> | Pick<Tx, 'query'>, row: ProfileRow, now: Date) {
    const note = await findReviewNote(q, row.org_id, row.venue_id, row.status);
    return platformProfileView(row, note, this.signer(now));
  }

  private async load(tx: Tx, venueId: string, expectedVersion: number): Promise<ProfileRow> {
    if (!UUID_RE.test(venueId)) throw profileNotFound();
    const row = await lockProfile(tx, venueId);
    if (!row) throw profileNotFound();
    if (row.version !== expectedVersion) throw profileVersionConflict(venueId, row.version);
    return row;
  }

  /** `submitted` → `approved`: on the customer map once the operator and the venue are active. */
  async approve(tx: Tx, actor: PlatformActorContext, meta: PlatformCommandMeta, venueId: string, v: number) {
    const row = await this.load(tx, venueId, v);
    assertFrom(row, PLATFORM_OPERATIONS.approve, APPROVE_FROM);
    await tx.query(
      `UPDATE venue_public_profiles SET status = 'approved', approved_by = $2, approved_at = $3, version = version + 1
        WHERE venue_id = $1`,
      [venueId, actor.userId, tx.now],
    );
    return this.finish(tx, actor, meta, row, REVIEW_ACTIONS.approve, null);
  }

  /** `submitted` → `draft` with the reviewer's reason (the operator sees it in S-13). */
  async sendBack(
    tx: Tx,
    actor: PlatformActorContext,
    meta: PlatformCommandMeta,
    venueId: string,
    b: Reasoned,
  ) {
    const row = await this.load(tx, venueId, b.expected_version);
    assertFrom(row, PLATFORM_OPERATIONS.sendBack, SEND_BACK_FROM);
    await tx.query(
      `UPDATE venue_public_profiles SET status = 'draft', version = version + 1 WHERE venue_id = $1`,
      [venueId],
    );
    return this.finish(tx, actor, meta, row, REVIEW_ACTIONS.sendBack, b.reason);
  }

  /** `approved` → `hidden`: off the customer map, the operator cannot edit it until unhidden (DEC-492). */
  async hide(tx: Tx, actor: PlatformActorContext, meta: PlatformCommandMeta, venueId: string, b: Reasoned) {
    const row = await this.load(tx, venueId, b.expected_version);
    assertFrom(row, PLATFORM_OPERATIONS.hide, HIDE_FROM);
    await tx.query(
      `UPDATE venue_public_profiles SET status = 'hidden', version = version + 1 WHERE venue_id = $1`,
      [venueId],
    );
    return this.finish(tx, actor, meta, row, REVIEW_ACTIONS.hide, b.reason);
  }

  /** `hidden` → `approved` again, approved by this account now. */
  async unhide(tx: Tx, actor: PlatformActorContext, meta: PlatformCommandMeta, venueId: string, b: Reasoned) {
    const row = await this.load(tx, venueId, b.expected_version);
    assertFrom(row, PLATFORM_OPERATIONS.unhide, UNHIDE_FROM);
    await tx.query(
      `UPDATE venue_public_profiles SET status = 'approved', approved_by = $2, approved_at = $3, version = version + 1
        WHERE venue_id = $1`,
      [venueId, actor.userId, tx.now],
    );
    return this.finish(tx, actor, meta, row, REVIEW_ACTIONS.unhide, b.reason);
  }

  /**
   * `PUT /v1/platform/venues/{venueId}/pricing` — the subscription switch and the pay-per-visit price (V2-D05).
   * Subscriptions only on recurring venues (V2-D07): a hall → VALIDATION_FAILED. The status does not change.
   */
  async pricing(
    tx: Tx,
    actor: PlatformActorContext,
    meta: PlatformCommandMeta,
    venueId: string,
    b: { expected_version: number; subscriptions_enabled: boolean; pay_per_visit_halalas: number | null },
  ) {
    const row = await this.load(tx, venueId, b.expected_version);
    if (b.subscriptions_enabled && !categoryAllowsSubscriptions(row.category)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'subscriptions_enabled', issue: 'not_recurring_venue', category: row.category }],
      });
    }
    await tx.query(
      `UPDATE venue_public_profiles SET subscriptions_enabled = $2, pay_per_visit_halalas = $3, version = version + 1
        WHERE venue_id = $1`,
      [venueId, b.subscriptions_enabled, b.pay_per_visit_halalas],
    );
    return this.finish(tx, actor, meta, row, REVIEW_ACTIONS.pricing, null, {
      before: {
        subscriptions_enabled: row.subscriptions_enabled,
        pay_per_visit_halalas: num(row.pay_per_visit_halalas),
      },
      after: {
        subscriptions_enabled: b.subscriptions_enabled,
        pay_per_visit_halalas: b.pay_per_visit_halalas,
      },
    });
  }

  private async finish(
    tx: Tx,
    actor: PlatformActorContext,
    meta: PlatformCommandMeta,
    before: ProfileRow,
    action: string,
    reason: string | null,
    diff: Record<string, unknown> = {},
  ): Promise<PlatformVenueProfileDto> {
    const row = (await lockProfile(tx, before.venue_id))!;
    await platformAudit(tx, {
      actor: { type: 'platform_user', id: actor.userId, role: actor.role },
      action,
      entityType: ENTITY_TYPE,
      entityId: row.venue_id,
      orgId: row.org_id,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      reason,
      metadata: {
        venue_id: row.venue_id,
        from_status: before.status,
        to_status: row.status,
        version: row.version,
        ...diff,
      },
    });
    return this.view(tx, row, tx.now);
  }
}

type Reasoned = { expected_version: number; reason: string };

function toListItem(r: ProfileRow): PlatformVenueListItem {
  return {
    venue_id: r.venue_id,
    venue: { code: r.venue_code, name_ar: r.venue_name_ar, status: r.venue_status },
    org: { id: r.org_id, name_ar: r.org_name_ar, operator_status: r.operator_status },
    status: r.status,
    category: r.category,
    city: r.city,
    photo_count: r.photo_asset_ids.length,
    subscriptions_enabled: r.subscriptions_enabled,
    pay_per_visit_halalas: num(r.pay_per_visit_halalas),
    version: r.version,
    updated_at: r.updated_at.toISOString(),
  };
}
