import { Injectable } from '@nestjs/common';
import type { DriverState } from '@point/shared';
import { assertExplicitVenue, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockAssignments, lockOpenDutyByUsers, lockPools, lockUsers } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { blockingCustody } from '../../identity-access/index.js';
import { invalidTransition, type EventActor, type TicketQueryable } from '../../tickets-custody/index.js';
import { findDefaultDispatchPool, findOpenShiftForPool } from '../../venues-events/index.js';
import { driverStateOf } from '../infra/dispatch-repo.js';
import type { DutyRow } from '../infra/rows.js';
import { releaseDriverWork } from './driver-release.js';
import { emitAvailability } from './events.js';
import { ensureHeartbeatSweep } from './heartbeat.js';
import { revokeDriverSingleOffers } from './offers.js';
import { runDispatchPass } from './pass.js';
import { currentDriverState, dutySessionView } from './views.js';

export interface DutyItem {
  type: 'vehicle' | 'key' | 'task' | 'next_task' | 'draft';
  ticket_id: string;
  display_number: number;
}

/** Vehicles/keys held by the driver on open tickets and his open/next tasks (08 DUTY_END_BLOCKED_CUSTODY). */
export async function dutyItems(q: TicketQueryable, userId: string): Promise<DutyItem[]> {
  const r = await q.query<DutyItem>(
    `SELECT 'vehicle' AS type, t.id AS ticket_id, t.display_number FROM tickets t
      WHERE t.vehicle_holder_type = 'driver' AND t.vehicle_holder_id = $1 AND t.status NOT IN ('delivered','voided')
     UNION ALL
     SELECT 'key', t.id, t.display_number FROM tickets t
      WHERE t.key_holder_type = 'driver' AND t.key_holder_id = $1 AND t.status NOT IN ('delivered','voided')
     UNION ALL
     SELECT CASE WHEN k.status = 'assigned_waiting' THEN 'next_task'
                 WHEN k.type = 'park' AND t.status = 'received' THEN 'draft'
                 ELSE 'task' END, t.id, t.display_number
       FROM tasks k JOIN tickets t ON t.id = k.ticket_id
      WHERE k.assignee_id = $1 AND k.status IN ('accepted','in_progress','assigned_waiting')`,
    [userId],
  );
  return r.rows;
}

async function deviceChecks(q: TicketQueryable, actor: ActorContext, deviceId: string | null | undefined) {
  const r = await q.query<{
    audio_test_result: string | null;
    push_endpoint: string | null;
    display_mode: string;
  }>(
    `SELECT audio_test_result, push_endpoint, display_mode FROM devices
      WHERE id = COALESCE($2::uuid, (SELECT device_id FROM auth_sessions WHERE id = $1)) AND user_id = $3 AND revoked_at IS NULL`,
    [actor.sessionId, deviceId ?? null, actor.userId],
  );
  const d = r.rows[0];
  return {
    audio_tested: d?.audio_test_result === 'heard',
    push_enabled: !!d?.push_endpoint,
    pwa_installed: d?.display_mode === 'standalone',
  };
}

const actorOf = (a: ActorContext): EventActor => ({ type: 'user', id: a.userId });

