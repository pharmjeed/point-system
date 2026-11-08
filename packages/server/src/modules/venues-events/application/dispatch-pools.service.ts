import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import { lockPools } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { DATABASE } from '../../../http/tokens.js';
import { invalidTransition, isUuid, notFound, validationFailed } from '../domain/errors.js';
import { toDispatchPool, type DispatchPoolRow } from '../infra/rows.js';
import { assertResourceInScope, assertVenueParam, recheckVenueScope } from '../infra/scope.js';
import type { CreateDispatchPoolBody, UpdateDispatchPoolBody } from './schemas.js';
import { auditCommand, patchSet, type CommandMeta } from './support.js';

const POOL_COLUMNS = `id, org_id, venue_id, name, is_default, status, created_at`;

@Injectable()
export class DispatchPoolsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** GET /v1/venues/{venueId}/dispatch-pools — the default pool first, then by name. */
  async list(actor: ActorContext, venueId: string) {
    assertVenueParam(actor, venueId);
    const rows = await this.db.rows<DispatchPoolRow>(
      `SELECT ${POOL_COLUMNS} FROM dispatch_pools WHERE venue_id = $1 AND org_id = $2
        ORDER BY is_default DESC, name, id`,
      [venueId, actor.orgId],
    );
    return rows.map(toDispatchPool);
  }

  /** POST /v1/venues/{venueId}/dispatch-pools — an additional pool, never the default one (DEC-21). */
  async create(
    tx: Tx,
    actor: ActorContext,
    meta: CommandMeta,
    venueId: string,
    body: CreateDispatchPoolBody,
  ) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const row = await tx.one<DispatchPoolRow>(
      `INSERT INTO dispatch_pools (id, org_id, venue_id, name, is_default, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, 'active', $5, $5) RETURNING ${POOL_COLUMNS}`,
      [newId(), actor.orgId, venueId, body.name, tx.now],
    );
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'dispatch_pool',
      entityId: row.id,
      venueId,
      after: { name: row.name, is_default: false, status: row.status },
    });
    return toDispatchPool(row);
  }

  /**
   * PATCH /v1/dispatch-pools/{poolId}. Locks the venue's pools (L1, ascending ids) because a default change
   * touches two rows and a deactivation must not race a new task or shift on the pool.
   * - `is_default: true` makes this pool the venue default and demotes the previous one (exactly one default,
   *   DEC-21; the old flag is cleared first because `uq_dispatch_pools_default` is not deferrable);
   *   `is_default: false` on the default pool → VALIDATION_FAILED (a venue always keeps one default).
   * - `status: inactive` is refused with open tasks or an open shift on the pool (07 §2.5) → INVALID_STATE_TRANSITION.
   */
  async update(tx: Tx, actor: ActorContext, meta: CommandMeta, poolId: string, body: UpdateDispatchPoolBody) {
    if (!isUuid(poolId)) throw notFound('dispatch_pool');
    const head = await tx.maybeOne<{ org_id: string; venue_id: string }>(
      `SELECT org_id, venue_id FROM dispatch_pools WHERE id = $1`,
      [poolId],
    );
    assertResourceInScope(actor, head, 'dispatch_pool');
    const venuePools = await tx.rows<{ id: string }>(`SELECT id FROM dispatch_pools WHERE venue_id = $1`, [
      head.venue_id,
    ]);
    const locked = await lockPools(
      tx,
      venuePools.map((p) => p.id),
    );
    await recheckVenueScope(tx, actor, head.venue_id, { resource: 'dispatch_pool' });
    const pool = (locked as DispatchPoolRow[]).find((p) => p.id === poolId);
    if (!pool) throw notFound('dispatch_pool');
    const command = meta.operation;

    if (body.is_default === false && pool.is_default) {
      throw validationFailed([
        {
          field: 'is_default',
          issue: 'default_required',
          message_ar: 'لكل موقع مجموعة افتراضية واحدة؛ اجعل مجموعة أخرى افتراضية بدلًا منها.',
        },
      ]);
    }

    if (body.status === 'inactive' && pool.status !== 'inactive') {
      const blockers = await tx.one<{ open_tasks: number; open_shift_id: string | null }>(
        `SELECT (SELECT count(*)::int FROM tasks WHERE dispatch_pool_id = $1
                  AND status NOT IN ('completed','canceled')) AS open_tasks,
                (SELECT id FROM shifts WHERE dispatch_pool_id = $1 AND status = 'open' LIMIT 1) AS open_shift_id`,
        [poolId],
      );
      if (blockers.open_tasks > 0 || blockers.open_shift_id) {
        throw invalidTransition({
          entityType: 'dispatch_pool',
          entityId: poolId,
          currentStatus: pool.status,
          command,
          allowedFrom: ['active'],
          reason: blockers.open_shift_id ? 'open_shift' : 'open_tasks',
        });
      }
    }

    const diff = patchSet(
      pool as unknown as Record<string, unknown>,
      { name: body.name, status: body.status },
      ['name', 'status'],
      2,
    );
    let demoted: string | null = null;
    if (body.is_default === true && !pool.is_default) {
      const previous = (locked as DispatchPoolRow[]).find((p) => p.is_default);
      if (previous) {
        await tx.query(`UPDATE dispatch_pools SET is_default = false WHERE id = $1`, [previous.id]);
        demoted = previous.id;
      }
      diff.sets.push('is_default = true');
      diff.before.is_default = false;
      diff.after.is_default = true;
    }
    let row: DispatchPoolRow = pool;
    if (diff.sets.length > 0) {
      row = await tx.one<DispatchPoolRow>(
        `UPDATE dispatch_pools SET ${diff.sets.join(', ')} WHERE id = $1 RETURNING ${POOL_COLUMNS}`,
        [poolId, ...diff.params],
      );
    }
    await auditCommand(tx, actor, meta, {
      action: 'venue.manage',
      entityType: 'dispatch_pool',
      entityId: poolId,
      venueId: head.venue_id,
      before: diff.before,
      after: diff.after,
      metadata: {
        ...(demoted ? { demoted_default_pool_id: demoted } : {}),
        ...(diff.sets.length === 0 ? { noop: true } : {}),
      },
    });
    return toDispatchPool(row);
  }
}
