import pg from 'pg';
import type { Clock } from '../clock/clock.js';
import { isDbUnavailableError, isPgError, markDbError } from '../errors/pg-constraint-map.js';
import { Tx, queryOn } from './tx.js';
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
  /**
   * DATABASE_CONNECT_TIMEOUT_MS (default 5000; 0 = wait without bound): a pool slot or a new connection not
   * obtained in time fails with «timeout exceeded when trying to connect» / «Connection terminated due to
   * connection timeout» → SERVICE_UNAVAILABLE (DEC-PROPOSED-8, 17 §12).
   */
  connectTimeoutMs?: number;
  ssl?: boolean;
  applicationName?: string;
}

export interface TxOptions {
  /** retry the whole transaction on 40001/40P01 (canon §14ب). Default 3 attempts. */
  maxAttempts?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface QueryOptions {
  /** client read timeout of this query (default: the pool's, statement timeout + READ_TIMEOUT_MARGIN_MS) */
  timeoutMs?: number;
}

const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);

/**
 * The client gives a query this long beyond the statement timeout before it stops waiting (DEC-PROPOSED-8): a
 * live server cancels the statement itself (57014) first, so the client read timeout only fires when the server
 * cannot answer at all — paused, frozen or behind a stalled link — where `statement_timeout`, enforced by the
 * server, never fires.
 */
export const READ_TIMEOUT_MARGIN_MS = 2000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** The client read timeout of a statement timeout (0 = none: the server has no bound either). */
export function readTimeoutFor(statementTimeoutMs: number): number {
  return statementTimeoutMs > 0 ? statementTimeoutMs + READ_TIMEOUT_MARGIN_MS : 0;
}

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
      connectionTimeoutMillis: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      // a query outside a transaction (reads, the session check) gets the default statement timeout's bound;
      // a pool query that fails is always destroyed by pg-pool (release(err)), never handed out again
      query_timeout: readTimeoutFor(this.statementTimeoutMs()) || undefined,
    });
    this.pool.on('error', (err) => this.onIdleError?.(err));
  }

  /** The connect timeout of this database's connections. */
  get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /**
   * A dedicated connection outside the pool (the LISTEN clients of the outbox dispatcher and of the realtime
   * relay), bounded like the pool's: a database that does not answer fails its connect and its LISTEN in time
   * instead of holding the caller (DEC-PROPOSED-8).
   */
  listenClientConfig(name: string): pg.ClientConfig {
    return {
      connectionString: this.config.connectionString,
      ssl: this.config.ssl ? { rejectUnauthorized: true } : undefined,
      application_name: `${this.config.applicationName ?? 'point'}-${name}`,
      connectionTimeoutMillis: this.connectTimeoutMs,
      query_timeout: readTimeoutFor(this.statementTimeoutMs()) || undefined,
    };
  }

  private statementTimeoutMs(opts: TxOptions = {}): number {
    return Math.trunc(opts.statementTimeoutMs ?? this.config.statementTimeoutMs ?? 5000);
  }

  async query<R extends pg.QueryResultRow = any>(
    text: string,
    params: unknown[] = [],
    opts: QueryOptions = {},
  ): Promise<pg.QueryResult<R>> {
    try {
      if (!opts.timeoutMs) return await this.pool.query<R>(text, params);
      const config: pg.QueryConfig & { query_timeout: number } = { text, query_timeout: opts.timeoutMs };
      return await this.pool.query<R>(config, params);
    } catch (e) {
      throw markDbError(e);
    }
  }

  async rows<R extends pg.QueryResultRow = any>(
    text: string,
    params: unknown[] = [],
    opts: QueryOptions = {},
  ): Promise<R[]> {
    return (await this.query<R>(text, params, opts)).rows;
  }

  /**
   * `SELECT 1` answered within `timeoutMs`, the wait for a connection included (the readiness probe: the
   * container health check gives it 3 s). The query itself stays bounded by the pool's own timeouts.
   */
  async ping(timeoutMs: number): Promise<void> {
    const q = this.query('SELECT 1', [], { timeoutMs });
    q.catch(() => {}); // settled by the pool's own timeouts when the deadline wins
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(markDbError(new Error(`Query read timeout (no answer within ${timeoutMs} ms)`))),
        timeoutMs,
      );
    });
    try {
      await Promise.race([q, deadline]);
    } finally {
      clearTimeout(timer);
    }
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

  /**
   * Every statement of the transaction waits at most its statement timeout + READ_TIMEOUT_MARGIN_MS for an answer.
   * A connection that timed out or broke is destroyed (release with the error), never returned to the pool: its
   * unanswered statement would block the next user, and no ROLLBACK is sent on it — the server rolls back the
   * transaction of a closed connection itself. Whether a COMMIT that got no answer committed is unknown to the
   * caller: it answers SERVICE_UNAVAILABLE and the client retries with the same Idempotency-Key (08 §8.1).
   */
  private async runOnce<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw markDbError(e);
    }
    const statementTimeoutMs = this.statementTimeoutMs(opts);
    const readTimeoutMs = readTimeoutFor(statementTimeoutMs);
    let broken: Error | null = null;
    try {
      const control = (text: string) => queryOn(client, text, readTimeoutMs);
      await control('BEGIN');
      await control(
        `SET LOCAL lock_timeout = ${Math.trunc(opts.lockTimeoutMs ?? this.config.lockTimeoutMs ?? 3000)}`,
      );
      await control(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      const tx = new Tx(client, this.clock.now(), this.clock, readTimeoutMs);
      const result = await fn(tx);
      await runTxPlanners(tx);
      await tx.runBeforeCommit();
      await control('COMMIT');
      return result;
    } catch (e) {
      if (isDbUnavailableError(e)) broken = asError(e);
      else
        await queryOn(client, 'ROLLBACK', readTimeoutMs).catch((re: unknown) => {
          broken = asError(re);
        });
      throw e;
    } finally {
      client.release(broken ?? undefined);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
