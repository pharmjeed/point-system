import {
  Database,
  OutboxDispatcher,
  SystemClock,
  createLogger,
  metrics,
  type Clock,
  type Env,
  type JobHandler,
  type EventProjector,
} from '@point/server';

export interface WorkerDeps {
  env: Env;
  clock?: Clock;
  database?: Database;
  handlers?: JobHandler[];
  projectors?: EventProjector[];
}

/**
 * The worker process (04 §6): one OutboxDispatcher with every job.* handler and domain-event projector.
 * Handlers are added by the domain modules sprint by sprint (handlers.ts).
 */
export function createWorker(deps: WorkerDeps) {
  const clock = deps.clock ?? new SystemClock();
  const db =
    deps.database ??
    new Database(
      {
        connectionString: deps.env.DATABASE_URL,
        poolMax: deps.env.DATABASE_POOL_MAX,
        lockTimeoutMs: deps.env.DATABASE_LOCK_TIMEOUT_MS,
        statementTimeoutMs: deps.env.DATABASE_STATEMENT_TIMEOUT_MS,
        connectTimeoutMs: deps.env.DATABASE_CONNECT_TIMEOUT_MS,
        ssl: deps.env.DATABASE_SSL,
        applicationName: 'point-worker',
      },
      clock,
    );
  db.onRetry = (sqlstate) => metrics.dbTxRetries.inc({ sqlstate });
  const logger = createLogger({ level: deps.env.LOG_LEVEL, name: 'point-worker' });
  db.onIdleError = (err) => logger.warn({ err }, 'idle database connection failed; it will be replaced');
  const dispatcher = new OutboxDispatcher(
    db,
    clock,
    logger,
    {
      workerId: deps.env.WORKER_ID || undefined,
      batchSize: deps.env.WORKER_BATCH_SIZE,
      concurrency: deps.env.WORKER_CONCURRENCY,
      leaseSeconds: deps.env.WORKER_LEASE_SECONDS,
      pollIntervalMs: deps.env.WORKER_POLL_INTERVAL_MS,
    },
    {
      onOutcome: (row, outcome, lagMs) => {
        metrics.outboxEvents.inc({ type: row.type, status: outcome === 'retry' ? 'failed' : outcome });
        if (row.type.startsWith('job.')) metrics.timerLag.observe({ job: row.type }, lagMs / 1000);
      },
    },
  );
  for (const h of deps.handlers ?? []) dispatcher.register(h);
  for (const p of deps.projectors ?? []) dispatcher.registerProjector(p);
  return { db, clock, logger, dispatcher };
}
