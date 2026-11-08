import { Injectable } from '@nestjs/common';
import { rooms } from '@point/shared';
import { autoResolveAlerts, raiseAlertForAffectedVenues } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { audit } from '../core/audit/audit-writer.js';
import { newId } from '../core/crypto/ids.js';
import {
  lockAssignments,
  lockOpenDutyByUsers,
  lockPools,
  lockTransfers,
  lockUsers,
} from '../core/db/locks.js';
import type { EventEnvelope, Tx } from '../core/db/tx.js';
import { registerTxPlanner, type TxPlanner } from '../core/db/tx-planners.js';
import { AppError } from '../core/errors/app-error.js';
import { STALE_TIMER, type JobHandler } from '../core/outbox/dispatcher.js';
import { emitEvent, schedule } from '../core/outbox/outbox-writer.js';
import { publishRealtime } from '../core/realtime/realtime-publisher.js';
import { emitAvailability, releaseDriverWorkImpl, type DutyRow } from '../modules/dispatch/index.js';
import { blockingCustody, revokeSessions, type CustodyItem } from '../modules/identity-access/index.js';
import { invalidTransition } from '../modules/tickets-custody/index.js';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** `driver_transfers` row (06). */
export interface TransferRow {
  id: string;
  org_id: string;
  driver_id: string;
  from_assignment_id: string | null;
  from_venue_id: string | null;
  to_venue_id: string;
  scheduled_at: Date;
  status: 'pending' | 'blocked' | 'completed' | 'canceled';
  reason: string;
  blocked_details: { items?: unknown[] } | null;
  requested_by: string;
  approved_by: string | null;
  completed_at: Date | null;
  canceled_at: Date | null;
  canceled_by: string | null;
  version: number;
}

/** DriverTransfer schema (07). */
export function transferView(r: TransferRow) {
  return {
    id: r.id,
    driver_id: r.driver_id,
    from_venue_id: r.from_venue_id,
    to_venue_id: r.to_venue_id,
    scheduled_at: iso(r.scheduled_at)!,
    status: r.status,
    reason: r.reason,
    blocked_details: r.blocked_details,
    requested_by: r.requested_by,
    approved_by: r.approved_by,
    completed_at: iso(r.completed_at),
    canceled_at: iso(r.canceled_at),
    version: r.version,
  };
}

/** 08 TRANSFER_BLOCKED_CUSTODY `items` (11 §8.5 DriverTransferBlocked). */
const blockerItems = (items: CustodyItem[]) =>
  items.map((i) => ({
    type: i.type,
    ticket_id: i.ticket_id,
    display_number: i.display_number ?? null,
    ...(i.task_id ? { task_id: i.task_id } : {}),
  }));

