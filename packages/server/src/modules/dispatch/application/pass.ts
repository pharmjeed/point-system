import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import { lockOffers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { EventActor } from '../../tickets-custody/index.js';
import { idleCandidates, pickCandidate } from '../domain/driver-state.js';
import { ensurePoolLocked, loadPoolDrivers, loadTriedSet, lockOpenDemand } from '../infra/dispatch-repo.js';
import type { PoolDriverRow, PoolRow, QueueTask } from '../infra/rows.js';
import { createSingleRound, expireSingleRound, revokeRound } from './offers.js';
import { addMs, dispatchSettings, type DispatchSettings } from './settings.js';

export type PassReason =
  | 'request_created'
  | 'requeued'
  | 'driver_available'
  | 'offer_expired'
  | 'offer_accepted'
  | 'task_canceled'
  | 'recipient_unavailable'
  | 'transfer'
  | 'sweep';

export interface PassResult {
  reason: PassReason;
  demand: number;
  onDuty: number;
  offersCreated: number;
  expired: number;
}

/**
 * Extension point for S4 (PNT-052/053): what happens to a task that has no untried idle candidate. The S2
 * default keeps it `queued` (no broadcast rounds yet); S4 registers a policy that opens/extends a broadcast
 * (10 §4.4) and returns 'broadcast' so the actionable drivers are blocked behind the older round (R-3).
 */
export interface BroadcastPolicy {
  onNoSingleCandidate(
    tx: Tx,
    ctx: {
      pool: PoolRow;
      task: QueueTask;
      onDuty: PoolDriverRow[];
      blocked: Set<string>;
      cfg: DispatchSettings;
    },
  ): Promise<'broadcast' | 'queued'>;
}

const QUEUE_ONLY: BroadcastPolicy = {
  async onNoSingleCandidate() {
    return 'queued';
  },
};

let broadcastPolicy: BroadcastPolicy = QUEUE_ONLY;

export function registerBroadcastPolicy(p: BroadcastPolicy | null): void {
  broadcastPolicy = p ?? QUEUE_ONLY;
}

/**
 * Extension point for S4 (10 §4.7): advisory alerts at the end of a pass (`idle_driver_while_next_waiting`).
 * Never reassigns silently.
 */
export type PassAdvisor = (
  tx: Tx,
  ctx: { pool: PoolRow; idle: PoolDriverRow[]; cfg: DispatchSettings },
) => Promise<void>;
let advisor: PassAdvisor | null = null;
export function registerPassAdvisor(a: PassAdvisor | null): void {
  advisor = a;
}

const SYSTEM: EventActor = { type: 'system', id: null };

/**
 * The dispatch pass (10 §4.1), run inside the transaction that changed the pool while it holds the pool lock
 * (DEC-08). Takes extra L4–L8 rows of the same pool (canon §14ب exception). `excludeUserIds`: drivers leaving
 * the pool in this transaction (release hook) are not offered anything.
 */
export async function runDispatchPass(
  tx: Tx,
  poolId: string,
  reason: PassReason,
  opts: { excludeUserIds?: readonly string[] } = {},
): Promise<PassResult> {
  const pool = await ensurePoolLocked(tx, poolId);
  const cfg = await dispatchSettings(tx, pool.venue_id);
  const exclude = new Set(opts.excludeUserIds ?? []);

  // A. defensive expiry (same body as job.offer_expire) — protects against a lagging worker
  const overdue = await tx.rows<{ id: string; task_id: string }>(
    `SELECT id, task_id FROM task_offers
      WHERE dispatch_pool_id = $1 AND status = 'active' AND mode = 'single' AND expires_at <= $2
      ORDER BY task_id`,
    [poolId, addMs(tx.now, -cfg.acceptGraceMs)],
  );
  let expired = 0;
  if (overdue.length) {
    await lockTasks(
      tx,
      overdue.map((o) => o.task_id),
    );
    await lockOffers(
      tx,
      overdue.map((o) => o.id),
    );
    for (const o of overdue) if (await expireSingleRound(tx, o, pool.venue_id, cfg, null)) expired++;
  }

  // B. snapshot under the lock
  const demand = await lockOpenDemand(tx, poolId);
  const drivers = (await loadPoolDrivers(tx, poolId)).filter((d) => !exclude.has(d.user_id));
  const onDuty = drivers.filter((d) => d.duty_status === 'on_duty');

  // C. nobody can serve this pool: alert, never route to another venue (10 §4.6)
  if (demand.length > 0 && onDuty.length === 0) {
    await raiseAlert(tx, {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      type: 'no_drivers_on_duty',
      dedupeKey: `no_drivers_on_duty:${pool.id}`,
      poolId: pool.id,
      details: {
        reason: drivers.length ? 'all_on_break' : 'none_on_duty',
        open_requests: demand.length,
      },
    });
    return finish(tx, pool, { reason, demand: demand.length, onDuty: 0, offersCreated: 0, expired });
  }
  if (onDuty.length > 0)
    await autoResolveAlerts(tx, {
      orgId: pool.org_id,
      venueId: pool.venue_id,
      dedupeKeys: [`no_drivers_on_duty:${pool.id}`],
      note: 'driver_on_duty',
    });

  // D. pairing: oldest task ↔ longest idle driver (R-1 … R-6)
  const idle = idleCandidates(onDuty, { offlineLast: cfg.offlineDriversLast });
  const blocked = new Set(onDuty.filter((d) => d.live_single_offer_id).map((d) => d.user_id));
  let offersCreated = 0;
  for (const task of demand) {
    if (task.status === 'offered') continue; // its single recipient is already blocked
    const tried = await loadTriedSet(tx, task.id);
    const cand = pickCandidate(idle, tried, blocked);
    if (cand) {
      if (task.status === 'broadcast' && task.live_offer_id) {
        await lockOffers(tx, [task.live_offer_id]);
        await revokeRound(tx, task.live_offer_id, pool.venue_id, 'converted_to_single', SYSTEM);
      }
      await createSingleRound(tx, pool, task, cand, cfg);
      offersCreated++;
      idle.splice(idle.indexOf(cand), 1);
      blocked.add(cand.user_id);
      continue;
    }
    const outcome = await broadcastPolicy.onNoSingleCandidate(tx, { pool, task, onDuty, blocked, cfg });
    if (outcome === 'broadcast')
      for (const d of onDuty) if (d.driver_state !== 'busy_with_next') blocked.add(d.user_id);
  }

  // E. advisory alerts (S4)
  if (advisor) await advisor(tx, { pool, idle, cfg });
  return finish(tx, pool, { reason, demand: demand.length, onDuty: onDuty.length, offersCreated, expired });
}

async function finish(tx: Tx, pool: PoolRow, r: PassResult): Promise<PassResult> {
  // descriptive counters: no version bump (10 §2.7)
  await tx.query(`UPDATE dispatch_pools SET last_pass_at = $2, pass_count = pass_count + 1 WHERE id = $1`, [
    pool.id,
    tx.now,
  ]);
  return r;
}
