import { hostname } from 'node:os';
import pg from 'pg';
import type { Clock } from '../clock/clock.js';
import type { Database } from '../db/database.js';
import type { Tx } from '../db/tx.js';
import type { Logger } from '../logging/logger.js';
import { OUTBOX_NOTIFY_CHANNEL } from './outbox-writer.js';

export interface OutboxRow {
  id: string;
  seq: number;
  org_id: string;
  type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  aggregate_version: number | null;
  venue_id: string | null;
  ordering_key: string | null;
  dedupe_key: string | null;
  payload: Record<string, any>;
  available_at: Date;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  created_at: Date;
}

/** Transient failure: the row goes back to `pending` with backoff (04 §6.4). */
export class RetryableJobError extends Error {
  constructor(
    message: string,
    readonly delayMs?: number,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

/** Final failure: the row becomes `failed` (no more attempts). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface JobContext {
  row: OutboxRow;
  /** present for mode 'tx': the handler's writes commit atomically with the row becoming `done` */
  tx?: Tx;
  db: Database;
  clock: Clock;
  logger: Logger;
  renewLease(): Promise<void>;
}

export interface JobHandler {
  type: string;
  /**
   * 'tx': the handler runs inside a transaction that first marks the row done (so a periodic job can schedule
   * its successor with the same dedupe_key) — DB-only work such as timers.
   * 'external': the handler talks to the network (Graph API, Push) and opens its own short transactions.
   */
  mode: 'tx' | 'external';
  handle(ctx: JobContext): Promise<void>;
}

/** Consumer of domain events (AnalyticsProjector, AlertAutoResolver…): idempotent and order-independent. */
export interface EventProjector {
  name: string;
  accepts(type: string): boolean;
  project(tx: Tx, row: OutboxRow): Promise<void>;
}

export interface DispatcherOptions {
  workerId?: string;
  batchSize?: number;
  concurrency?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
}

/** Delay before the next attempt, by attempts already made (04 §6.4), with ±20% jitter. */
const BACKOFF_S = [2, 5, 15, 30, 60, 120, 300];

export function backoffMs(attempts: number, jitter = true): number {
  const base = BACKOFF_S[Math.min(Math.max(attempts, 1), BACKOFF_S.length) - 1]! * 1000;
  if (!jitter) return base;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export interface DispatcherHooks {
  onOutcome?: (row: OutboxRow, outcome: 'done' | 'failed' | 'dead' | 'retry', lagMs: number) => void;
  onDead?: (row: OutboxRow) => Promise<void>;
}

/**
 * OutboxDispatcher (04 §6): leases due rows with FOR UPDATE SKIP LOCKED, preserving per-ordering_key order,
 * runs the registered handler, then marks done / retries with backoff / fails / dead-letters.
 */
export class OutboxDispatcher {
  readonly workerId: string;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly projectors: EventProjector[] = [];
  private readonly opts: Required<Omit<DispatcherOptions, 'workerId'>>;
  private running = false;
  private wake: (() => void) | null = null;
  private listener: pg.Client | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    opts: DispatcherOptions = {},
    private readonly hooks: DispatcherHooks = {},
  ) {
    this.workerId = opts.workerId || `${hostname()}:${process.pid}`;
    this.opts = {
      batchSize: opts.batchSize ?? 20,
      concurrency: opts.concurrency ?? 8,
      leaseSeconds: opts.leaseSeconds ?? 30,
      pollIntervalMs: opts.pollIntervalMs ?? 500,
    };
  }

  register(handler: JobHandler): this {
    if (this.handlers.has(handler.type)) throw new Error(`duplicate handler for ${handler.type}`);
    this.handlers.set(handler.type, handler);
    return this;
  }

  registerProjector(p: EventProjector): this {
    this.projectors.push(p);
    return this;
  }

  get registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /** Leases one batch and processes it. Returns the number of rows leased. */
  async tick(): Promise<number> {
    const rows = await this.lease();
    await runLimited(rows, this.opts.concurrency, (r) => this.process(r));
    return rows.length;
  }

  /** Processes until nothing is due (tests and drains). */
  async drain(maxRounds = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  async lease(): Promise<OutboxRow[]> {
    const now = this.clock.now();
    const r = await this.db.query<OutboxRow>(
      `WITH due AS (
         SELECT o.id FROM outbox_events o
         WHERE o.status = 'pending' AND o.available_at <= $1
           AND (o.ordering_key IS NULL OR NOT EXISTS (
                 SELECT 1 FROM outbox_events p
                 WHERE p.ordering_key = o.ordering_key AND p.status IN ('pending','processing') AND p.seq < o.seq))
         ORDER BY o.available_at, o.seq
         FOR UPDATE SKIP LOCKED
         LIMIT $2)
       UPDATE outbox_events e
          SET status = 'processing', locked_by = $3, locked_until = $1::timestamptz + make_interval(secs => $4), attempts = e.attempts + 1
         FROM due WHERE e.id = due.id
       RETURNING e.*`,
      [now, this.opts.batchSize, this.workerId, this.opts.leaseSeconds],
    );
    return r.rows.sort((a, b) => a.seq - b.seq);
  }

  /** Rows whose lease expired (a crashed worker) go back to pending without consuming another attempt. */
  async recoverExpiredLeases(): Promise<number> {
    const r = await this.db.query(
      `UPDATE outbox_events SET status = 'pending', locked_by = NULL, locked_until = NULL
        WHERE status = 'processing' AND locked_until < $1`,
      [this.clock.now()],
    );
    return r.rowCount ?? 0;
  }

  private async process(row: OutboxRow): Promise<void> {
    const lagMs = Math.max(0, this.clock.now().getTime() - new Date(row.available_at).getTime());
    const log = this.logger.child({ outbox_id: row.id, job_type: row.type, attempt: row.attempts });
    const renewLease = async () => {
      await this.db.query(
        `UPDATE outbox_events SET locked_until = $3::timestamptz + make_interval(secs => $4) WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
        [row.id, this.workerId, this.clock.now(), this.opts.leaseSeconds],
      );
    };
    try {
      if (!row.type.startsWith('job.')) {
        const interested = this.projectors.filter((p) => p.accepts(row.type));
        await this.db.transaction(async (tx) => {
          if (!(await this.markDone(tx, row))) return;
          for (const p of interested) await p.project(tx, row);
        });
        this.hooks.onOutcome?.(row, 'done', lagMs);
        return;
      }
      const handler = this.handlers.get(row.type);
      if (!handler) throw new PermanentJobError(`no handler registered for ${row.type}`);
      if (handler.mode === 'tx') {
        await this.db.transaction(async (tx) => {
          if (!(await this.markDone(tx, row))) return;
          await handler.handle({ row, tx, db: this.db, clock: this.clock, logger: log, renewLease });
        });
      } else {
        await handler.handle({ row, db: this.db, clock: this.clock, logger: log, renewLease });
        await this.markDone(this.db, row);
      }
      this.hooks.onOutcome?.(row, 'done', lagMs);
    } catch (e) {
      await this.fail(row, e, log, lagMs);
    }
  }

  private async markDone(q: Tx | Database, row: OutboxRow): Promise<boolean> {
    const r = await q.query(
      `UPDATE outbox_events SET status = 'done', processed_at = $3, locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
      [row.id, this.workerId, this.clock.now()],
    );
    if ((r.rowCount ?? 0) === 0) {
      this.logger.warn({ outbox_id: row.id, job_type: row.type }, 'outbox lease lost before completion');
      return false;
    }
    return true;
  }

  private async fail(row: OutboxRow, e: unknown, log: Logger, lagMs: number): Promise<void> {
    const message = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 2000);
    const now = this.clock.now();
    if (e instanceof PermanentJobError) {
      log.error({ err: message }, 'outbox job failed permanently');
      await this.db.query(
        `UPDATE outbox_events SET status = 'failed', last_error = $3, processed_at = $4, locked_by = NULL, locked_until = NULL
          WHERE id = $1 AND locked_by = $2`,
        [row.id, this.workerId, message, now],
      );
      this.hooks.onOutcome?.(row, 'failed', lagMs);
      return;
    }
    if (row.attempts >= row.max_attempts) {
      log.error({ err: message }, 'outbox job exhausted its attempts (dead)');
      await this.db.query(
        `UPDATE outbox_events SET status = 'dead', last_error = $3, processed_at = $4, locked_by = NULL, locked_until = NULL
          WHERE id = $1 AND locked_by = $2`,
        [row.id, this.workerId, message, now],
      );
      this.hooks.onOutcome?.(row, 'dead', lagMs);
      await this.hooks.onDead?.(row).catch((err) => log.error({ err }, 'onDead hook failed'));
      return;
    }
    const delay = e instanceof RetryableJobError && e.delayMs != null ? e.delayMs : backoffMs(row.attempts);
    log.warn({ err: message, retry_in_ms: delay }, 'outbox job will be retried');
    await this.db.query(
      `UPDATE outbox_events SET status = 'pending', last_error = $3, available_at = $4, locked_by = NULL, locked_until = NULL
        WHERE id = $1 AND locked_by = $2`,
      [row.id, this.workerId, message, new Date(now.getTime() + delay)],
    );
    this.hooks.onOutcome?.(row, 'retry', lagMs);
  }

  /** LISTEN point_outbox + poll every pollIntervalMs (04 §6.2). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connectListener();
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    await this.listener?.end().catch(() => {});
    this.listener = null;
  }

  private async connectListener(): Promise<void> {
    // bounded like the pool (DEC-PROPOSED-8): a database that does not answer must not hold the start
    const c = new pg.Client(this.db.listenClientConfig('listen'));
    let ready = false;
    c.on('error', (err) => {
      if (!ready) return; // reported by connect/LISTEN below
      this.logger.warn({ err: err.message }, 'outbox listener error; reconnecting');
      this.listener = null;
      if (this.running) setTimeout(() => void this.connectListener(), 1000);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${OUTBOX_NOTIFY_CHANNEL}`);
    } catch (err) {
      void c.end().catch(() => {});
      this.logger.warn({ err: (err as Error).message }, 'outbox listener unavailable; polling only');
      if (this.running) setTimeout(() => void this.connectListener(), 2000);
      return;
    }
    ready = true;
    c.on('notification', () => this.wake?.());
    this.listener = c;
  }

  private async loop(): Promise<void> {
    let lastRecovery = 0;
    while (this.running) {
      try {
        if (Date.now() - lastRecovery > this.opts.leaseSeconds * 1000) {
          await this.recoverExpiredLeases();
          lastRecovery = Date.now();
        }
        const n = await this.tick();
        if (n >= this.opts.batchSize) continue; // more work is likely due
      } catch (err) {
        this.logger.error({ err }, 'outbox loop error');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollIntervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}

async function runLimited<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  // rows sharing an ordering_key are never leased together (NOT EXISTS on earlier rows), so parallelism is safe
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
