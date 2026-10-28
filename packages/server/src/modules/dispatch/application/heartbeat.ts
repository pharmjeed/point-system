import { parseOrgSettings } from '@point/shared';
import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import type { Database } from '../../../core/db/database.js';
import { lockDutySessions } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Logger } from '../../../core/logging/logger.js';
import { emitEvent, schedule } from '../../../core/outbox/outbox-writer.js';
import { orgSettings } from '../../../core/settings/settings-service.js';
import type { DutyRow } from '../infra/rows.js';
import { addMs } from './settings.js';

export type ConnectionState = 'online' | 'uncertain' | 'offline';

export const HEARTBEAT_SWEEP_KEY = 'heartbeat_sweep';
const LOST_WITH_CUSTODY = 'driver_connection_lost_with_custody';

/**
 * 07 §4.5 / canon §12 `heartbeat.*`: `online` up to `uncertain_after_s` since the last heartbeat (or the duty
 * start when none arrived yet), `uncertain` up to `offline_after_s`, then `offline`.
 */
export function connectionStateAt(
  lastHeartbeatAt: Date | null,
  startedAt: Date,
  now: Date,
  cfg: { uncertain_after_s: number; offline_after_s: number },
): ConnectionState {
  const ref = new Date(lastHeartbeatAt ?? startedAt).getTime();
  const ageS = (now.getTime() - ref) / 1000;
  if (ageS > cfg.offline_after_s) return 'offline';
  if (ageS > cfg.uncertain_after_s) return 'uncertain';
  return 'online';
}

/**
 * Seeds the periodic `job.heartbeat_sweep` once (dedupe `heartbeat_sweep`, 10 §8.2): the handler schedules its
 * successor every `heartbeat.interval_s`. A plain read first so a command never waits on a running sweep row.
 */
export async function ensureHeartbeatSweep(tx: Tx, orgId: string): Promise<void> {
  const alive = await tx.maybeOne(
    `SELECT 1 FROM outbox_events WHERE dedupe_key = $1 AND status IN ('pending','processing') LIMIT 1`,
    [HEARTBEAT_SWEEP_KEY],
  );
  if (alive) return;
  const s = await orgSettings(tx, orgId);
  await schedule(tx, 'job.heartbeat_sweep', addMs(tx.now, s.heartbeat.interval_s * 1000), {
    orgId,
    dedupeKey: HEARTBEAT_SWEEP_KEY,
    payload: {},
  });
}

/** What the driver holds: a vehicle or key on an open ticket, and an active movement (accepted/in_progress). */
async function holdings(
  tx: Tx,
  userId: string,
): Promise<{ holds_custody: boolean; had_active_task: boolean; display_number: number | null }> {
  const r = await tx.one<{ custody: number; active: number; display_number: number | null }>(
    `SELECT (SELECT count(*)::int FROM tickets t
              WHERE t.status NOT IN ('delivered','voided')
                AND ((t.vehicle_holder_type = 'driver' AND t.vehicle_holder_id = $1)
                  OR (t.key_holder_type = 'driver' AND t.key_holder_id = $1))) AS custody,
            (SELECT count(*)::int FROM tasks k WHERE k.assignee_id = $1 AND k.status IN ('accepted','in_progress')) AS active,
            (SELECT t.display_number FROM tickets t
              WHERE t.status NOT IN ('delivered','voided')
                AND ((t.vehicle_holder_type = 'driver' AND t.vehicle_holder_id = $1)
                  OR (t.key_holder_type = 'driver' AND t.key_holder_id = $1))
              ORDER BY t.display_number LIMIT 1) AS display_number`,
    [userId],
  );
  return { holds_custody: r.custody > 0, had_active_task: r.active > 0, display_number: r.display_number };
}

/**
 * One session in its own short transaction (L8 only, then L9 alerts): the connection state from the heartbeats,
 * `driver.connection_changed`, and `driver_connection_lost_with_custody` (warning) when the driver goes offline
 * holding a vehicle, a key or an active task. Descriptive only (10 §2.7, I-13): no version bump, availability and
 * tasks untouched — an offline driver keeps his running task (EC-45).
 */
