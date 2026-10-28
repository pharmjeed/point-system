import type pg from 'pg';
import type { Clock } from '../clock/clock.js';
import { InvariantViolation } from '../errors/app-error.js';
import { LockTracker } from './lock-tracker.js';

export type SqlParam = unknown;

/** Domain event envelope as written to outbox_events.payload and published on WebSocket (canon §7). */
export interface EventEnvelope<P = Record<string, unknown>> {
  id: string;
  type: string;
  occurred_at: string;
  org_id: string;
  venue_id: string | null;
  dispatch_pool_id: string | null;
  event_id: string | null;
  aggregate: { type: string; id: string; version: number | null };
  actor: { type: 'user' | 'customer' | 'system'; id: string | null };
  payload: P;
}

/**
 * One database transaction. `now` is taken once from the Clock when the transaction starts and is passed to
 * every time comparison, so a command sees a single consistent instant (16 §2.12).
 */
export class Tx {
  readonly locks = new LockTracker();
  readonly events: EventEnvelope[] = [];
  auditCount = 0;
  private readonly beforeCommit: { key: string | null; fn: () => Promise<void> }[] = [];

  constructor(
    readonly client: pg.PoolClient | pg.Client,
    readonly now: Date,
    readonly clock: Clock,
  ) {}

  async query<R extends pg.QueryResultRow = any>(
    text: string,
    params: SqlParam[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.client.query<R>(text, params as unknown[]);
  }

  async rows<R extends pg.QueryResultRow = any>(text: string, params: SqlParam[] = []): Promise<R[]> {
    return (await this.query<R>(text, params)).rows;
  }

  async maybeOne<R extends pg.QueryResultRow = any>(
    text: string,
    params: SqlParam[] = [],
  ): Promise<R | null> {
    const r = await this.query<R>(text, params);
    if (r.rows.length > 1) throw new InvariantViolation(`expected at most one row, got ${r.rows.length}`);
    return r.rows[0] ?? null;
  }

  async one<R extends pg.QueryResultRow = any>(text: string, params: SqlParam[] = []): Promise<R> {
    const r = await this.query<R>(text, params);
    if (r.rows.length !== 1) throw new InvariantViolation(`expected exactly one row, got ${r.rows.length}`);
    return r.rows[0]!;
  }

  /**
   * Registers work that must run inside the transaction right before COMMIT (notification planning, outbox
   * wake-up NOTIFY). Hooks with the same key are registered once.
   */
  onBeforeCommit(fn: () => Promise<void>, key: string | null = null): void {
    if (key && this.beforeCommit.some((h) => h.key === key)) return;
    this.beforeCommit.push({ key, fn });
  }

  async runBeforeCommit(): Promise<void> {
    // hooks may register further hooks (planner → outbox → notify); run until drained
    for (let i = 0; i < this.beforeCommit.length; i++) await this.beforeCommit[i]!.fn();
  }

  async savepoint(name: string): Promise<void> {
    await this.client.query(`SAVEPOINT ${name}`);
  }

  async rollbackTo(name: string): Promise<void> {
    await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  }
}
