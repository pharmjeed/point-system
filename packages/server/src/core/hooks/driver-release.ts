import type { Tx } from '../db/tx.js';

/**
 * Seam between identity-access (disable, transfer) / venues-events (shift close, forced duty end) and the
 * dispatch module, which owns the queue (04 §4.3: lower modules never import dispatch).
 *
 * DEC-32: before a driver is disabled, transferred or has his duty ended by someone else, his reserved next
 * task and an accepted retrieval whose key was not picked up yet go back to the queue with their original
 * priority (`task.withdrawn`), and his live single offers are revoked. The caller already holds L1 (pool),
 * L3 (users) as needed; the hook takes L4–L8 for the same pool (canon §14ب exception) and runs a dispatch pass.
 */
export interface DriverReleaseHook {
  releaseDriverWork(
    tx: Tx,
    args: {
      orgId: string;
      driverId: string;
      poolId: string | null;
      reason: 'disabled' | 'transfer' | 'forced' | 'shift_closed';
      actorId: string | null;
    },
  ): Promise<void>;
}

let hook: DriverReleaseHook | null = null;

export function registerDriverReleaseHook(h: DriverReleaseHook): void {
  hook = h;
}

/** Throws when work exists but no dispatch module is registered (never silently skips DEC-32). */
export async function releaseDriverWork(
  tx: Tx,
  args: Parameters<DriverReleaseHook['releaseDriverWork']>[1],
): Promise<void> {
  if (hook) return hook.releaseDriverWork(tx, args);
  const pending = await tx.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status IN ('assigned_waiting','accepted'))
          + (SELECT count(*) FROM offer_recipients r JOIN task_offers o ON o.id = r.offer_id
              WHERE r.user_id = $1 AND o.status = 'active' AND o.mode = 'single') AS n`,
    [args.driverId],
  );
  if ((pending.rows[0]?.n ?? 0) > 0)
    throw new Error('driver has dispatch work but no DriverReleaseHook is registered');
}
