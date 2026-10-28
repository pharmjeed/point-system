import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { lockOpenDutyByUsers, lockPools, lockUsers } from '../../../core/db/locks.js';
import { AppError } from '../../../core/errors/app-error.js';
import { releaseDriverWork } from '../../../core/hooks/driver-release.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { normalizePhone } from '../../../core/phone.js';
import { newId } from '../../../core/crypto/ids.js';
import { rooms } from '@point/shared';
import { ENV } from '../../../http/tokens.js';
import { SecretHasher } from '../infra/secret-hasher.js';
import { nextEmployeeCode, temporaryPassword, temporaryPin } from './codes.js';
import { revokeSessions } from './sessions.js';
import { assignmentView, canSeeFullPhone, userView, type UserRow } from './views.js';

type Q = Pick<Tx, 'query'> | Pick<Database, 'query'>;

export interface CustodyItem {
  type: 'vehicle' | 'key' | 'task';
  ticket_id: string;
  display_number?: number;
  task_id?: string;
  task_type?: string;
  task_status?: string;
}

/**
 * DEC-32 blocking items: vehicle or key held, a task in progress, or an active park/repark task.
 * (A reserved next task or an accepted retrieval before key pickup are released instead.)
 */
export async function blockingCustody(q: Q, userId: string): Promise<CustodyItem[]> {
  const r = await q.query<CustodyItem & { kind: string }>(
    `SELECT 'vehicle' AS type, t.id AS ticket_id, t.display_number, NULL::uuid AS task_id, NULL AS task_type, NULL AS task_status
       FROM tickets t WHERE t.vehicle_holder_type = 'driver' AND t.vehicle_holder_id = $1 AND t.status NOT IN ('delivered','voided')
     UNION ALL
     SELECT 'key', t.id, t.display_number, NULL, NULL, NULL
       FROM tickets t WHERE t.key_holder_type = 'driver' AND t.key_holder_id = $1 AND t.status NOT IN ('delivered','voided')
     UNION ALL
     SELECT 'task', k.ticket_id, t.display_number, k.id, k.type, k.status
       FROM tasks k JOIN tickets t ON t.id = k.ticket_id
      WHERE k.assignee_id = $1 AND (k.status = 'in_progress' OR (k.type IN ('park','repark') AND k.status IN ('accepted','in_progress')))`,
    [userId],
  );
  // a task row and its held items describe the same ticket; keep all for the supervisor's view
  return r.rows.map(
    (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null)) as CustodyItem,
  );
}

/** Drivers, assignments and staff administration (PNT-015, PNT-016, PNT-017). */
@Injectable()
export class AdminService {
  readonly hasher: SecretHasher;
  constructor(@Inject(ENV) env: Env) {
    this.hasher = new SecretHasher(env.AUTH_SECRET_PEPPER);
  }

  // ------------------------------------------------------------------ drivers

