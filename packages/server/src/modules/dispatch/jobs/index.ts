import { audit } from '../../../core/audit/audit-writer.js';
import { lockOffers, lockTasks } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { ensurePoolLocked } from '../infra/dispatch-repo.js';
import type { OfferRow } from '../infra/rows.js';
import { ensureDispatchSweep, expireSingleRound, SWEEP_INTERVAL_MS } from '../application/offers.js';
import { runDispatchPass, type PassReason } from '../application/pass.js';
import { addMs, dispatchSettings } from '../application/settings.js';

function requireTx(tx: Tx | undefined): Tx {
  if (!tx) throw new Error('dispatch jobs run in mode tx');
  return tx;
}

/**
 * `job.offer_expire` (10 §8.3): lock the pool, then the task and the round (canon §14ب); a stale timer (round
 * no longer active or its version changed) is a no-op; a timer that fires early is rescheduled.
 */
export const offerExpireHandler: JobHandler = {
  type: 'job.offer_expire',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const offerId = row.aggregate_id;
    if (!offerId) return;
    const pre = await tx.maybeOne<
      Pick<OfferRow, 'id' | 'task_id' | 'dispatch_pool_id' | 'status' | 'version'>
    >(`SELECT id, task_id, dispatch_pool_id, status, version FROM task_offers WHERE id = $1`, [offerId]);
    if (!pre || pre.status !== 'active') return; // accepted, revoked or already expired
    if (row.aggregate_version != null && pre.version !== row.aggregate_version) return; // stale
    const pool = await ensurePoolLocked(tx, pre.dispatch_pool_id); // L1
    await lockTasks(tx, [pre.task_id]); // L4
    const [offer] = (await lockOffers(tx, [pre.id])) as OfferRow[]; // L7
    if (!offer || offer.status !== 'active') return;
    if (row.aggregate_version != null && offer.version !== row.aggregate_version) return;
    const cfg = await dispatchSettings(tx, pool.venue_id);
    const due = addMs(new Date(offer.expires_at!), cfg.acceptGraceMs);
    if (due.getTime() > tx.now.getTime()) {
      // fired early (clock skew between processes): come back at the real deadline
      await schedule(tx, 'job.offer_expire', due, {
        orgId: offer.org_id,
        venueId: pool.venue_id,
        dedupeKey: `offer_expire:${offer.id}`,
        aggregate: { type: 'task_offer', id: offer.id, version: offer.version },
        payload: row.payload,
      });
      return;
    }
    if (!(await expireSingleRound(tx, offer, pool.venue_id, cfg, offer.version))) return;
    await runDispatchPass(tx, pool.id, 'offer_expired');
    await audit(tx, {
      orgId: offer.org_id,
      actor: { type: 'system', id: null },
      action: 'job.offer_expire',
      entityType: 'task_offer',
      entityId: offer.id,
      venueId: pool.venue_id,
      metadata: { task_id: offer.task_id },
    });
  },
};

/** `job.dispatch_pass` for a pool a command could not lock itself (dedupe `dispatch_pass:<pool_id>`). */
export const dispatchPassHandler: JobHandler = {
  type: 'job.dispatch_pass',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const poolId = (row.payload?.pool_id as string | undefined) ?? row.aggregate_id;
    if (!poolId) return;
    const exists = await tx.maybeOne(`SELECT 1 FROM dispatch_pools WHERE id = $1`, [poolId]);
    if (!exists) return;
    await ensurePoolLocked(tx, poolId);
    await runDispatchPass(
      tx,
      poolId,
      ((row.payload?.reason as PassReason | undefined) ?? 'sweep') as PassReason,
    );
  },
};

const POOLS_TO_SWEEP = `SELECT p.id FROM dispatch_pools p
  WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.dispatch_pool_id = p.id
                  AND ((t.type = 'retrieve' AND t.status IN ('queued','offered','broadcast')) OR t.status = 'assigned_waiting'))
     OR EXISTS (SELECT 1 FROM task_offers o WHERE o.dispatch_pool_id = p.id AND o.status = 'active')
  ORDER BY p.id`;

/**
 * `job.dispatch_sweep` (10 §8.2): every 5 s a pass for each pool with an open request, a live round or a
 * reserved next task — each pool in its own transaction. It always schedules its successor in the handler's
 * transaction (the row is already `done` there), so the chain seeded by `ensureDispatchSweep` never breaks.
 */
export const dispatchSweepHandler: JobHandler = {
  type: 'job.dispatch_sweep',
  mode: 'tx',
  async handle({ row, tx: maybeTx, db, logger }) {
    const tx = requireTx(maybeTx);
    const pools = await db.rows<{ id: string }>(POOLS_TO_SWEEP);
    for (const p of pools) {
      try {
        await db.transaction(async (ptx) => {
          await ensurePoolLocked(ptx, p.id);
          await runDispatchPass(ptx, p.id, 'sweep');
        });
      } catch (e) {
        logger.warn(
          { pool_id: p.id, err: e instanceof Error ? e.message : String(e) },
          'dispatch sweep pass failed',
        );
      }
    }
    await schedule(tx, 'job.dispatch_sweep', addMs(tx.now, SWEEP_INTERVAL_MS), {
      orgId: row.org_id,
      dedupeKey: 'dispatch_sweep',
      payload: {},
    });
  },
};

/** Handlers registered by apps/worker (handlers.ts). */
export function dispatchJobs(): JobHandler[] {
  return [offerExpireHandler, dispatchPassHandler, dispatchSweepHandler];
}

export { ensureDispatchSweep };
