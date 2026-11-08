import type { DriverState } from '@point/shared';
import { lockPools } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import type { TicketCtx, TicketQueryable } from '../../tickets-custody/index.js';
import type { PoolDriverRow, PoolRow, QueueTask } from './rows.js';

/**
 * The pool row lock (L1). A command locks its pool first; the pass and the release hook reuse that lock
 * instead of asking again (asking again after higher levels would be a lock-order violation).
 */
export async function ensurePoolLocked(tx: Tx, poolId: string): Promise<PoolRow> {
  const held = tx.locks.taken.some((l) => l.table === 'dispatch_pools' && l.ids.includes(poolId));
  if (held) {
    const row = await tx.maybeOne<PoolRow>(`SELECT * FROM dispatch_pools WHERE id = $1`, [poolId]);
    if (!row) throw new InvariantViolation(`dispatch pool ${poolId} vanished`);
    return row;
  }
  const [row] = await lockPools(tx, [poolId]);
  if (!row) throw new InvariantViolation(`dispatch pool ${poolId} not found`);
  return row as PoolRow;
}

export function holdsPool(tx: Tx, poolId: string): boolean {
  return tx.locks.taken.some((l) => l.table === 'dispatch_pools' && l.ids.includes(poolId));
}

/** 10 §4.2 query 2: open demand oldest first; locks the task rows (L4, allowed under L1). */
export async function lockOpenDemand(tx: Tx, poolId: string): Promise<QueueTask[]> {
  tx.locks.check('tasks');
  const rows = await tx.rows<QueueTask>(
    `SELECT t.id, t.status, t.priority_at, t.seq, t.queued_at, t.ticket_id, t.cycle_id, t.version,
            o.id AS live_offer_id, o.mode AS live_offer_mode, o.expires_at
       FROM tasks t
       LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
      WHERE t.dispatch_pool_id = $1 AND t.type = 'retrieve' AND t.status IN ('queued','offered','broadcast')
      ORDER BY t.priority_at, t.seq
      FOR NO KEY UPDATE OF t`,
    [poolId],
  );
  tx.locks.record(
    'tasks',
    rows.map((r) => r.id),
  );
  return rows;
}

/**
 * 10 §4.2 query 3: open duty sessions of the pool (on_duty + on_break) with derived state. Sessions whose shift is
 * no longer `open` are left out: shift close marks the shift `closed` first and then releases and ends its sessions
 * one by one in the same transaction, so a pass run from the release of one driver must not offer the work to a
 * colleague whose session is about to end (venues-events contract, DEC-32).
 */
export async function loadPoolDrivers(tx: Tx, poolId: string): Promise<PoolDriverRow[]> {
  return tx.rows<PoolDriverRow>(
    `SELECT s.duty_session_id, s.user_id, s.duty_status, s.driver_state, s.available_since, s.connection_state,
            (SELECT o.id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
              WHERE r.user_id = s.user_id AND o.status = 'active' AND o.mode = 'single' LIMIT 1) AS live_single_offer_id
       FROM v_driver_state s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN duty_sessions d ON d.id = s.duty_session_id
       JOIN shifts sh ON sh.id = d.shift_id AND sh.status = 'open'
      WHERE s.dispatch_pool_id = $1
      ORDER BY s.available_since NULLS LAST, s.user_id`,
    [poolId],
  );
}

/** 10 §2.5: single recipients of this episode ∪ every earlier acceptor. */
export async function loadTriedSet(tx: Tx, taskId: string): Promise<Set<string>> {
  const rows = await tx.rows<{ user_id: string }>(
    `SELECT r.user_id
       FROM task_offers o
       JOIN offer_recipients r ON r.offer_id = o.id
       JOIN tasks t ON t.id = o.task_id
      WHERE o.task_id = $1 AND o.mode = 'single' AND o.created_at >= t.queued_at
     UNION
     SELECT o.accepted_by FROM task_offers o WHERE o.task_id = $1 AND o.status = 'accepted' AND o.accepted_by IS NOT NULL`,
    [taskId],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** Ticket identity for events and the timeline (read under the pool lock; no row lock needed). */
export async function loadTicketCtx(q: TicketQueryable, ticketId: string): Promise<TicketCtx> {
  const r = await q.query<TicketCtx>(
    `SELECT id, org_id, venue_id, event_id, dispatch_pool_id, display_number, version FROM tickets WHERE id = $1`,
    [ticketId],
  );
  if (!r.rows[0]) throw new InvariantViolation(`ticket ${ticketId} not found`);
  return r.rows[0];
}

export interface DriverStateRow {
  duty_session_id: string;
  org_id: string;
  user_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  duty_status: 'on_duty' | 'on_break';
  available_since: Date | null;
  connection_state: 'online' | 'uncertain' | 'offline';
  active_task_id: string | null;
  active_task_type: string | null;
  next_task_id: string | null;
  driver_state: DriverState;
  version: number;
}

/** `v_driver_state` for one user (null = off duty). */
export async function driverStateOf(q: TicketQueryable, userId: string): Promise<DriverStateRow | null> {
  const r = await q.query<DriverStateRow>(
    `SELECT s.*, d.org_id, d.version FROM v_driver_state s JOIN duty_sessions d ON d.id = s.duty_session_id WHERE s.user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}
