/**
 * Canonical lock order L0 … L10 (canon §14ب), binding for every transaction.
 *
 * Rows are locked with `SELECT … FOR NO KEY UPDATE` (does not block foreign-key inserts) and
 * `FOR SHARE` where preventing change is enough (e.g. the event row while collecting payment).
 * The worker leases `outbox_events` rows with `FOR UPDATE SKIP LOCKED`. A transaction takes what it
 * needs in this order only and never locks a higher level after a lower one.
 *
 * Single allowed exception: a transaction holding L1 may, after its own locks, lock extra L4–L8
 * rows of the same pool for the dispatch pass and `settleDriverAfterTask`.
 * Transactions that do not need the pool lock (intake draft edit/submit, photo upload, link codes,
 * phone change) start at L5; movement progress commands (`key-pickup`, `start-retrieval`, `ready`)
 * start at L4. No network call inside any transaction.
 */
import type { TableName } from './tables.js';

export const LOCK_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'] as const;
export type LockLevel = (typeof LOCK_LEVELS)[number];

/** Numeric rank of each level (lower is taken first). */
export const LOCK_LEVEL_RANK: Readonly<Record<LockLevel, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
  L6: 6,
  L7: 7,
  L8: 8,
  L9: 9,
  L10: 10,
};

/** Tables of each level, in the order written in canon §14ب. */
export const LOCK_LEVEL_TABLES = {
  /** Reserve `idempotency_keys` — first statement of every ✓ command. */
  L0: ['idempotency_keys'],
  /** Anything touching the pool queue or its drivers' availability; two pools (transfer) by ascending id. */
  L1: ['dispatch_pools'],
  /** Ticket counter and event open/close (`FOR NO KEY UPDATE`); collection and cash handover (`FOR SHARE`). */
  L2: ['events'],
  /** Transfer, assignment and disabling only — in this order. */
  L3: ['driver_transfers', 'driver_assignments', 'users'],
  /** Ascending id when several. */
  L4: ['tasks'],
  /** Ascending id when several. */
  L5: ['tickets'],
  L6: ['retrieval_cycles'],
  /** Offer rounds and their recipients; ascending id. */
  L7: ['task_offers', 'offer_recipients'],
  /** Ascending id. */
  L8: ['duty_sessions'],
  /** Guarded by the unique indexes. */
  L9: [
    'spot_allocations',
    'key_slot_allocations',
    'claim_codes',
    'link_codes',
    'action_tokens',
    'payments',
    'cash_handovers',
    'alerts',
    'notifications',
  ],
  /** Append-only rows, last in the transaction; then `idempotency_keys` is completed. */
  L10: ['custody_events', 'ticket_events', 'outbox_events', 'audit_log', 'analytics_events'],
} as const satisfies Record<LockLevel, readonly TableName[]>;

export type LockedTable = (typeof LOCK_LEVEL_TABLES)[LockLevel][number];

/** Table → its lock level. */
export const TABLE_LOCK_LEVEL: Readonly<Record<LockedTable, LockLevel>> = Object.fromEntries(
  LOCK_LEVELS.flatMap((level) => LOCK_LEVEL_TABLES[level].map((table) => [table, level])),
) as Record<LockedTable, LockLevel>;

export const LOCK_MODES = {
  /** Default row lock. */
  update: 'FOR NO KEY UPDATE',
  /** Prevent change only (e.g. the event row while collecting). */
  share: 'FOR SHARE',
  /** Worker lease of `outbox_events`. */
  lease: 'FOR UPDATE SKIP LOCKED',
} as const;
export type LockMode = keyof typeof LOCK_MODES;

/**
 * Transaction retry policy (canon §14ب): the whole transaction is retried up to 3 times on
 * `40001`/`40P01` with a random 20–80 ms delay. `lock_timeout` (`55P03`) is not retried on the
 * server: `IDEMPOTENCY_IN_PROGRESS` at L0, otherwise `SERVICE_UNAVAILABLE` (retryable).
 */
export const TRANSACTION_RETRY = {
  maxRetries: 3,
  retrySqlStates: ['40001', '40P01'],
  minDelayMs: 20,
  maxDelayMs: 80,
  lockTimeoutSqlState: '55P03',
} as const;

/** True when locking `next` after `held` respects the order (same level allowed). */
export function isLockOrderAllowed(held: LockLevel, next: LockLevel): boolean {
  return LOCK_LEVEL_RANK[next] >= LOCK_LEVEL_RANK[held];
}
