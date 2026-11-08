import type { DriverReleaseHook } from '../../../core/hooks/driver-release.js';
import { lockCycles, lockTasks, lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { EventActor } from '../../tickets-custody/index.js';
import { ensurePoolLocked } from '../infra/dispatch-repo.js';
import type { TaskRow } from '../infra/rows.js';
import { ensureDispatchSweep, revokeDriverSingleOffers } from './offers.js';
import { runDispatchPass } from './pass.js';
import { withdrawTask } from './tasks.js';

type ReleaseArgs = Parameters<DriverReleaseHook['releaseDriverWork']>[1];

/**
 * DEC-32 (10 §9.1, §9.5, §9.7 steps 3–4, §9.8): before a driver is disabled, transferred or has his duty
 * ended by someone else, his live single offers are revoked (`recipient_unavailable`, or `transfer`) and their
 * tasks requeued in the same episode; his reserved next task and an accepted retrieval whose key was not
 * picked up go back to the queue with their original priority (`task.withdrawn`, ticket `requested`).
 * Broadcast recipient rows stay for history (10 §9.5/§9.6): without an open duty he cannot accept
 * (DUTY_REQUIRED). Then a dispatch pass runs for the pool without him.
 *
 * The caller holds L1 for the pool (and L3 as needed); custody and in-progress tasks were refused before.
 */
export async function releaseDriverWork(tx: Tx, args: ReleaseArgs): Promise<{ returnedTaskIds: string[] }> {
  const actor: EventActor = args.actorId ? { type: 'user', id: args.actorId } : { type: 'system', id: null };
  const pending = await tx.rows<Pick<TaskRow, 'id' | 'dispatch_pool_id'>>(
    `SELECT id, dispatch_pool_id FROM tasks
      WHERE assignee_id = $1
        AND (status = 'assigned_waiting' OR (status = 'accepted' AND type = 'retrieve' AND key_picked_up_at IS NULL))
      ORDER BY id`,
    [args.driverId],
  );
  const offerPools = await tx.rows<{ dispatch_pool_id: string }>(
    `SELECT DISTINCT o.dispatch_pool_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
      WHERE r.user_id = $1 AND o.status = 'active' AND o.mode = 'single'`,
    [args.driverId],
  );
  const poolId = args.poolId ?? pending[0]?.dispatch_pool_id ?? offerPools[0]?.dispatch_pool_id ?? null;
  if (!poolId) return { returnedTaskIds: [] };
  const pool = await ensurePoolLocked(tx, poolId);

  await revokeDriverSingleOffers(
    tx,
    args.driverId,
    args.reason === 'transfer' ? 'transfer' : 'recipient_unavailable',
    actor,
  );

  const returned: string[] = [];
  if (pending.length) {
    const tasks = (await lockTasks(
      tx,
      pending.map((p) => p.id),
    )) as TaskRow[]; // L4
    await lockTickets(
      tx,
      tasks.map((t) => t.ticket_id),
    ); // L5
    await lockCycles(
      tx,
      tasks.map((t) => t.cycle_id).filter((c): c is string => !!c),
    ); // L6
    const trigger =
      args.reason === 'transfer' ? 'transfer' : args.reason === 'disabled' ? 'disabled' : 'supervisor';
    for (const t of tasks) {
      const stillPending =
        t.assignee_id === args.driverId &&
        (t.status === 'assigned_waiting' ||
          (t.status === 'accepted' && t.type === 'retrieve' && t.key_picked_up_at == null));
      if (!stillPending) continue;
      await withdrawTask(tx, t, { trigger, reason: args.reason, actor });
      returned.push(t.id);
    }
  }
  // each requeued task started a new episode with its own job.escalate_unaccepted (withdrawTask)
  await runDispatchPass(tx, pool.id, args.reason === 'transfer' ? 'transfer' : 'requeued', {
    excludeUserIds: [args.driverId],
  });
  await ensureDispatchSweep(tx, pool.org_id);
  return { returnedTaskIds: returned };
}

export const dispatchDriverReleaseHook: DriverReleaseHook = {
  async releaseDriverWork(tx, args) {
    await releaseDriverWork(tx, args);
  },
};
