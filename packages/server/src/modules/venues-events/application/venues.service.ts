import { subscriptionLifecycle } from '../../../core/hooks/subscription-lifecycle.js';
import { Inject, Injectable } from '@nestjs/common';
import { venueSettingsSchema, type VenueSettings } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import { DATABASE } from '../../../http/tokens.js';
import { assertVersion, notFound } from '../domain/errors.js';
import { ListCursorCodec, pageOf } from '../infra/cursor.js';
import { VENUE_COLUMNS, toVenue, type VenueRow } from '../infra/rows.js';
import { assertVenueParam, recheckVenueScope, type Q } from '../infra/scope.js';
import type { CreateVenueBody, ListVenuesQuery, PutVenueSettingsBody, UpdateVenueBody } from './schemas.js';
import { auditCommand, patchSet, type CommandMeta } from './support.js';

/** Name of the dispatch pool created with every venue (DEC-21; the seed uses the same name, DEC-53). */
export const DEFAULT_POOL_NAME = 'الافتراضية';

/** Venue settings with the canon §12 defaults; stored settings are validated on every write. */
export function parseStoredSettings(raw: unknown, venueId: string): VenueSettings {
  const r = venueSettingsSchema.safeParse(raw ?? {});
  if (!r.success)
    throw new InvariantViolation(`venues.settings of ${venueId} does not match the canon schema`);
  return r.data;
}

/**
 * Effective settings of a venue (canon §12 defaults completed). Exported for the other modules (dispatch timers,
 * handover, intake): read inside the caller's transaction or with the pool; never cached across transactions
 * (10 §10).
 */
export async function venueSettingsFor(q: Q, venueId: string): Promise<VenueSettings> {
  const r = await q.query<{ settings: unknown }>(`SELECT settings FROM venues WHERE id = $1`, [venueId]);
  const row = r.rows[0];
  if (!row) throw notFound('venue');
  return parseStoredSettings(row.settings, venueId);
}

async function loadVenueForUpdate(tx: Tx, actor: ActorContext, venueId: string): Promise<VenueRow> {
  const row = await tx.maybeOne<VenueRow>(
    `SELECT ${VENUE_COLUMNS} FROM venues v WHERE v.id = $1 AND v.org_id = $2 FOR NO KEY UPDATE OF v`,
    [venueId, actor.orgId],
  );
  if (!row) throw notFound('venue');
  return row;
}