async function sweepSession(tx: Tx, sessionId: string, hasOpenAlert: boolean): Promise<boolean> {
  const [d] = (await lockDutySessions(tx, [sessionId])) as DutyRow[];
  const key = `${LOST_WITH_CUSTODY}:${sessionId}`;
  if (!d) return false;
  if (d.status === 'ended') {
    if (hasOpenAlert)
      await autoResolveAlerts(tx, {
        orgId: d.org_id,
        venueId: d.venue_id,
        dedupeKeys: [key],
        note: 'duty_ended',
      });
    return false;
  }
  const cfg = (await orgSettings(tx, d.org_id)).heartbeat;
  const next = connectionStateAt(d.last_heartbeat_at, d.started_at, tx.now, cfg);
  const changed = next !== d.connection_state;
  const held = changed || hasOpenAlert ? await holdings(tx, d.user_id) : null;
  if (changed) {
    await tx.query(`UPDATE duty_sessions SET connection_state = $2 WHERE id = $1`, [d.id, next]);
    await emitEvent(tx, {
      type: 'driver.connection_changed',
      orgId: d.org_id,
      venueId: d.venue_id,
      dispatchPoolId: d.dispatch_pool_id,
      aggregate: { type: 'duty_session', id: d.id, version: d.version },
      actor: { type: 'system', id: null },
      payload: {
        user_id: d.user_id,
        duty_session_id: d.id,
        connection_state: next,
        last_heartbeat_at: d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toISOString() : null,
        holds_custody: held!.holds_custody,
        had_active_task: held!.had_active_task,
        from: d.connection_state,
        to: next,
      },
    });
  }
  const atRisk = next === 'offline' && !!held && (held.holds_custody || held.had_active_task);
  if (atRisk && (changed || hasOpenAlert)) {
    await raiseAlert(tx, {
      orgId: d.org_id,
      venueId: d.venue_id,
      type: 'driver_connection_lost_with_custody',
      dedupeKey: key,
      poolId: d.dispatch_pool_id,
      userId: d.user_id,
      details: {
        duty_session_id: d.id,
        display_number: held.display_number,
        holds_custody: held.holds_custody,
        had_active_task: held.had_active_task,
        last_heartbeat_at: d.last_heartbeat_at ? new Date(d.last_heartbeat_at).toISOString() : null,
      },
    });
  } else if (hasOpenAlert && !atRisk) {
    await autoResolveAlerts(tx, {
      orgId: d.org_id,
      venueId: d.venue_id,
      dedupeKeys: [key],
      note: next === 'offline' ? 'custody_cleared' : 'connection_restored',
    });
  }
  return changed;
}

/**
 * `job.heartbeat_sweep` body (PNT-062): every open duty session whose stored state differs from the computed one,
 * and every session with a live lost-with-custody alert, each in its own transaction so a busy session never holds
 * up the others (a lock timeout is retried by the next sweep).
 */
export async function sweepHeartbeats(db: Database, now: Date, logger: Logger): Promise<number> {
  const sessions = await db.query<{
    id: string;
    org_id: string;
    started_at: Date;
    last_heartbeat_at: Date | null;
    connection_state: ConnectionState;
    org_settings: unknown;
  }>(
    `SELECT d.id, d.org_id, d.started_at, d.last_heartbeat_at, d.connection_state, o.settings AS org_settings
       FROM duty_sessions d JOIN organizations o ON o.id = d.org_id
      WHERE d.status <> 'ended'
      ORDER BY d.id`,
  );
  const alerts = await db.query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM alerts WHERE type = $1 AND status <> 'resolved' AND dedupe_key IS NOT NULL`,
    [LOST_WITH_CUSTODY],
  );
  const withAlert = new Set(alerts.rows.map((a) => a.dedupe_key.slice(LOST_WITH_CUSTODY.length + 1)));
  const todo = new Set<string>();
  for (const s of sessions.rows) {
    const cfg = parseOrgSettings(s.org_settings ?? {}).heartbeat;
    if (connectionStateAt(s.last_heartbeat_at, s.started_at, now, cfg) !== s.connection_state) todo.add(s.id);
  }
  for (const id of withAlert) todo.add(id);
  let changed = 0;
  for (const id of [...todo].sort()) {
    try {
      if (await db.transaction((tx) => sweepSession(tx, id, withAlert.has(id)))) changed++;
    } catch (e) {
      logger.warn(
        { duty_session_id: id, err: e instanceof Error ? e.message : String(e) },
        'heartbeat sweep of a session failed; the next sweep retries',
      );
    }
  }
  return changed;
}