/** L1: every dispatch pool of both venues, ascending by id (10 §9.7 step 1). */
async function lockVenuePools(tx: Tx, venueIds: (string | null)[]): Promise<void> {
  const ids = venueIds.filter((v): v is string => !!v);
  const pools = await tx.rows<{ id: string }>(
    `SELECT id FROM dispatch_pools WHERE venue_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  await lockPools(
    tx,
    pools.map((p) => p.id),
  );
}

const SYSTEM = { type: 'system' as const, id: null };

/**
 * 10 §9.7 steps 3–7 (DEC-32), the caller holding L1 for both venues and L3 (transfer → assignment → user): the
 * driver's live single offers are revoked (`transfer`), his reserved next task and an accepted retrieval before
 * key pickup go back to the old venue's queue with their priority (`task.withdrawn`, new episodes), his duty ends
 * (`transfer`), the old assignment ends and the new one starts (`transfer_id`), every session is revoked
 * (`transfer`, ws `session.revoked`: a stale notification can no longer act), the transfer `completed`,
 * `driver.transferred`. History (tickets, tasks, cycles) keeps the original venue and actor.
 */
async function completeTransfer(
  tx: Tx,
  t: TransferRow,
  m: { actorId: string | null; currentAssignmentId: string | null },
): Promise<TransferRow> {
  const actor = m.actorId ? { type: 'user' as const, id: m.actorId } : SYSTEM;
  const duty = await tx.maybeOne<{ dispatch_pool_id: string }>(
    `SELECT dispatch_pool_id FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`,
    [t.driver_id],
  );
  const released = await releaseDriverWorkImpl(tx, {
    orgId: t.org_id,
    driverId: t.driver_id,
    poolId: duty?.dispatch_pool_id ?? null,
    reason: 'transfer',
    actorId: m.actorId,
  });
  const [open] = await lockOpenDutyByUsers<DutyRow>(tx, [t.driver_id]); // L8
  if (open) {
    const ended = await tx.one<DutyRow>(
      `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'transfer',
              available_since = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [open.id, tx.now, m.actorId],
    );
    await emitEvent(tx, {
      type: 'driver.duty_ended',
      orgId: t.org_id,
      venueId: ended.venue_id,
      dispatchPoolId: ended.dispatch_pool_id,
      aggregate: { type: 'duty_session', id: ended.id, version: ended.version },
      actor,
      payload: {
        user_id: t.driver_id,
        duty_session_id: ended.id,
        end_reason: 'transfer',
        ended_by: m.actorId,
      },
    });
    await emitAvailability(tx, t.driver_id, actor, ended);
  }
  if (m.currentAssignmentId)
    await tx.query(
      `UPDATE driver_assignments SET status = 'ended', ends_at = $2, updated_at = $2 WHERE id = $1 AND status = 'active'`,
      [m.currentAssignmentId, tx.now],
    );
  const created = await tx.one<{ id: string }>(
    `INSERT INTO driver_assignments (org_id, driver_id, venue_id, status, starts_at, reason, transfer_id, created_by, approved_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $7, $4, $4) RETURNING id`,
    [t.org_id, t.driver_id, t.to_venue_id, tx.now, t.reason, t.id, m.actorId ?? t.requested_by],
  );
  const revoked = await revokeSessions(tx, t.driver_id, 'transfer');
  await publishRealtime(tx, t.org_id, [rooms.user(t.driver_id)], {
    event: 'session.revoked',
    id: newId(),
    aggregate: { type: 'driver_transfer', id: t.id, version: t.version + 1 },
    data: { reason: 'transfer' },
  });
  const done = await tx.one<TransferRow>(
    `UPDATE driver_transfers SET status = 'completed', completed_at = $2, blocked_details = NULL,
            approved_by = COALESCE(approved_by, $3), version = version + 1, updated_at = $2
      WHERE id = $1 RETURNING *`,
    [t.id, tx.now, m.actorId ?? t.requested_by],
  );
  await emitEvent(tx, {
    type: 'driver.transferred',
    orgId: t.org_id,
    venueId: t.to_venue_id,
    aggregate: { type: 'driver_transfer', id: t.id, version: done.version },
    actor,
    payload: {
      transfer_id: t.id,
      driver_id: t.driver_id,
      from_venue_id: t.from_venue_id,
      to_venue_id: t.to_venue_id,
      ended_assignment_id: m.currentAssignmentId,
      new_assignment_id: created.id,
      returned_task_ids: released.returnedTaskIds,
      sessions_revoked: revoked.length,
    },
  });
  await autoResolveAlerts(tx, {
    orgId: t.org_id,
    dedupeKeys: [`transfer_blocked:${t.id}`],
    note: 'transfer_completed',
  });
  return done;
}

/**
 * `POST /v1/drivers/{driverId}/transfers` and `POST /v1/transfers/{transferId}/cancel` (PNT-086; 10 §9.7,
 * DEC-32, AC-10/AC-16). Immediate (`scheduled_at` absent or due): refused 409 TRANSFER_BLOCKED_CUSTODY without a
 * transfer row or an alert while the driver holds a vehicle or a key or has a task in progress or an active
 * park/repark; otherwise completed in the same transaction. Scheduled: `pending` + `job.transfer_activate` at
 * `scheduled_at` (custody is checked then; a blocked activation waits and is re-evaluated automatically).
 */