@Injectable()
export class VenuesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /** GET /v1/venues — the venues of the caller's scope (09 §4.5), by code. */
  async list(actor: ActorContext, q: ListVenuesQuery) {
    const scope = `venues|${q.status ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [actor.orgId, [...actor.venueIds]];
    let where = `v.org_id = $1 AND v.id = ANY($2::uuid[])`;
    if (q.status) {
      params.push(q.status);
      where += ` AND v.status = $${params.length}`;
    }
    if (after) {
      params.push(after[0], after[1]);
      where += ` AND (v.code, v.id) > ($${params.length - 1}::text, $${params.length}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<VenueRow>(
      `SELECT ${VENUE_COLUMNS} FROM venues v WHERE ${where} ORDER BY v.code, v.id LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, toVenue, (r) => this.cursors.encode(scope, [r.code, r.id]));
  }

  async get(actor: ActorContext, venueId: string) {
    assertVenueParam(actor, venueId);
    const r = await this.db.query<VenueRow>(
      `SELECT ${VENUE_COLUMNS} FROM venues v WHERE v.id = $1 AND v.org_id = $2`,
      [venueId, actor.orgId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('venue');
    return toVenue(row);
  }

  /**
   * POST /v1/venues: the venue with the canon §12 default settings and exactly one default dispatch pool
   * (PNT-018 AC1, DEC-21). A duplicate code is `venues_org_id_code_key` → VALIDATION_FAILED (08 §5.2).
   */
  async create(tx: Tx, actor: ActorContext, meta: CommandMeta, body: CreateVenueBody) {
    const venueId = newId();
    const poolId = newId();
    const settings = venueSettingsSchema.parse({});
    await tx.query(
      `INSERT INTO venues (id, org_id, code, name_ar, name_en, address, city, timezone, status, settings, version,
                           created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, 1, $10, $10)`,
      [
        venueId,
        actor.orgId,
        body.code,
        body.name_ar,
        body.name_en ?? null,
        body.address ?? null,
        body.city ?? null,
        body.timezone,
        JSON.stringify(settings),
        tx.now,
      ],
    );
    await tx.query(
      `INSERT INTO dispatch_pools (id, org_id, venue_id, name, is_default, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, 'active', $5, $5)`,
      [poolId, actor.orgId, venueId, DEFAULT_POOL_NAME, tx.now],
    );
    const row = await tx.one<VenueRow>(`SELECT ${VENUE_COLUMNS} FROM venues v WHERE v.id = $1`, [venueId]);
    const venue = toVenue(row);
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'venue',
      entityId: venueId,
      venueId,
      after: {
        venue_code: venue.code,
        name_ar: venue.name_ar,
        timezone: venue.timezone,
        status: venue.status,
        default_dispatch_pool_id: poolId,
      },
    });
    return venue;
  }

  /** PATCH /v1/venues/{venueId} — `expected_version` mandatory (07 §1.5). */
  async update(tx: Tx, actor: ActorContext, meta: CommandMeta, venueId: string, body: UpdateVenueBody) {
    assertVenueParam(actor, venueId);
    const current = await loadVenueForUpdate(tx, actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    assertVersion('venue', current, body.expected_version);
    const { expected_version: _v, ...patch } = body;
    const diff = patchSet(
      current as unknown as Record<string, unknown>,
      patch,
      ['name_ar', 'name_en', 'address', 'city', 'status'],
      3,
    );
    let row = current;
    if (diff.sets.length > 0) {
      row = await tx.one<VenueRow>(
        `UPDATE venues v SET ${diff.sets.join(', ')}, version = version + 1
          WHERE v.id = $1 AND v.version = $2 RETURNING ${VENUE_COLUMNS}`,
        [venueId, current.version, ...diff.params],
      );
    }
    // V2-034 (docs/v2/04 §1 «إغلاق الموقع»; DEC-536): a venue taken out of service freezes its subscriptions, and
    // back in service unfreezes them with the frozen days added
    if (row.status !== current.status)
      await subscriptionLifecycle.onVenueStatusChanged(tx, {
        orgId: actor.orgId,
        venueId,
        from: current.status,
        to: row.status,
        requestId: meta.requestId ?? null,
      });
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'venue',
      entityId: venueId,
      venueId,
      before: diff.before,
      after: diff.after,
      ...(diff.sets.length === 0 ? { metadata: { noop: true } } : {}),
    });
    return toVenue(row);
  }

  /** GET /v1/venues/{venueId}/settings — the effective settings (defaults completed) and the venue version. */
  async getSettings(actor: ActorContext, venueId: string) {
    assertVenueParam(actor, venueId);
    const r = await this.db.query<{ settings: unknown; version: number }>(
      `SELECT settings, version FROM venues WHERE id = $1 AND org_id = $2`,
      [venueId, actor.orgId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('venue');
    return { settings: parseStoredSettings(row.settings, venueId), version: row.version };
  }

  /**
   * PUT /v1/venues/{venueId}/settings — replaces the settings: the body was validated by the canon §12 schema
   * (invalid → VALIDATION_FAILED with `fields`, PNT-018 AC2) and missing keys take the default. The completed
   * object is stored; timers and offers created afterwards read it (07 §2.5).
   */
  async putSettings(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    venueId: string,
    body: PutVenueSettingsBody,
  ) {
    assertVenueParam(actor, venueId);
    const current = await loadVenueForUpdate(tx, actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    assertVersion('venue', current, body.expected_version);
    const before = parseStoredSettings(current.settings, venueId);
    const r = await tx.one<{ settings: unknown; version: number }>(
      `UPDATE venues SET settings = $3, version = version + 1 WHERE id = $1 AND version = $2
       RETURNING settings, version`,
      [venueId, current.version, JSON.stringify(body.settings)],
    );
    const settings = parseStoredSettings(r.settings, venueId);
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'venue',
      entityId: venueId,
      venueId,
      before: { settings: before },
      after: { settings },
      metadata: { change: 'settings' },
    });
    return { settings, version: r.version };
  }
}
