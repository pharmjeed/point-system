import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import { lockDutySessions, lockPools } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { releaseDriverWork } from '../../../core/hooks/driver-release.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { DATABASE } from '../../../http/tokens.js';
import { assertVersion, invalidTransition, isUuid, notFound, validationFailed } from '../domain/errors.js';
import { scheduleIssues } from '../domain/pricing.js';
import {
  assertShiftClosable,
  assertShiftOpenable,
  partitionShiftDuties,
  type CustodyRow,
  type OpenTaskRow,
  type ShiftDutyRow,
} from '../domain/shift-lifecycle.js';
import { ListCursorCodec, pageOf } from '../infra/cursor.js';
import { SHIFT_COLUMNS, toShift, type ShiftRow } from '../infra/rows.js';
import { assertResourceInScope, assertVenueParam, recheckVenueScope } from '../infra/scope.js';
import { resolveVenuePool } from './events.service.js';
import type { CreateShiftBody, ListShiftsQuery, VersionOnlyBody } from './schemas.js';
import { auditCommand, type CommandMeta } from './support.js';

interface LockedShift {
  shift: ShiftRow;
  pool: { id: string; status: string };
}

@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /** GET /v1/venues/{venueId}/shifts — latest start first. */
  async list(actor: ActorContext, venueId: string, q: ListShiftsQuery) {
    assertVenueParam(actor, venueId);
    const scope = `shifts|${venueId}|${q.status ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [venueId, actor.orgId];
    let where = `sh.venue_id = $1 AND sh.org_id = $2`;
    if (q.status) {
      params.push(q.status);
      where += ` AND sh.status = $${params.length}`;
    }
    if (after) {
      params.push(after[0], after[1]);
      where += ` AND (sh.starts_at, sh.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM shifts sh WHERE ${where}
        ORDER BY sh.starts_at DESC, sh.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, toShift, (r) => this.cursors.encode(scope, [r.starts_at_key, r.id]));
  }

  /** POST /v1/venues/{venueId}/shifts — a `scheduled` shift on the venue's default pool unless one is named. */
  async create(tx: Tx, actor: ActorContext, meta: CommandMeta, venueId: string, body: CreateShiftBody) {
    assertVenueParam(actor, venueId);
    await recheckVenueScope(tx, actor, venueId, { explicit: true });
    const issues = scheduleIssues(body.starts_at, body.ends_at);
    if (issues.length > 0) throw validationFailed(issues);
    const pool = await resolveVenuePool(tx, actor.orgId, venueId, body.dispatch_pool_id);
    const row = await tx.one<ShiftRow>(
      `INSERT INTO shifts AS sh (id, org_id, venue_id, dispatch_pool_id, name, starts_at, ends_at, status,
                                 created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, 1, $9, $9) RETURNING ${SHIFT_COLUMNS}`,
      [
        newId(),
        actor.orgId,
        venueId,
        pool.id,
        body.name ?? null,
        body.starts_at,
        body.ends_at ?? null,
        actor.userId,
        tx.now,
      ],
    );
    await auditCommand(tx, actor, meta, {
      action: 'shift.manage',
      entityType: 'shift',
      entityId: row.id,
      venueId,
      after: { status: 'scheduled', dispatch_pool_id: pool.id, starts_at: row.starts_at.toISOString() },
    });
    return toShift(row);
  }

  /**
   * POST /v1/shifts/{shiftId}/open — scheduled → open on an active pool, one open shift per pool
   * (SHIFT_ALREADY_OPEN with `open_shift_id`; `uq_shifts_open_per_pool` maps to the same code). Emits `shift.opened`.
   */
  async open(tx: Tx, actor: ActorContext, meta: CommandMeta, shiftId: string, body: VersionOnlyBody) {
    const { shift, pool } = await this.lockShift(tx, actor, shiftId);
    assertVersion('shift', shift, body.expected_version);
    assertShiftOpenable(shift, meta.operation);
    if (pool.status !== 'active') {
      throw invalidTransition({
        entityType: 'shift',
        entityId: shift.id,
        currentStatus: shift.status,
        currentVersion: shift.version,
        command: meta.operation,
        allowedFrom: ['scheduled'],
        reason: 'dispatch_pool_inactive',
      });
    }
    const other = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM shifts WHERE dispatch_pool_id = $1 AND status = 'open' AND id <> $2`,
      [pool.id, shift.id],
    );
    if (other) throw new AppError('SHIFT_ALREADY_OPEN', { open_shift_id: other.id });
    const row = await tx.one<ShiftRow>(
      `UPDATE shifts sh SET status = 'open', opened_at = $3, opened_by = $4, version = version + 1
        WHERE sh.id = $1 AND sh.version = $2 RETURNING ${SHIFT_COLUMNS}`,
      [shift.id, shift.version, tx.now, actor.userId],
    );
    await emitEvent(tx, {
      type: 'shift.opened',
      orgId: actor.orgId,
      venueId: row.venue_id,
      dispatchPoolId: row.dispatch_pool_id,
      aggregate: { type: 'shift', id: row.id, version: row.version },
      actor: { type: 'user', id: actor.userId },
      payload: { shift_id: row.id, dispatch_pool_id: row.dispatch_pool_id, status: 'open', by: actor.userId },
    });
    await auditCommand(tx, actor, meta, {
      action: 'shift.manage',
      entityType: 'shift',
      entityId: row.id,
      venueId: row.venue_id,
      before: { status: shift.status },
      after: { status: 'open' },
    });
    return toShift(row);
  }

  /**
   * POST /v1/shifts/{shiftId}/close (11 §6.5, 08 §4.12). Holding the pool lock (L1) and the duty sessions of the
   * shift (L8):
   * 1. a driver of the shift who holds a vehicle or key (`tickets.*_holder_type = 'driver'`) or has an open task
   *    blocks the close → SHIFT_CLOSE_BLOCKED with `blocking_drivers: [{ driver, items }]`, nothing changes;
   * 2. otherwise the shift is closed and every open duty session ends with `end_reason = shift_closed`: for each,
   *    the dispatch module releases the driver's work first (`releaseDriverWork`, DEC-32: live offers revoked),
   *    then the session ends (`driver.duty_ended`, `driver.availability_changed` → off_duty);
   * 3. `shift.closed` carries `ended_duty_session_ids`.
   */
  async close(tx: Tx, actor: ActorContext, meta: CommandMeta, shiftId: string, body: VersionOnlyBody) {
    const { shift, pool } = await this.lockShift(tx, actor, shiftId);
    assertVersion('shift', shift, body.expected_version);
    assertShiftClosable(shift, meta.operation);

    const open = await tx.rows<{ id: string }>(
      `SELECT id FROM duty_sessions WHERE shift_id = $1 AND status <> 'ended'`,
      [shift.id],
    );
    const lockedDuties = await lockDutySessions(
      tx,
      open.map((d) => d.id),
    );
    const sessions = await tx.rows<ShiftDutyRow>(
      `SELECT ds.id AS duty_session_id, ds.user_id, u.full_name, u.employee_code
         FROM duty_sessions ds JOIN users u ON u.id = ds.user_id
        WHERE ds.id = ANY($1::uuid[]) AND ds.status <> 'ended' ORDER BY ds.id`,
      [lockedDuties.map((d: { id: string }) => d.id)],
    );
    const userIds = sessions.map((s) => s.user_id);
    const custody = await this.custodyOf(tx, userIds);
    const tasks = await tx.rows<OpenTaskRow>(
      `SELECT t.assignee_id, t.id AS task_id, t.type, t.status, t.ticket_id, k.display_number,
              k.status AS ticket_status
         FROM tasks t JOIN tickets k ON k.id = t.ticket_id
        WHERE t.assignee_id = ANY($1::uuid[]) AND t.status NOT IN ('completed','canceled')`,
      [userIds],
    );
    const { blocking, toEnd } = partitionShiftDuties(sessions, custody, tasks);
    if (blocking.length > 0) throw new AppError('SHIFT_CLOSE_BLOCKED', { blocking_drivers: blocking });

    const row = await tx.one<ShiftRow>(
      `UPDATE shifts sh SET status = 'closed', closed_at = $3, closed_by = $4, version = version + 1
        WHERE sh.id = $1 AND sh.version = $2 RETURNING ${SHIFT_COLUMNS}`,
      [shift.id, shift.version, tx.now, actor.userId],
    );

    const ended: string[] = [];
    for (const s of toEnd) {
      await releaseDriverWork(tx, {
        orgId: actor.orgId,
        driverId: s.user_id,
        poolId: pool.id,
        reason: 'shift_closed',
        actorId: actor.userId,
      });
      const d = await tx.one<{ version: number }>(
        `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'shift_closed',
                available_since = NULL, version = version + 1
          WHERE id = $1 AND status <> 'ended' RETURNING version`,
        [s.duty_session_id, tx.now, actor.userId],
      );
      ended.push(s.duty_session_id);
      const envelope = {
        orgId: actor.orgId,
        venueId: row.venue_id,
        dispatchPoolId: pool.id,
        aggregate: { type: 'duty_session', id: s.duty_session_id, version: d.version },
        actor: { type: 'user' as const, id: actor.userId },
      };
      await emitEvent(tx, {
        ...envelope,
        type: 'driver.duty_ended',
        payload: {
          user_id: s.user_id,
          duty_session_id: s.duty_session_id,
          end_reason: 'shift_closed',
          ended_by: actor.userId,
        },
      });
      await emitEvent(tx, {
        ...envelope,
        type: 'driver.availability_changed',
        payload: {
          user_id: s.user_id,
          duty_session_id: s.duty_session_id,
          driver_state: 'off_duty',
          available_since: null,
          active_task_id: null,
          next_task_id: null,
        },
      });
    }

    await emitEvent(tx, {
      type: 'shift.closed',
      orgId: actor.orgId,
      venueId: row.venue_id,
      dispatchPoolId: row.dispatch_pool_id,
      aggregate: { type: 'shift', id: row.id, version: row.version },
      actor: { type: 'user', id: actor.userId },
      payload: {
        shift_id: row.id,
        dispatch_pool_id: row.dispatch_pool_id,
        status: 'closed',
        by: actor.userId,
        ended_duty_session_ids: ended,
      },
    });
    await auditCommand(tx, actor, meta, {
      action: 'shift.manage',
      entityType: 'shift',
      entityId: row.id,
      venueId: row.venue_id,
      before: { status: shift.status },
      after: { status: 'closed' },
      metadata: { ended_duty_session_ids: ended },
    });
    return toShift(row);
  }

  /**
   * Scope (404 outside) → L1 `dispatch_pools` of the shift (availability of its drivers changes, canon §14ب) →
   * the shift row. `shifts` is not a canon §14ب level: its rows are only ever locked right after their pool's L1.
   */
  private async lockShift(tx: Tx, actor: ActorContext, shiftId: string): Promise<LockedShift> {
    if (!isUuid(shiftId)) throw notFound('shift');
    const head = await tx.maybeOne<{ org_id: string; venue_id: string; dispatch_pool_id: string }>(
      `SELECT org_id, venue_id, dispatch_pool_id FROM shifts WHERE id = $1`,
      [shiftId],
    );
    assertResourceInScope(actor, head, 'shift');
    const [pool] = (await lockPools(tx, [head.dispatch_pool_id])) as { id: string; status: string }[];
    if (!pool) throw notFound('shift');
    const shift = await tx.one<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM shifts sh WHERE sh.id = $1 FOR NO KEY UPDATE`,
      [shiftId],
    );
    await recheckVenueScope(tx, actor, head.venue_id, { resource: 'shift' });
    return { shift, pool };
  }

  /** Open tickets whose vehicle or key is held by one of these drivers (`ix_tickets_*_holder_open`). */
  private async custodyOf(tx: Tx, userIds: string[]): Promise<CustodyRow[]> {
    if (userIds.length === 0) return [];
    const rows = await tx.rows<{
      ticket_id: string;
      display_number: number;
      vehicle_holder_type: string;
      vehicle_holder_id: string | null;
      key_holder_type: string;
      key_holder_id: string | null;
    }>(
      `SELECT id AS ticket_id, display_number, vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id
         FROM tickets
        WHERE status NOT IN ('delivered','voided')
          AND ((vehicle_holder_type = 'driver' AND vehicle_holder_id = ANY($1::uuid[]))
            OR (key_holder_type = 'driver' AND key_holder_id = ANY($1::uuid[])))`,
      [userIds],
    );
    const ids = new Set(userIds);
    const out: CustodyRow[] = [];
    for (const r of rows) {
      if (r.vehicle_holder_type === 'driver' && r.vehicle_holder_id && ids.has(r.vehicle_holder_id)) {
        out.push({
          holder_id: r.vehicle_holder_id,
          subject: 'vehicle',
          ticket_id: r.ticket_id,
          display_number: r.display_number,
        });
      }
      if (r.key_holder_type === 'driver' && r.key_holder_id && ids.has(r.key_holder_id)) {
        out.push({
          holder_id: r.key_holder_id,
          subject: 'key',
          ticket_id: r.ticket_id,
          display_number: r.display_number,
        });
      }
    }
    return out;
  }
}
