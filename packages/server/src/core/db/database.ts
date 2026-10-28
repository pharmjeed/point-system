import pg from 'pg';
import type { Clock } from '../clock/clock.js';
import { isPgError } from '../errors/pg-constraint-map.js';
import { Tx } from './tx.js';
import { runTxPlanners } from './tx-planners.js';

// int8 columns (amounts in halalas, identity ids) fit comfortably in a JS number for this domain.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric → number (reports)
pg.types.setTypeParser(1700, (v) => Number(v));

export interface DatabaseConfig {
  connectionString: string;
  poolMax?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  ssl?: boolean;
  applicationName?: string;
}

export interface TxOptions {
  /** retry the whole transaction on 40001/40P01 (canon §14ب). Default 3 attempts. */
  maxAttempts?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);

export class Database {
  readonly pool: pg.Pool;
  /** called with the SQLSTATE each time a transaction is retried (point_db_tx_retries_total). */
  onRetry: ((sqlstate: string) => void) | null = null;
  /**
   * Called when an idle pooled connection fails (server restart, failover, terminated backend). pg drops that client
   * and opens a new one on demand; without a listener the pool's 'error' event would crash the process.
   */
  onIdleError: ((err: Error) => void) | null = null;

  constructor(
    readonly config: DatabaseConfig,
    readonly clock: Clock,
  ) {
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      max: config.poolMax ?? 20,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      application_name: config.applicationName ?? 'point',
    });
    this.pool.on('error', (err) => this.onIdleError?.(err));
  }

  async query<R extends pg.QueryResultRow = any>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  async rows<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.pool.query<R>(text, params)).rows;
  }

  /**
   * BEGIN (READ COMMITTED) → SET LOCAL lock_timeout / statement_timeout → fn → before-commit hooks → COMMIT.
   * Network calls are never made inside `fn` (05 §7.4). Serialization failures and deadlocks retry the whole
   * transaction up to 3 times with 20–80 ms jitter; a lock timeout (55P03) is never retried here.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const attempts = opts.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce(fn, opts);
      } catch (e) {
        if (isPgError(e) && RETRYABLE_SQLSTATE.has(e.code!) && attempt < attempts) {
          this.onRetry?.(e.code!);
          await sleep(20 + Math.random() * 60);
          continue;
        }
        throw e;
      }
    }
  }

  private async runOnce<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SET LOCAL lock_timeout = ${Math.trunc(opts.lockTimeoutMs ?? this.config.lockTimeoutMs ?? 3000)}`,
      );
      await client.query(
        `SET LOCAL statement_timeout = ${Math.trunc(opts.statementTimeoutMs ?? this.config.statementTimeoutMs ?? 5000)}`,
      );
      const tx = new Tx(client, this.clock.now(), this.clock);
      const result = await fn(tx);
      await runTxPlanners(tx);
      await tx.runBeforeCommit();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
