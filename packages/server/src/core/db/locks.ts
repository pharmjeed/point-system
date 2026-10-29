import { performance } from 'node:perf_hooks';
import { metrics } from '../metrics/metrics.js';
import { LOCK_LEVELS, type LockTable } from './lock-tracker.js';
import type { Tx } from './tx.js';

export type LockMode = 'FOR NO KEY UPDATE' | 'FOR SHARE';

/**
 * 05 §12.2: every canonical row lock (L1–L8 here) is timed into `point_db_lock_wait_seconds`, and the L1 pool lock
 * also into `point_dispatch_pool_lock_wait_seconds`. A primary-key `SELECT … FOR NO KEY UPDATE` costs microseconds
 * when nobody holds the rows, so the time is the wait.
 */
function observeLockWait(table: LockTable | 'duty_sessions_by_user', startedMs: number): void {
  const s = (performance.now() - startedMs) / 1000;
  metrics.dbLockWait.observe(s);
  if (table === 'dispatch_pools') metrics.dispatchPoolLockWait.observe(s);
}

/**
 * Locks rows of one level in ascending id order (canon §14ب, `FOR NO KEY UPDATE` by default). Returns the
 * locked rows; ids that don't exist are simply absent (callers decide whether that is a 404).
 */
export async function lockRows<R = any>(
  tx: Tx,
  table: LockTable,
  ids: readonly string[],
  mode: LockMode = 'FOR NO KEY UPDATE',
): Promise<R[]> {
  if (table === 'idempotency_keys')
    throw new Error('idempotency keys are claimed by the command runner (L0)');
  const unique = [...new Set(ids.filter(Boolean))].sort();
  tx.locks.check(table);
  if (unique.length === 0) return [];
  const started = performance.now();
  const rows = await tx.rows(`SELECT * FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id ${mode}`, [
    unique,
  ]);
  observeLockWait(table, started);
  tx.locks.record(table, unique);
  return rows as R[];
}

export async function lockOne<R = any>(
  tx: Tx,
  table: LockTable,
  id: string,
  mode?: LockMode,
): Promise<R | null> {
  const [row] = await lockRows<R>(tx, table, [id], mode);
  return row ?? null;
}

export const lockPools = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'dispatch_pools', ids);
export const lockEvents = (tx: Tx, ids: readonly string[], mode: LockMode = 'FOR NO KEY UPDATE') =>
  lockRows(tx, 'events', ids, mode);
export const lockTransfers = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'driver_transfers', ids);
export const lockAssignments = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'driver_assignments', ids);
export const lockUsers = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'users', ids);
export const lockTasks = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'tasks', ids);
export const lockTickets = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'tickets', ids);
export const lockCycles = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'retrieval_cycles', ids);
export const lockOffers = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'task_offers', ids);
export const lockDutySessions = (tx: Tx, ids: readonly string[]) => lockRows(tx, 'duty_sessions', ids);

/** L8 by user: the open (not ended) duty sessions of these users, ascending by session id. */
export async function lockOpenDutyByUsers<R = any>(tx: Tx, userIds: readonly string[]): Promise<R[]> {
  tx.locks.check('duty_sessions');
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const started = performance.now();
  const rows = await tx.rows(
    `SELECT * FROM duty_sessions WHERE user_id = ANY($1::uuid[]) AND status <> 'ended' ORDER BY id FOR NO KEY UPDATE`,
    [unique],
  );
  observeLockWait('duty_sessions_by_user', started);
  tx.locks.record(
    'duty_sessions',
    rows.map((r: { id: string }) => r.id),
  );
  return rows as R[];
}

export { LOCK_LEVELS };
