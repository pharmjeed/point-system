import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { autoResolveAlerts } from '../../../core/alerts/alerts.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import type { Tx } from '../../../core/db/tx.js';
import { lockOpenDutyByUsers } from '../../../core/db/locks.js';
import { AppError } from '../../../core/errors/app-error.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { ENV } from '../../../http/tokens.js';
import { buildMe, deviceView, type DeviceRow } from './views.js';

export interface DeviceRegisterBody {
  label?: string;
  platform: 'ios' | 'android' | 'desktop' | 'other';
  display_mode: 'browser' | 'standalone';
  notification_permission: 'default' | 'granted' | 'denied' | 'unsupported';
}

export interface DeviceUpdateBody {
  label?: string | null;
  display_mode?: 'browser' | 'standalone';
  notification_permission?: 'default' | 'granted' | 'denied' | 'unsupported';
  push_subscription?: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
}

export interface HeartbeatBody {
  visible: boolean;
  audio_unlocked: boolean;
  ws_connected: boolean;
  last_event_id?: string | null;
  app_version?: string;
}

/** GET /v1/me, devices, audio test, HTTP heartbeat (PNT-014). */
@Injectable()
export class MeService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  me(tx: Pick<Tx, 'query'>, actor: ActorContext) {
    return buildMe(tx, this.env, actor.sessionId, actor.userId);
  }

  async registerDevice(
    tx: Tx,
    actor: ActorContext,
    body: DeviceRegisterBody,
    userAgent: string | undefined,
    requestId: string,
  ) {
    const d = await tx.one<DeviceRow>(
      `INSERT INTO devices (org_id, user_id, label, user_agent, platform, display_mode, notification_permission, last_seen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
      [
        actor.orgId,
        actor.userId,
        body.label ?? null,
        userAgent?.slice(0, 512) ?? null,
        body.platform,
        body.display_mode,
        body.notification_permission,
        tx.now,
      ],
    );
    await tx.query(`UPDATE auth_sessions SET device_id = $2 WHERE id = $1 AND device_id IS NULL`, [
      actor.sessionId,
      d.id,
    ]);
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'auth.self',
      entityType: 'device',
      entityId: d.id,
      requestId,
      metadata: { command: 'device_register', platform: body.platform },
    });
    return deviceView(d);
  }

  /**
   * A Push subscription is stored only with its three fields (PNT-014 AC2, ck_devices_push_triplet); an
   * endpoint already held by another device moves to this one (uq_devices_push_endpoint → upsert, 08 §5.1).
   */
  async updateDevice(
    tx: Tx,
    actor: ActorContext,
    deviceId: string,
    body: DeviceUpdateBody,
    requestId: string,
  ) {
    const d = await tx.maybeOne<DeviceRow>(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR NO KEY UPDATE`,
      [deviceId, actor.userId],
    );
    if (!d) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'device' });
    const sets: string[] = ['last_seen_at = $3'];
    const params: unknown[] = [deviceId, actor.userId, tx.now];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.label !== undefined) add('label', body.label);
    if (body.display_mode !== undefined) add('display_mode', body.display_mode);
    if (body.notification_permission !== undefined)
      add('notification_permission', body.notification_permission);
    let moved = false;
    if (body.push_subscription !== undefined) {
      if (body.push_subscription === null) {
        add('push_endpoint', null);
        add('push_p256dh', null);
        add('push_auth', null);
        add('push_subscribed_at', null);
      } else {
        const r = await tx.query(
          `UPDATE devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL, push_subscribed_at = NULL
            WHERE push_endpoint = $1 AND id <> $2`,
          [body.push_subscription.endpoint, deviceId],
        );
        moved = (r.rowCount ?? 0) > 0;
        add('push_endpoint', body.push_subscription.endpoint);
        add('push_p256dh', body.push_subscription.keys.p256dh);
        add('push_auth', body.push_subscription.keys.auth);
        add('push_subscribed_at', tx.now);
        add('push_failed_count', 0);
      }
    }
    const updated = await tx.one<DeviceRow>(
      `UPDATE devices SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      params,
    );
    // 14 §8: a new subscription resolves `push_failed_repeatedly` (key of the notifications push sender)
    if (body.push_subscription)
      await autoResolveAlerts(tx, {
        orgId: actor.orgId,
        dedupeKeys: [`push_failed_repeatedly:${deviceId}`],
        note: 'new push subscription',
      });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'auth.self',
      entityType: 'device',
      entityId: deviceId,
      requestId,
      metadata: {
        command: 'device_update',
        push:
          body.push_subscription === undefined
            ? 'unchanged'
            : body.push_subscription
              ? 'subscribed'
              : 'removed',
        moved_from_other_device: moved,
      },
    });
    return deviceView(updated);
  }

  async audioTest(
    tx: Tx,
    actor: ActorContext,
    body: { device_id: string; result: 'heard' | 'not_heard' | 'blocked' },
    requestId: string,
  ) {
    const d = await tx.maybeOne<DeviceRow>(
      `UPDATE devices SET audio_tested_at = $3, audio_test_result = $4, last_seen_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING *`,
      [body.device_id, actor.userId, tx.now, body.result],
    );
    if (!d) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'device' });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'auth.self',
      entityType: 'device',
      entityId: d.id,
      requestId,
      metadata: { command: 'audio_test', result: body.result },
    });
    return deviceView(d);
  }

  /**
   * HTTP fallback for client.heartbeat (canon §7.3): refreshes duty_sessions.last_heartbeat_at; a driver whose
   * connection was uncertain/offline becomes online (driver.connection_changed). Never changes availability.
   */
  async heartbeat(tx: Tx, actor: ActorContext, body: HeartbeatBody) {
    void body;
    const [duty] = await lockOpenDutyByUsers<{
      id: string;
      connection_state: string;
      venue_id: string;
      dispatch_pool_id: string;
      version: number;
    }>(tx, [actor.userId]);
    let state: string | null = null;
    let syncRequired = false;
    if (duty) {
      const before = duty.connection_state;
      const r = await tx.one<{ connection_state: string; version: number }>(
        `UPDATE duty_sessions SET last_heartbeat_at = $2, connection_state = 'online',
                version = CASE WHEN connection_state <> 'online' THEN version + 1 ELSE version END
          WHERE id = $1 RETURNING connection_state, version`,
        [duty.id, tx.now],
      );
      state = r.connection_state;
      if (before !== 'online') {
        syncRequired = true;
        await emitEvent(tx, {
          type: 'driver.connection_changed',
          orgId: actor.orgId,
          venueId: duty.venue_id,
          dispatchPoolId: duty.dispatch_pool_id,
          aggregate: { type: 'duty_session', id: duty.id, version: r.version },
          actor: { type: 'user', id: actor.userId },
          payload: { user_id: actor.userId, duty_session_id: duty.id, from: before, to: 'online' },
        });
      }
    }
    await tx.query(
      `UPDATE devices SET last_seen_at = $2 WHERE id = (SELECT device_id FROM auth_sessions WHERE id = $1)`,
      [actor.sessionId, tx.now],
    );
    return { server_time: tx.now.toISOString(), connection_state: state, sync_required: syncRequired };
  }
}
