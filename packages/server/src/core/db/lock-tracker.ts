import { InvariantViolation } from '../errors/app-error.js';

/**
 * Canon §14ب lock levels. L3 has an internal order: driver_transfers ← driver_assignments ← users.
 * A transaction never takes a lower level after a higher one, with one exception: a transaction holding L1
 * may lock extra L4–L8 rows (same pool) for the dispatch pass and settleDriverAfterTask.
 */
export const LOCK_LEVELS = {
  idempotency_keys: 0,
  dispatch_pools: 1,
  events: 2,
  driver_transfers: 3.1,
  driver_assignments: 3.2,
  users: 3.3,
  tasks: 4,
  tickets: 5,
  retrieval_cycles: 6,
  task_offers: 7,
  duty_sessions: 8,
} as const;

export type LockTable = keyof typeof LOCK_LEVELS;

export class LockTracker {
  private max = -1;
  private holdsPool = false;
  readonly taken: { table: LockTable; ids: string[] }[] = [];

  check(table: LockTable): void {
    const level = LOCK_LEVELS[table];
    if (level < this.max) {
      const exception = this.holdsPool && level >= 4 && level <= 8;
      if (!exception) {
        throw new InvariantViolation(
          `lock order violation: ${table} (L${level}) requested after L${this.max} (canon §14ب)`,
        );
      }
    }
  }

  record(table: LockTable, ids: string[]): void {
    const level = LOCK_LEVELS[table];
    if (level === 1) this.holdsPool = true;
    if (level > this.max) this.max = level;
    this.taken.push({ table, ids });
  }

  get highest(): number {
    return this.max;
  }

  get holdsDispatchPool(): boolean {
    return this.holdsPool;
  }
}