@Injectable()
export class DriverTransfersUseCase {
  async create(
    tx: Tx,
    actor: ActorContext,
    driverId: string,
    body: { to_venue_id: string; scheduled_at?: string | null; reason: string },
    requestId: string,
  ) {
    const op = 'POST /v1/drivers/{driverId}/transfers';
    const pre = await tx.maybeOne<{
      org_id: string;
      role: string;
      assignment_id: string | null;
      from_venue_id: string | null;
    }>(
      `SELECT u.org_id, u.role, a.id AS assignment_id, a.venue_id AS from_venue_id
         FROM users u LEFT JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
        WHERE u.id = $1`,
      [driverId],
    );
    if (!pre || pre.org_id !== actor.orgId || pre.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    const to = body.to_venue_id;
    const venue = await tx.maybeOne<{ id: string }>(`SELECT id FROM venues WHERE id = $1 AND org_id = $2`, [
      to,
      actor.orgId,
    ]);
    if (!venue) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
    // 09 §8.2 policy: the supervisor needs both venues
    if (pre.from_venue_id && !actor.venueIds.has(pre.from_venue_id))
      throw new AppError('TRANSFER_SCOPE_DENIED', { missing_venue_id: pre.from_venue_id });
    if (!actor.venueIds.has(to)) throw new AppError('TRANSFER_SCOPE_DENIED', { missing_venue_id: to });
    if (pre.from_venue_id === to)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'to_venue_id', issue: 'same_as_current' }],
      });
    const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : tx.now;
    const immediate = scheduledAt.getTime() <= tx.now.getTime();
    const reason = body.reason.trim();

    if (immediate) await lockVenuePools(tx, [pre.from_venue_id, to]); // L1 (both venues)
    const [assignment] = pre.assignment_id ? await lockAssignments(tx, [pre.assignment_id]) : [null]; // L3.2
    const [user] = (await lockUsers(tx, [driverId])) as { status: string }[]; // L3.3
    if (!user || user.status !== 'active') throw new AppError('DRIVER_DISABLED');
    if (pre.assignment_id && (!assignment || assignment.status !== 'active'))
      throw new AppError('ASSIGNMENT_CONFLICT', { reason: 'assignment_changed' });
    const openTransfer = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM driver_transfers WHERE driver_id = $1 AND status IN ('pending','blocked')`,
      [driverId],
    );
    if (openTransfer) throw new AppError('TRANSFER_ALREADY_PENDING', { transfer_id: openTransfer.id });
    if (immediate) {
      const items = await blockingCustody(tx, driverId);
      if (items.length) throw new AppError('TRANSFER_BLOCKED_CUSTODY', { items: blockerItems(items) });
    }

    const inserted = await tx.one<TransferRow>(
      `INSERT INTO driver_transfers (id, org_id, driver_id, from_assignment_id, from_venue_id, to_venue_id, scheduled_at,
                                     status, reason, requested_by, approved_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $9, $10, $10) RETURNING *`,
      [
        newId(),
        actor.orgId,
        driverId,
        pre.assignment_id,
        pre.from_venue_id,
        to,
        scheduledAt,
        reason,
        actor.userId,
        tx.now,
      ],
    );
    await emitEvent(tx, {
      type: 'driver.transfer_requested',
      orgId: actor.orgId,
      venueId: pre.from_venue_id ?? to,
      aggregate: { type: 'driver_transfer', id: inserted.id, version: inserted.version },
      actor: { type: 'user', id: actor.userId },
      payload: {
        transfer_id: inserted.id,
        driver_id: driverId,
        from_venue_id: pre.from_venue_id,
        to_venue_id: to,
        scheduled_at: scheduledAt.toISOString(),
        requested_by: actor.userId,
      },
    });
    let result = inserted;
    if (immediate) {
      result = await completeTransfer(tx, inserted, {
        actorId: actor.userId,
        currentAssignmentId: pre.assignment_id,
      });
    } else {
      await schedule(tx, 'job.transfer_activate', scheduledAt, {
        orgId: actor.orgId,
        venueId: pre.from_venue_id ?? to,
        dedupeKey: `transfer_activate:${inserted.id}`,
        aggregate: { type: 'driver_transfer', id: inserted.id, version: inserted.version },
        payload: { transfer_id: inserted.id, aggregate_version: inserted.version },
      });
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.transfer',
      entityType: 'driver_transfer',
      entityId: inserted.id,
      venueId: pre.from_venue_id ?? to,
      requestId,
      reason,
      after: { status: result.status, from_venue_id: pre.from_venue_id, to_venue_id: to },
      metadata: {
        operation: op,
        driver_id: driverId,
        scheduled_at: scheduledAt.toISOString(),
        immediate,
        custody_check: immediate ? 'clear' : 'at_activation',
      },
    });
    return transferView(result);
  }

  async cancel(tx: Tx, actor: ActorContext, transferId: string, body: { reason: string }, requestId: string) {
    const op = 'POST /v1/transfers/{transferId}/cancel';
    const pre = await tx.maybeOne<TransferRow>(
      `SELECT * FROM driver_transfers WHERE id = $1 AND org_id = $2`,
      [transferId, actor.orgId],
    );
    const visible = (v: string | null) => !!v && actor.venueIds.has(v);
    if (!pre || (!visible(pre.from_venue_id) && !visible(pre.to_venue_id)))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver_transfer' });
    for (const v of [pre.from_venue_id, pre.to_venue_id])
      if (v && !actor.venueIds.has(v)) throw new AppError('TRANSFER_SCOPE_DENIED', { missing_venue_id: v });
    const [t] = (await lockTransfers(tx, [transferId])) as TransferRow[]; // L3.1
    if (!t || (t.status !== 'pending' && t.status !== 'blocked'))
      throw invalidTransition('driver_transfer', t ?? pre, op, ['pending', 'blocked']);
    const reason = body.reason.trim();
    const canceled = await tx.one<TransferRow>(
      `UPDATE driver_transfers SET status = 'canceled', canceled_at = $2, canceled_by = $3, version = version + 1, updated_at = $2
        WHERE id = $1 RETURNING *`,
      [t.id, tx.now, actor.userId],
    );
    await autoResolveAlerts(tx, {
      orgId: t.org_id,
      dedupeKeys: [`transfer_blocked:${t.id}`],
      note: 'transfer_canceled',
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.transfer',
      entityType: 'driver_transfer',
      entityId: t.id,
      venueId: t.from_venue_id ?? t.to_venue_id,
      requestId,
      reason,
      before: { status: t.status },
      after: { status: 'canceled' },
      metadata: { operation: op, command: 'cancel', driver_id: t.driver_id },
    });
    return transferView(canceled);
  }
}

/**
 * `job.transfer_activate` (10 §8.2, §9.7; ActivateTransfer of 04 §4.2): the transfer is still `pending` or `blocked`
 * (and due) → L1 both venues → L3 transfer → assignment → user, then the DEC-32 check: blocked → `blocked` with
 * `blocked_details` (`TRANSFER_BLOCKED_CUSTODY` items), `driver.transfer_blocked` and `transfer_blocked` (info) for
 * the supervisors of both venues (DEC-46); clear → completed as an immediate transfer. A disabled driver's transfer
 * is canceled. A blocked transfer is activated again when the driver's work or custody ends (transfer watch).
 */
export const transferActivateHandler: JobHandler = {
  type: 'job.transfer_activate',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = maybeTx!;
    const id = (row.payload?.transfer_id as string | undefined) ?? row.aggregate_id;
    if (!id) return;
    const pre = await tx.maybeOne<TransferRow>(`SELECT * FROM driver_transfers WHERE id = $1`, [id]);
    if (!pre || (pre.status !== 'pending' && pre.status !== 'blocked')) return STALE_TIMER; // completed or canceled
    if (new Date(pre.scheduled_at).getTime() > tx.now.getTime()) {
      await schedule(tx, 'job.transfer_activate', new Date(pre.scheduled_at), {
        orgId: pre.org_id,
        venueId: pre.from_venue_id ?? pre.to_venue_id,
        dedupeKey: `transfer_activate:${pre.id}`,
        aggregate: { type: 'driver_transfer', id: pre.id, version: pre.version },
        payload: { transfer_id: pre.id, aggregate_version: pre.version },
      });
      return;
    }
    const current = await tx.maybeOne<{ id: string; venue_id: string }>(
      `SELECT id, venue_id FROM driver_assignments WHERE driver_id = $1 AND status = 'active'`,
      [pre.driver_id],
    );
    await lockVenuePools(tx, [pre.from_venue_id, current?.venue_id ?? null, pre.to_venue_id]); // L1
    const [t] = (await lockTransfers(tx, [id])) as TransferRow[]; // L3.1
    if (!t || (t.status !== 'pending' && t.status !== 'blocked')) return STALE_TIMER;
    if (current) await lockAssignments(tx, [current.id]); // L3.2
    const [user] = (await lockUsers(tx, [t.driver_id])) as { status: string }[]; // L3.3
    const venues = [...new Set([t.from_venue_id, t.to_venue_id].filter((v): v is string => !!v))];
    if (!user || user.status !== 'active') {
      await tx.query(
        `UPDATE driver_transfers SET status = 'canceled', canceled_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`,
        [t.id, tx.now],
      );
      await autoResolveAlerts(tx, {
        orgId: t.org_id,
        dedupeKeys: [`transfer_blocked:${t.id}`],
        note: 'driver_disabled',
      });
      await audit(tx, {
        orgId: t.org_id,
        actor: SYSTEM,
        action: 'job.transfer_activate',
        entityType: 'driver_transfer',
        entityId: t.id,
        venueId: t.from_venue_id ?? t.to_venue_id,
        before: { status: t.status },
        after: { status: 'canceled' },
        metadata: { driver_id: t.driver_id, cause: 'driver_disabled' },
      });
      return;
    }
    const items = await blockingCustody(tx, t.driver_id);
    if (items.length) {
      const details = { code: 'TRANSFER_BLOCKED_CUSTODY', items: blockerItems(items) };
      const same = t.status === 'blocked' && JSON.stringify(t.blocked_details) === JSON.stringify(details);
      if (same) return; // re-evaluated, still blocked by the same items
      const blocked = await tx.one<TransferRow>(
        `UPDATE driver_transfers SET status = 'blocked', blocked_details = $2, version = version + 1, updated_at = $3
          WHERE id = $1 RETURNING *`,
        [t.id, JSON.stringify(details), tx.now],
      );
      await emitEvent(tx, {
        type: 'driver.transfer_blocked',
        orgId: t.org_id,
        venueId: t.from_venue_id ?? t.to_venue_id,
        aggregate: { type: 'driver_transfer', id: t.id, version: blocked.version },
        actor: SYSTEM,
        payload: {
          transfer_id: t.id,
          driver_id: t.driver_id,
          from_venue_id: t.from_venue_id,
          to_venue_id: t.to_venue_id,
          items: details.items,
        },
      });
      await raiseAlertForAffectedVenues(tx, {
        orgId: t.org_id,
        type: 'transfer_blocked',
        venueIds: venues,
        dedupeKey: `transfer_blocked:${t.id}`,
        userId: t.driver_id,
        details: {
          transfer_id: t.id,
          driver_id: t.driver_id,
          from_venue_id: t.from_venue_id,
          to_venue_id: t.to_venue_id,
          items: details.items,
        },
      });
      await audit(tx, {
        orgId: t.org_id,
        actor: SYSTEM,
        action: 'job.transfer_activate',
        entityType: 'driver_transfer',
        entityId: t.id,
        venueId: t.from_venue_id ?? t.to_venue_id,
        before: { status: t.status },
        after: { status: 'blocked' },
        metadata: { driver_id: t.driver_id, items: details.items.length },
      });
      return;
    }
    const done = await completeTransfer(tx, t, { actorId: null, currentAssignmentId: current?.id ?? null });
    await audit(tx, {
      orgId: t.org_id,
      actor: SYSTEM,
      action: 'job.transfer_activate',
      entityType: 'driver_transfer',
      entityId: t.id,
      venueId: t.from_venue_id ?? t.to_venue_id,
      before: { status: t.status },
      after: { status: done.status },
      metadata: { driver_id: t.driver_id },
    });
  },
};

/**
 * Re-evaluation of blocked transfers (10 §9.7 step 2, 11 §8.11: «عند الحجب: لحظة انتهاء مهمة السائق أو تحرير
 * عهدته»): a TxPlanner that, whenever a transaction ends a driver's task or moves custody away from him, schedules
 * `job.transfer_activate` now for his `blocked` transfer (dedupe `transfer_activate:<id>`). It works for every
 * command that does so (handover, complete-parking, official custody transfer, manual reconcile…) without them
 * knowing about transfers.
 */
export const transferWatchPlanner: TxPlanner = {
  name: 'dispatch-transfer-watch',
  async plan(tx, events) {
    const drivers = new Set<string>();
    for (const ev of events as EventEnvelope<Record<string, any>>[]) {
      const p = ev.payload ?? {};
      if (ev.type === 'custody.changed' && p.from?.type === 'driver' && typeof p.from.id === 'string')
        drivers.add(p.from.id);
      else if (
        (ev.type === 'task.completed' || ev.type === 'task.canceled') &&
        typeof p.assignee_id === 'string'
      )
        drivers.add(p.assignee_id);
      else if (ev.type === 'task.reassigned' && typeof p.from_assignee_id === 'string')
        drivers.add(p.from_assignee_id);
    }
    if (!drivers.size) return;
    const blocked = await tx.rows<{
      id: string;
      org_id: string;
      from_venue_id: string | null;
      to_venue_id: string;
      version: number;
    }>(
      `SELECT id, org_id, from_venue_id, to_venue_id, version FROM driver_transfers
        WHERE driver_id = ANY($1::uuid[]) AND status = 'blocked' ORDER BY id`,
      [[...drivers]],
    );
    for (const b of blocked)
      await schedule(tx, 'job.transfer_activate', tx.now, {
        orgId: b.org_id,
        venueId: b.from_venue_id ?? b.to_venue_id,
        dedupeKey: `transfer_activate:${b.id}`,
        aggregate: { type: 'driver_transfer', id: b.id, version: b.version },
        payload: { transfer_id: b.id, aggregate_version: b.version },
      });
  },
};

export function registerTransferWatch(): void {
  registerTxPlanner(transferWatchPlanner);
}