/** `POST /v1/me/duty/start|break|end` (PNT-024; 10 §9.6; 11 §6.6). */
@Injectable()
export class DutyService {
  async start(
    tx: Tx,
    actor: ActorContext,
    body: { venue_id?: string | null; device_id?: string | null },
    requestId: string,
  ): Promise<{
    duty_session: ReturnType<typeof dutySessionView>;
    driver_state: DriverState;
    checks: object;
  }> {
    let venueId: string;
    if (actor.role === 'driver') {
      if (!actor.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
      venueId = actor.assignment.venueId;
      if (body.venue_id && body.venue_id !== venueId)
        throw new AppError('SCOPE_VENUE_DENIED', { venue_id: body.venue_id });
    } else if (body.venue_id) {
      assertExplicitVenue(actor, body.venue_id);
      venueId = body.venue_id;
    } else if (actor.venueIds.size === 1) {
      venueId = [...actor.venueIds][0]!;
    } else {
      throw new AppError('VALIDATION_FAILED', {
        fields: [
          { field: 'venue_id', issue: actor.venueIds.size ? 'required_multiple_venues' : 'no_venue_scope' },
        ],
      });
    }
    if (actor.duty) throw new AppError('DUTY_ALREADY_STARTED', { duty_session_id: actor.duty.id });

    const pool = await findDefaultDispatchPool(tx, venueId);
    if (!pool || pool.status !== 'active') throw new AppError('SHIFT_NOT_OPEN', { venue_id: venueId });
    await lockPools(tx, [pool.id]); // L1

    // TOCTOU (09 §8.4): assignment, account status and scope re-read under the locks
    if (actor.role === 'driver') {
      const [a] = await lockAssignments(tx, [actor.assignment!.id]); // L3
      if (!a || a.status !== 'active' || a.venue_id !== venueId) throw new AppError('ASSIGNMENT_REQUIRED');
    }
    const [u] = await lockUsers(tx, [actor.userId]); // L3
    if (!u || u.status !== 'active') throw new AppError('DRIVER_DISABLED');
    if (actor.role !== 'driver') {
      if (!u.can_drive)
        throw new AppError('PERMISSION_DENIED', { permission: 'duty.self', reason: 'can_drive_revoked' });
      const scope = await tx.maybeOne(
        `SELECT 1 FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL AND (scope_type = 'org' OR venue_id = $2) LIMIT 1`,
        [actor.userId, venueId],
      );
      if (!scope) throw new AppError('SCOPE_VENUE_DENIED', { venue_id: venueId });
    }
    // read under L1 only: shift close holds the same pool lock while it ends the sessions (venues-events contract)
    const shift = await findOpenShiftForPool(tx, pool.id);
    if (!shift) throw new AppError('SHIFT_NOT_OPEN', { venue_id: venueId });
    const [open] = await lockOpenDutyByUsers<DutyRow>(tx, [actor.userId]); // L8
    if (open) throw new AppError('DUTY_ALREADY_STARTED', { duty_session_id: open.id });

    const duty = await tx.one<DutyRow>(
      `INSERT INTO duty_sessions (id, org_id, user_id, shift_id, venue_id, dispatch_pool_id, assignment_id, status,
                                  started_at, available_since, last_heartbeat_at, connection_state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'on_duty', $8, $8, $8, 'online', $8, $8) RETURNING *`,
      [
        newId(),
        actor.orgId,
        actor.userId,
        shift.id,
        venueId,
        pool.id,
        actor.role === 'driver' ? actor.assignment!.id : null,
        tx.now,
      ],
    );
    await emitEvent(tx, {
      type: 'driver.duty_started',
      orgId: actor.orgId,
      venueId,
      dispatchPoolId: pool.id,
      aggregate: { type: 'duty_session', id: duty.id, version: duty.version },
      actor: actorOf(actor),
      payload: {
        user_id: actor.userId,
        duty_session_id: duty.id,
        shift_id: shift.id,
        dispatch_pool_id: pool.id,
      },
    });
    await emitAvailability(tx, actor.userId, actorOf(actor));
    await runDispatchPass(tx, pool.id, 'driver_available');
    await ensureHeartbeatSweep(tx, actor.orgId); // PNT-062: connection state from the heartbeats
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'duty.self',
      entityType: 'duty_session',
      entityId: duty.id,
      venueId,
      requestId,
      after: { status: 'on_duty', shift_id: shift.id, dispatch_pool_id: pool.id },
      metadata: { operation: 'POST /v1/me/duty/start' },
    });
    const fresh = await tx.one<DutyRow>(`SELECT * FROM duty_sessions WHERE id = $1`, [duty.id]);
    return {
      duty_session: dutySessionView(fresh),
      driver_state: await currentDriverState(tx, actor.userId),
      checks: await deviceChecks(tx, actor, body.device_id),
    };
  }

  async setBreak(tx: Tx, actor: ActorContext, body: { active: boolean }, requestId: string) {
    if (!actor.duty) throw new AppError('DUTY_REQUIRED');
    const poolId = actor.duty.poolId;
    await lockPools(tx, [poolId]); // L1
    const s = await driverStateOf(tx, actor.userId);
    if (!s) throw new AppError('DUTY_REQUIRED');
    const op = 'POST /v1/me/duty/break';
    const entity = { id: s.duty_session_id, status: s.duty_status, version: s.version };
    let updated: DutyRow;
    if (body.active) {
      if (s.duty_status === 'on_break') throw invalidTransition('duty_session', entity, op, ['on_duty']);
      if (s.active_task_id || s.next_task_id)
        throw new AppError('DRIVER_NOT_AVAILABLE', {
          active_task_id: s.active_task_id,
          next_task_id: s.next_task_id,
        });
      const held = (await dutyItems(tx, actor.userId)).filter(
        (i) => i.type === 'vehicle' || i.type === 'key',
      );
      if (held.length)
        throw new AppError('CUSTODY_OPEN', { items: held.map((i) => ({ ...i, holder_type: 'driver' })) });
      await revokeDriverSingleOffers(tx, actor.userId, 'recipient_unavailable', actorOf(actor));
      const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [actor.userId]); // L8
      updated = await tx.one<DutyRow>(
        `UPDATE duty_sessions SET status = 'on_break', available_since = NULL, version = version + 1
          WHERE id = $1 RETURNING *`,
        [duty!.id],
      );
      await emitEvent(tx, {
        type: 'driver.break_started',
        orgId: actor.orgId,
        venueId: updated.venue_id,
        dispatchPoolId: poolId,
        aggregate: { type: 'duty_session', id: updated.id, version: updated.version },
        actor: actorOf(actor),
        payload: { user_id: actor.userId, duty_session_id: updated.id },
      });
      await emitAvailability(tx, actor.userId, actorOf(actor));
      await runDispatchPass(tx, poolId, 'recipient_unavailable');
    } else {
      if (s.duty_status !== 'on_break') throw invalidTransition('duty_session', entity, op, ['on_break']);
      const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [actor.userId]); // L8
      updated = await tx.one<DutyRow>(
        `UPDATE duty_sessions SET status = 'on_duty', available_since = $2, version = version + 1
          WHERE id = $1 RETURNING *`,
        [duty!.id, tx.now],
      );
      await emitEvent(tx, {
        type: 'driver.break_ended',
        orgId: actor.orgId,
        venueId: updated.venue_id,
        dispatchPoolId: poolId,
        aggregate: { type: 'duty_session', id: updated.id, version: updated.version },
        actor: actorOf(actor),
        payload: { user_id: actor.userId, duty_session_id: updated.id },
      });
      await emitAvailability(tx, actor.userId, actorOf(actor));
      await runDispatchPass(tx, poolId, 'driver_available');
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'duty.self',
      entityType: 'duty_session',
      entityId: updated.id,
      venueId: updated.venue_id,
      requestId,
      before: { status: s.duty_status },
      after: { status: updated.status },
      metadata: { operation: op, active: body.active },
    });
    return dutySessionView(updated);
  }

  async end(tx: Tx, actor: ActorContext, requestId: string) {
    if (!actor.duty) throw new AppError('DUTY_REQUIRED');
    const poolId = actor.duty.poolId;
    await lockPools(tx, [poolId]); // L1
    const items = await dutyItems(tx, actor.userId);
    if (items.length) throw new AppError('DUTY_END_BLOCKED_CUSTODY', { items });
    await revokeDriverSingleOffers(tx, actor.userId, 'recipient_unavailable', actorOf(actor));
    const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [actor.userId]); // L8
    if (!duty) throw new AppError('DUTY_REQUIRED');
    const ended = await tx.one<DutyRow>(
      `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'self',
              available_since = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [duty.id, tx.now, actor.userId],
    );
    await emitEvent(tx, {
      type: 'driver.duty_ended',
      orgId: actor.orgId,
      venueId: ended.venue_id,
      dispatchPoolId: poolId,
      aggregate: { type: 'duty_session', id: ended.id, version: ended.version },
      actor: actorOf(actor),
      payload: {
        user_id: actor.userId,
        duty_session_id: ended.id,
        end_reason: 'self',
        ended_by: actor.userId,
      },
    });
    await emitAvailability(tx, actor.userId, actorOf(actor), ended);
    // broadcast recipient rows stay for history: he can no longer accept (DUTY_REQUIRED, 10 §9.6)
    await runDispatchPass(tx, poolId, 'recipient_unavailable');
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'duty.self',
      entityType: 'duty_session',
      entityId: ended.id,
      venueId: ended.venue_id,
      requestId,
      before: { status: duty.status },
      after: { status: 'ended', end_reason: 'self' },
      metadata: { operation: 'POST /v1/me/duty/end' },
    });
    return dutySessionView(ended);
  }

  /**
   * `POST /v1/duty-sessions/{sessionId}/force-end` (PNT-084; 10 §9.5, DEC-32): the supervisor ends the duty of a
   * driver who left or lost his connection. Refused without any change (no override) while the driver holds a
   * vehicle or a key, or has a task in progress or an active park/repark (DUTY_END_BLOCKED_CUSTODY with the items,
   * until they are transferred officially). Otherwise his live single offers are revoked, his reserved next task
   * and an accepted retrieval whose key is not picked up go back to the queue with their priority
   * (`task.withdrawn`, new episodes), then the session ends (`forced`), the driver's devices get `sync.required`
   * and the pool gets a pass. Broadcast recipient rows stay; he can no longer accept (DUTY_REQUIRED).
   * Locks: L1 pool → L3 user (serializes with transfer and disable) → the release (L4–L8) → L8 session.
   */
  async forceEnd(
    tx: Tx,
    actor: ActorContext,
    sessionId: string,
    body: { reason: string },
    requestId: string,
  ) {
    const op = 'POST /v1/duty-sessions/{sessionId}/force-end';
    const pre = await tx.maybeOne<DutyRow>(`SELECT * FROM duty_sessions WHERE id = $1 AND org_id = $2`, [
      sessionId,
      actor.orgId,
    ]);
    if (!pre || !actor.venueIds.has(pre.venue_id))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'duty_session' });
    const entity = { id: pre.id, status: pre.status, version: pre.version };
    if (pre.status === 'ended') throw invalidTransition('duty_session', entity, op, ['on_duty', 'on_break']);
    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    await lockUsers(tx, [pre.user_id]); // L3
    const items = await blockingCustody(tx, pre.user_id);
    if (items.length)
      throw new AppError('DUTY_END_BLOCKED_CUSTODY', {
        items: items.map((i) => ({
          type: i.type,
          ticket_id: i.ticket_id,
          display_number: i.display_number ?? null,
          ...(i.task_id ? { task_id: i.task_id } : {}),
        })),
      });
    const reason = body.reason.trim();
    await releaseDriverWork(tx, {
      orgId: actor.orgId,
      driverId: pre.user_id,
      poolId: pre.dispatch_pool_id,
      reason: 'forced',
      actorId: actor.userId,
    });
    const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [pre.user_id]); // L8
    if (!duty || duty.id !== pre.id)
      throw invalidTransition('duty_session', { ...entity, status: 'ended' }, op, ['on_duty', 'on_break']);
    const ended = await tx.one<DutyRow>(
      `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'forced',
              available_since = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [duty.id, tx.now, actor.userId],
    );
    await emitEvent(tx, {
      type: 'driver.duty_ended',
      orgId: actor.orgId,
      venueId: ended.venue_id,
      dispatchPoolId: ended.dispatch_pool_id,
      aggregate: { type: 'duty_session', id: ended.id, version: ended.version },
      actor: actorOf(actor),
      payload: {
        user_id: ended.user_id,
        duty_session_id: ended.id,
        end_reason: 'forced',
        ended_by: actor.userId,
      },
    });
    await emitAvailability(tx, ended.user_id, actorOf(actor), ended);
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'duty.force_end',
      entityType: 'duty_session',
      entityId: ended.id,
      venueId: ended.venue_id,
      requestId,
      reason,
      before: { status: duty.status },
      after: { status: 'ended', end_reason: 'forced' },
      metadata: { operation: op, driver_id: ended.user_id },
    });
    return dutySessionView(ended);
  }
}