  async listDrivers(
    q: Q,
    actor: ActorContext,
    f: {
      venue_id?: string;
      status?: string;
      driver_state?: string;
      q?: string;
      limit: number;
      cursor?: string;
    },
  ) {
    const after = f.cursor ? decodeCursor(f.cursor) : null;
    const params: unknown[] = [
      actor.orgId,
      actor.orgScope ? null : [...actor.venueIds],
      f.venue_id ?? null,
      f.status ?? null,
      f.q ? `%${f.q}%` : null,
      f.driver_state ?? null,
    ];
    let where = `u.org_id = $1 AND u.role = 'driver'
      AND ($2::uuid[] IS NULL OR a.venue_id = ANY($2::uuid[]))
      AND ($3::uuid IS NULL OR a.venue_id = $3)
      AND ($4::text IS NULL OR u.status = $4)
      AND ($5::text IS NULL OR u.full_name ILIKE $5 OR u.employee_code ILIKE $5)
      AND ($6::text IS NULL OR COALESCE(s.driver_state, 'off_duty') = $6)`;
    if (after) {
      params.push(after.created_at, after.id);
      where += ` AND (u.created_at, u.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(f.limit + 1);
    const rows = await q.query(
      `SELECT u.*, a.id AS a_id, a.venue_id AS a_venue_id, v.name_ar AS a_venue_name_ar, a.status AS a_status, a.starts_at AS a_starts_at,
              a.ends_at AS a_ends_at, a.reason AS a_reason, a.transfer_id AS a_transfer_id,
              s.driver_state, s.connection_state, s.last_heartbeat_at, s.available_since, s.active_task_id, s.next_task_id, d.started_at AS duty_started_at
         FROM users u
         LEFT JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
         LEFT JOIN venues v ON v.id = a.venue_id
         LEFT JOIN v_driver_state s ON s.user_id = u.id
         LEFT JOIN duty_sessions d ON d.id = s.duty_session_id
        WHERE ${where}
        ORDER BY u.created_at, u.id
        LIMIT $${params.length}`,
      params,
    );
    const page = rows.rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      data: page.map((r: any) => driverListItem(r, actor)),
      next_cursor:
        rows.rows.length > f.limit && last
          ? encodeCursor({ created_at: new Date(last.created_at).toISOString(), id: last.id })
          : null,
    };
  }

  async getDriver(q: Q, actor: ActorContext, driverId: string) {
    const r = await q.query(
      `SELECT u.*, a.id AS a_id, a.venue_id AS a_venue_id, v.name_ar AS a_venue_name_ar, a.status AS a_status, a.starts_at AS a_starts_at,
              a.ends_at AS a_ends_at, a.reason AS a_reason, a.transfer_id AS a_transfer_id,
              s.driver_state, s.connection_state, s.last_heartbeat_at, s.available_since, s.active_task_id, s.next_task_id, d.started_at AS duty_started_at
         FROM users u
         LEFT JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
         LEFT JOIN venues v ON v.id = a.venue_id
         LEFT JOIN v_driver_state s ON s.user_id = u.id
         LEFT JOIN duty_sessions d ON d.id = s.duty_session_id
        WHERE u.id = $1 AND u.org_id = $2 AND u.role = 'driver'`,
      [driverId, actor.orgId],
    );
    const row = r.rows[0];
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    assertDriverInScope(actor, row.a_venue_id);
    return driverListItem(row, actor);
  }

  async createDriver(
    tx: Tx,
    actor: ActorContext,
    body: { full_name: string; phone: string; employee_code?: string; initial_venue_id?: string | null },
    requestId: string,
  ) {
    const phone = normalizePhone(body.phone);
    if (!phone) throw new AppError('PHONE_INVALID', { fields: [{ field: 'phone', issue: 'invalid' }] });
    if (body.initial_venue_id) await assertVenueInOrg(tx, actor, body.initial_venue_id);
    const code = body.employee_code?.trim() || (await nextEmployeeCode(tx, actor.orgId, 'D'));
    const pin = temporaryPin({ phoneE164: phone, employeeCode: code });
    const u = await tx.one<UserRow>(
      `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, can_drive, secret_kind, secret_hash, must_change_secret, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'driver', false, 'pin', $6, true, $7, $8) RETURNING *`,
      [
        newId(),
        actor.orgId,
        code,
        body.full_name.trim(),
        phone,
        await this.hasher.hash(pin),
        actor.userId,
        tx.now,
      ],
    );
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      after: { command: 'create', employee_code: code, role: 'driver' },
    });
    let assignment = null;
    if (body.initial_venue_id)
      assignment = await this.insertAssignment(tx, actor, u.id, body.initial_venue_id, null, requestId);
    return {
      driver: userView(u, { fullPhone: canSeeFullPhone(actor, u.id) }),
      temporary_secret: pin,
      assignment,
    };
  }

  async patchDriver(
    tx: Tx,
    actor: ActorContext,
    driverId: string,
    body: { expected_version: number; full_name?: string; phone?: string; employee_code?: string },
    requestId: string,
  ) {
    const [u] = await lockUsers(tx, [driverId]);
    if (!u || u.org_id !== actor.orgId || u.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    if (u.version !== body.expected_version)
      throw new AppError('VERSION_CONFLICT', { entity: 'user', id: u.id, current_version: u.version });
    const phone = body.phone !== undefined ? normalizePhone(body.phone) : u.phone_e164;
    if (!phone) throw new AppError('PHONE_INVALID', { fields: [{ field: 'phone', issue: 'invalid' }] });
    const updated = await tx.one<UserRow>(
      `UPDATE users SET full_name = $3, phone_e164 = $4, employee_code = $5, version = version + 1 WHERE id = $1 AND version = $2 RETURNING *`,
      [
        u.id,
        u.version,
        body.full_name?.trim() ?? u.full_name,
        phone,
        body.employee_code?.trim() ?? u.employee_code,
      ],
    );
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      before: {
        full_name: u.full_name,
        employee_code: u.employee_code,
        phone_changed: phone !== u.phone_e164,
      },
      after: { full_name: updated.full_name, employee_code: updated.employee_code },
    });
    return userView(updated, { fullPhone: canSeeFullPhone(actor, updated.id) });
  }

  /**
   * PNT-015 AC2/AC3 + DEC-32: refused with CUSTODY_OPEN (items) when the driver holds a vehicle/key, has a task
   * in progress or an active park/repark; otherwise his reserved next task and pre-pickup accepted retrieval are
   * released to the queue, his live single offers revoked, his duty ended (`disabled`), sessions revoked
   * (`disabled`), push subscriptions removed, and `driver.disabled` + `session.revoked` published.
   */
  async disableDriver(
    tx: Tx,
    actor: ActorContext,
    driverId: string,
    body: { reason: string },
    requestId: string,
  ) {
    const pre = await tx.maybeOne<{
      org_id: string;
      role: string;
      status: string;
      pool_id: string | null;
      venue_id: string | null;
    }>(
      `SELECT u.org_id, u.role, u.status, d.dispatch_pool_id AS pool_id, a.venue_id
         FROM users u LEFT JOIN duty_sessions d ON d.user_id = u.id AND d.status <> 'ended'
         LEFT JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
        WHERE u.id = $1`,
      [driverId],
    );
    if (!pre || pre.org_id !== actor.orgId || pre.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    if (pre.pool_id) await lockPools(tx, [pre.pool_id]); // L1: availability changes
    const [u] = await lockUsers(tx, [driverId]); // L3
    if (u.status !== 'active')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: u.id,
        current_status: u.status,
        allowed_from: ['active'],
      });
    const items = await blockingCustody(tx, driverId);
    if (items.length) throw new AppError('CUSTODY_OPEN', { items });
    await releaseDriverWork(tx, {
      orgId: actor.orgId,
      driverId,
      poolId: pre.pool_id,
      reason: 'disabled',
      actorId: actor.userId,
    });
    const [duty] = await lockOpenDutyByUsers<{
      id: string;
      venue_id: string;
      dispatch_pool_id: string;
      version: number;
    }>(tx, [driverId]); // L8
    if (duty) {
      const d = await tx.one<{ version: number }>(
        `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'disabled', available_since = NULL, version = version + 1
          WHERE id = $1 RETURNING version`,
        [duty.id, tx.now, actor.userId],
      );
      await emitEvent(tx, {
        type: 'driver.duty_ended',
        orgId: actor.orgId,
        venueId: duty.venue_id,
        dispatchPoolId: duty.dispatch_pool_id,
        aggregate: { type: 'duty_session', id: duty.id, version: d.version },
        actor: { type: 'user', id: actor.userId },
        payload: { user_id: driverId, duty_session_id: duty.id, end_reason: 'disabled' },
      });
    }
    const updated = await tx.one<UserRow>(
      `UPDATE users SET status = 'disabled', disabled_at = $2, disabled_by = $3, disabled_reason = $4, version = version + 1 WHERE id = $1 RETURNING *`,
      [driverId, tx.now, actor.userId, body.reason.trim()],
    );
    const revoked = await revokeSessions(tx, driverId, 'disabled');
    await tx.query(
      `UPDATE devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL, push_subscribed_at = NULL WHERE user_id = $1`,
      [driverId],
    );
    await emitEvent(tx, {
      type: 'driver.disabled',
      orgId: actor.orgId,
      venueId: pre.venue_id,
      aggregate: { type: 'user', id: driverId, version: updated.version },
      actor: { type: 'user', id: actor.userId },
      payload: { user_id: driverId, sessions_revoked: revoked.length },
    });
    await publishRealtime(tx, actor.orgId, [rooms.user(driverId)], {
      event: 'session.revoked',
      id: newId(),
      aggregate: { type: 'user', id: driverId, version: updated.version },
      data: { reason: 'disabled' },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.manage',
      entityType: 'user',
      entityId: driverId,
      venueId: pre.venue_id,
      requestId,
      reason: body.reason,
      before: { status: 'active' },
      after: { status: 'disabled', command: 'disable' },
    });
    return userView(updated, { fullPhone: canSeeFullPhone(actor, driverId) });
  }

  async enableDriver(tx: Tx, actor: ActorContext, driverId: string, requestId: string) {
    const [u] = await lockUsers(tx, [driverId]);
    if (!u || u.org_id !== actor.orgId || u.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    if (u.status !== 'disabled')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: u.id,
        current_status: u.status,
        allowed_from: ['disabled'],
      });
    const updated = await tx.one<UserRow>(
      `UPDATE users SET status = 'active', disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL, failed_login_count = 0, locked_until = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
      [driverId],
    );
    await emitEvent(tx, {
      type: 'driver.enabled',
      orgId: actor.orgId,
      aggregate: { type: 'user', id: driverId, version: updated.version },
      actor: { type: 'user', id: actor.userId },
      payload: { user_id: driverId },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.manage',
      entityType: 'user',
      entityId: driverId,
      requestId,
      before: { status: 'disabled' },
      after: { status: 'active', command: 'enable' },
    });
    return userView(updated, { fullPhone: canSeeFullPhone(actor, driverId) });
  }

  async resetDriverSecret(tx: Tx, actor: ActorContext, driverId: string, requestId: string) {
    const [u] = await lockUsers(tx, [driverId]);
    if (!u || u.org_id !== actor.orgId || u.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    if (u.status !== 'active') throw new AppError('DRIVER_DISABLED');
    const pin = temporaryPin({ phoneE164: u.phone_e164, employeeCode: u.employee_code });
    await tx.query(
      `UPDATE users SET secret_hash = $2, must_change_secret = true, failed_login_count = 0, locked_until = NULL, version = version + 1 WHERE id = $1`,
      [u.id, await this.hasher.hash(pin)],
    );
    await revokeSessions(tx, u.id, 'secret_reset');
    await publishRealtime(tx, actor.orgId, [rooms.user(u.id)], {
      event: 'session.revoked',
      id: newId(),
      data: { reason: 'secret_reset' },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      after: { command: 'reset_secret' },
    });
    return { temporary_secret: pin };
  }

  // -------------------------------------------------------------- assignments

  async listAssignments(q: Q, actor: ActorContext, driverId: string) {
    const d = await q.query<{ org_id: string; role: string }>(
      `SELECT org_id, role FROM users WHERE id = $1`,
      [driverId],
    );
    if (!d.rows[0] || d.rows[0].org_id !== actor.orgId || d.rows[0].role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    const [assignments, transfers] = await Promise.all([
      q.query(
        `SELECT a.*, v.name_ar AS venue_name_ar FROM driver_assignments a JOIN venues v ON v.id = a.venue_id WHERE a.driver_id = $1 ORDER BY a.starts_at DESC`,
        [driverId],
      ),
      q.query(`SELECT * FROM driver_transfers WHERE driver_id = $1 ORDER BY created_at DESC`, [driverId]),
    ]);
    if (!actor.orgScope) {
      const active = assignments.rows.find((a: any) => a.status === 'active');
      assertDriverInScope(
        actor,
        active?.venue_id ?? null,
        assignments.rows.map((a: any) => a.venue_id),
      );
    }
    return {
      assignments: assignments.rows.map((a: any) => assignmentView(a)),
      transfers: transfers.rows.map((t: any) => ({
        id: t.id,
        driver_id: t.driver_id,
        from_venue_id: t.from_venue_id,
        to_venue_id: t.to_venue_id,
        scheduled_at: new Date(t.scheduled_at).toISOString(),
        status: t.status,
        reason: t.reason,
        blocked_details: t.blocked_details,
        requested_by: t.requested_by,
        approved_by: t.approved_by,
        completed_at: t.completed_at ? new Date(t.completed_at).toISOString() : null,
        canceled_at: t.canceled_at ? new Date(t.canceled_at).toISOString() : null,
        version: t.version,
      })),
    };
  }

  /** PNT-016: a second active assignment → ASSIGNMENT_CONFLICT (uq_driver_assignments_active); scope enforced. */
  async createAssignment(
    tx: Tx,
    actor: ActorContext,
    driverId: string,
    body: { venue_id: string; reason?: string | null },
    requestId: string,
  ) {
    const [u] = await lockUsers(tx, [driverId]);
    if (!u || u.org_id !== actor.orgId || u.role !== 'driver')
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' });
    if (!actor.orgScope && !actor.venueIds.has(body.venue_id))
      throw new AppError('SCOPE_VENUE_DENIED', { venue_id: body.venue_id });
    await assertVenueInOrg(tx, actor, body.venue_id);
    if (u.status !== 'active') throw new AppError('DRIVER_DISABLED');
    return this.insertAssignment(tx, actor, driverId, body.venue_id, body.reason ?? null, requestId);
  }

  private async insertAssignment(
    tx: Tx,
    actor: ActorContext,
    driverId: string,
    venueId: string,
    reason: string | null,
    requestId: string,
  ) {
    const a = await tx.one(
      `INSERT INTO driver_assignments (org_id, driver_id, venue_id, status, starts_at, reason, created_by, approved_by, created_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $6, $4) RETURNING *, (SELECT name_ar FROM venues WHERE id = $3) AS venue_name_ar`,
      [actor.orgId, driverId, venueId, tx.now, reason, actor.userId],
    );
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'driver.assign',
      entityType: 'driver_assignment',
      entityId: a.id,
      venueId,
      requestId,
      reason,
      after: { driver_id: driverId, venue_id: venueId },
    });
    return assignmentView(a);
  }

  // -------------------------------------------------------------------- staff

  async listStaff(
    q: Q,
    actor: ActorContext,
    f: { role?: string; status?: string; limit: number; cursor?: string },
  ) {
    const roles = actor.role === 'owner' ? ['admin', 'supervisor'] : ['supervisor'];
    const after = f.cursor ? decodeCursor(f.cursor) : null;
    const params: unknown[] = [actor.orgId, roles, f.role ?? null, f.status ?? null];
    let where = `u.org_id = $1 AND u.role = ANY($2::text[]) AND ($3::text IS NULL OR u.role = $3) AND ($4::text IS NULL OR u.status = $4)`;
    if (after) {
      params.push(after.created_at, after.id);
      where += ` AND (u.created_at, u.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(f.limit + 1);
    const users = await q.query<UserRow>(
      `SELECT u.* FROM users u WHERE ${where} ORDER BY u.created_at, u.id LIMIT $${params.length}`,
      params,
    );
    const page = users.rows.slice(0, f.limit);
    const scopes = page.length
      ? await q.query(
          `SELECT id, user_id, scope_type, venue_id, granted_at FROM role_scopes WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [page.map((u) => u.id)],
        )
      : { rows: [] as any[] };
    const last = page.at(-1);
    return {
      data: page.map((u) => ({
        user: userView(u, { fullPhone: canSeeFullPhone(actor, u.id) }),
        scopes: scopes.rows.filter((s: any) => s.user_id === u.id).map(scopeView),
      })),
      next_cursor:
        users.rows.length > f.limit && last
          ? encodeCursor({ created_at: new Date(last.created_at).toISOString(), id: last.id })
          : null,
    };
  }

  /** PNT-017: admins manage supervisors only, the owner manages admins; can_drive only for supervisors. */
  async createStaff(
    tx: Tx,
    actor: ActorContext,
    body: {
      full_name: string;
      phone: string;
      role: 'admin' | 'supervisor';
      can_drive?: boolean;
      venue_ids?: string[];
    },
    requestId: string,
  ) {
    assertCanManageRole(actor, body.role);
    if (body.can_drive && body.role !== 'supervisor')
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'can_drive', issue: 'supervisor_only' }] });
    const phone = normalizePhone(body.phone);
    if (!phone) throw new AppError('PHONE_INVALID', { fields: [{ field: 'phone', issue: 'invalid' }] });
    for (const v of body.venue_ids ?? []) await assertVenueInOrg(tx, actor, v);
    const code = await nextEmployeeCode(tx, actor.orgId, body.role === 'admin' ? 'A' : 'S');
    const password = temporaryPassword();
    const u = await tx.one<UserRow>(
      `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, can_drive, secret_kind, secret_hash, must_change_secret, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'password', $8, true, $9, $10) RETURNING *`,
      [
        newId(),
        actor.orgId,
        code,
        body.full_name.trim(),
        phone,
        body.role,
        body.can_drive ?? false,
        await this.hasher.hash(password),
        actor.userId,
        tx.now,
      ],
    );
    if (body.role === 'admin') {
      await tx.query(
        `INSERT INTO role_scopes (org_id, user_id, scope_type, granted_by, granted_at) VALUES ($1, $2, 'org', $3, $4)`,
        [actor.orgId, u.id, actor.userId, tx.now],
      );
    }
    for (const v of new Set(body.venue_ids ?? [])) {
      if (body.role === 'supervisor') {
        await tx.query(
          `INSERT INTO role_scopes (org_id, user_id, scope_type, venue_id, granted_by, granted_at) VALUES ($1, $2, 'venue', $3, $4, $5)`,
          [actor.orgId, u.id, v, actor.userId, tx.now],
        );
      }
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'staff.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      after: { command: 'create', role: body.role, can_drive: u.can_drive, venue_ids: body.venue_ids ?? [] },
    });
    return { user: userView(u, { fullPhone: canSeeFullPhone(actor, u.id) }), temporary_secret: password };
  }

  async patchStaff(
    tx: Tx,
    actor: ActorContext,
    userId: string,
    body: {
      expected_version: number;
      full_name?: string;
      phone?: string;
      can_drive?: boolean;
      status?: 'active' | 'disabled';
      reason?: string;
    },
    requestId: string,
  ) {
    const pre = await tx.maybeOne<{ org_id: string; role: string; pool_id: string | null }>(
      `SELECT u.org_id, u.role, d.dispatch_pool_id AS pool_id FROM users u LEFT JOIN duty_sessions d ON d.user_id = u.id AND d.status <> 'ended' WHERE u.id = $1`,
      [userId],
    );
    if (!pre || pre.org_id !== actor.orgId || (pre.role !== 'admin' && pre.role !== 'supervisor'))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
    assertCanManageRole(actor, pre.role as 'admin' | 'supervisor');
    if (body.status === 'disabled' && pre.pool_id) await lockPools(tx, [pre.pool_id]);
    const [u] = await lockUsers(tx, [userId]);
    if (u.version !== body.expected_version)
      throw new AppError('VERSION_CONFLICT', { entity: 'user', id: u.id, current_version: u.version });
    if (body.can_drive !== undefined && body.can_drive && u.role !== 'supervisor')
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'can_drive', issue: 'supervisor_only' }] });
    if (body.status !== undefined && body.status !== u.status && !body.reason?.trim())
      throw new AppError('REASON_REQUIRED');
    const phone = body.phone !== undefined ? normalizePhone(body.phone) : u.phone_e164;
    if (!phone) throw new AppError('PHONE_INVALID', { fields: [{ field: 'phone', issue: 'invalid' }] });
    const disabling = body.status === 'disabled' && u.status === 'active';
    if (disabling) {
      const items = await blockingCustody(tx, userId);
      if (items.length) throw new AppError('CUSTODY_OPEN', { items });
      await releaseDriverWork(tx, {
        orgId: actor.orgId,
        driverId: userId,
        poolId: pre.pool_id,
        reason: 'disabled',
        actorId: actor.userId,
      });
      const [duty] = await lockOpenDutyByUsers<{ id: string }>(tx, [userId]);
      if (duty) {
        await tx.query(
          `UPDATE duty_sessions SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'disabled', available_since = NULL, version = version + 1 WHERE id = $1`,
          [duty.id, tx.now, actor.userId],
        );
      }
    }
    const status = body.status ?? u.status;
    const updated = await tx.one<UserRow>(
      `UPDATE users SET full_name = $2, phone_e164 = $3, can_drive = $4, status = $5,
              disabled_at = CASE WHEN $5 = 'disabled' THEN COALESCE(disabled_at, $6) ELSE NULL END,
              disabled_by = CASE WHEN $5 = 'disabled' THEN COALESCE(disabled_by, $7) ELSE NULL END,
              disabled_reason = CASE WHEN $5 = 'disabled' THEN COALESCE($8, disabled_reason) ELSE NULL END,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [
        u.id,
        body.full_name?.trim() ?? u.full_name,
        phone,
        body.can_drive ?? u.can_drive,
        status,
        tx.now,
        actor.userId,
        body.reason?.trim() ?? null,
      ],
    );
    if (disabling) {
      await revokeSessions(tx, u.id, 'disabled');
      await publishRealtime(tx, actor.orgId, [rooms.user(u.id)], {
        event: 'session.revoked',
        id: newId(),
        data: { reason: 'disabled' },
      });
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'staff.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      reason: body.reason ?? null,
      before: { full_name: u.full_name, can_drive: u.can_drive, status: u.status },
      after: {
        full_name: updated.full_name,
        can_drive: updated.can_drive,
        status: updated.status,
        phone_changed: phone !== u.phone_e164,
      },
    });
    return userView(updated, { fullPhone: canSeeFullPhone(actor, u.id) });
  }

  /** Grant/revoke venue scopes (supervisors) or the org scope (admins, owner only). Both audited (PNT-017 AC3). */
  async updateScopes(
    tx: Tx,
    actor: ActorContext,
    userId: string,
    body: { grant_venue_ids?: string[]; revoke_venue_ids?: string[]; org_scope?: boolean },
    requestId: string,
  ) {
    const [u] = await lockUsers(tx, [userId]);
    if (!u || u.org_id !== actor.orgId || (u.role !== 'admin' && u.role !== 'supervisor'))
      throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
    assertCanManageRole(actor, u.role as 'admin' | 'supervisor');
    if (body.org_scope !== undefined && u.role !== 'admin')
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'org_scope', issue: 'admin_only' }] });
    if ((body.grant_venue_ids?.length || body.revoke_venue_ids?.length) && u.role !== 'supervisor') {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'grant_venue_ids', issue: 'supervisor_only' }],
      });
    }
    for (const v of body.grant_venue_ids ?? []) {
      await assertVenueInOrg(tx, actor, v);
      // idempotent: an existing active scope is kept (uq_role_scopes_venue_active, 08 §5.1)
      await tx.query(
        `INSERT INTO role_scopes (org_id, user_id, scope_type, venue_id, granted_by, granted_at) VALUES ($1, $2, 'venue', $3, $4, $5)
         ON CONFLICT (user_id, venue_id) WHERE scope_type = 'venue' AND revoked_at IS NULL DO NOTHING`,
        [actor.orgId, u.id, v, actor.userId, tx.now],
      );
    }
    for (const v of body.revoke_venue_ids ?? []) {
      await tx.query(
        `UPDATE role_scopes SET revoked_at = $3, revoked_by = $4 WHERE user_id = $1 AND venue_id = $2 AND revoked_at IS NULL`,
        [u.id, v, tx.now, actor.userId],
      );
    }
    if (body.org_scope === true) {
      await tx.query(
        `INSERT INTO role_scopes (org_id, user_id, scope_type, granted_by, granted_at) VALUES ($1, $2, 'org', $3, $4)
         ON CONFLICT (user_id) WHERE scope_type = 'org' AND revoked_at IS NULL DO NOTHING`,
        [actor.orgId, u.id, actor.userId, tx.now],
      );
    } else if (body.org_scope === false) {
      await tx.query(
        `UPDATE role_scopes SET revoked_at = $2, revoked_by = $3 WHERE user_id = $1 AND scope_type = 'org' AND revoked_at IS NULL`,
        [u.id, tx.now, actor.userId],
      );
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'staff.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      after: {
        command: 'scopes',
        grant: body.grant_venue_ids ?? [],
        revoke: body.revoke_venue_ids ?? [],
        org_scope: body.org_scope ?? null,
      },
    });
    // scope changes take effect on the next request (context is loaded per request); live sockets resync
    await publishRealtime(tx, actor.orgId, [rooms.user(u.id)], {
      event: 'sync.required',
      id: newId(),
      data: { reason: 'scope_changed' },
    });
    const scopes = await tx.query(
      `SELECT id, scope_type, venue_id, granted_at FROM role_scopes WHERE user_id = $1 AND revoked_at IS NULL ORDER BY granted_at`,
      [u.id],
    );
    return scopes.rows.map(scopeView);
  }

  /** PNT-017 AC4: owner only, reason required; clears MFA and revokes the target's sessions (`admin`). */
  async resetMfa(tx: Tx, actor: ActorContext, userId: string, body: { reason: string }, requestId: string) {
    if (actor.role !== 'owner') throw new AppError('PERMISSION_DENIED', { reason: 'owner_only' });
    const [u] = await lockUsers(tx, [userId]);
    if (!u || u.org_id !== actor.orgId) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
    if (u.role !== 'admin' && u.role !== 'supervisor')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: u.id,
        reason: 'mfa_reset_admin_or_supervisor_only',
      });
    const updated = await tx.one<UserRow>(
      `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, version = version + 1 WHERE id = $1 RETURNING *`,
      [u.id],
    );
    await revokeSessions(tx, u.id, 'admin');
    await publishRealtime(tx, actor.orgId, [rooms.user(u.id)], {
      event: 'session.revoked',
      id: newId(),
      data: { reason: 'admin' },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'staff.manage',
      entityType: 'user',
      entityId: u.id,
      requestId,
      reason: body.reason,
      after: { command: 'reset_mfa' },
    });
    return userView(updated, { fullPhone: canSeeFullPhone(actor, u.id) });
  }
}

function assertCanManageRole(actor: ActorContext, role: 'admin' | 'supervisor') {
  if (role === 'admin' && actor.role !== 'owner')
    throw new AppError('PERMISSION_DENIED', { reason: 'owner_manages_admins' });
  if (role === 'supervisor' && actor.role !== 'owner' && actor.role !== 'admin')
    throw new AppError('PERMISSION_DENIED');
}

async function assertVenueInOrg(q: Q, actor: ActorContext, venueId: string) {
  const r = await q.query(`SELECT 1 FROM venues WHERE id = $1 AND org_id = $2`, [venueId, actor.orgId]);
  if (!r.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'venue' });
}

/** A supervisor sees drivers whose active (or any listed) assignment is in his venues. */
function assertDriverInScope(actor: ActorContext, activeVenueId: string | null, anyVenueIds: string[] = []) {
  if (actor.orgScope) return;
  const ok =
    (activeVenueId && actor.venueIds.has(activeVenueId)) || anyVenueIds.some((v) => actor.venueIds.has(v));
  if (!ok) throw new AppError('SCOPE_VENUE_DENIED', activeVenueId ? { venue_id: activeVenueId } : {});
}

function scopeView(s: any) {
  return {
    id: s.id,
    scope_type: s.scope_type,
    venue_id: s.venue_id,
    granted_at: new Date(s.granted_at).toISOString(),
  };
}

function driverListItem(r: any, actor: ActorContext) {
  return {
    user: userView(r as UserRow, { fullPhone: canSeeFullPhone(actor, r.id) }),
    active_assignment: r.a_id
      ? assignmentView({
          id: r.a_id,
          driver_id: r.id,
          venue_id: r.a_venue_id,
          venue_name_ar: r.a_venue_name_ar,
          status: r.a_status,
          starts_at: r.a_starts_at,
          ends_at: r.a_ends_at,
          reason: r.a_reason,
          transfer_id: r.a_transfer_id,
        })
      : null,
    live: r.driver_state
      ? {
          driver: { id: r.id, employee_code: r.employee_code, full_name: r.full_name },
          driver_state: r.driver_state,
          connection_state: r.connection_state,
          last_heartbeat_at: r.last_heartbeat_at ? new Date(r.last_heartbeat_at).toISOString() : null,
          available_since: r.available_since ? new Date(r.available_since).toISOString() : null,
          active_task_id: r.active_task_id,
          next_task_id: r.next_task_id,
          duty_started_at: r.duty_started_at ? new Date(r.duty_started_at).toISOString() : null,
        }
      : null,
  };
}

export function encodeCursor(v: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor(c: string): { created_at: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (
      typeof v?.created_at === 'string' &&
      typeof v?.id === 'string' &&
      !Number.isNaN(Date.parse(v.created_at))
    )
      return v;
  } catch {
    /* fallthrough */
  }
  throw new AppError('PAGINATION_CURSOR_INVALID');
}
