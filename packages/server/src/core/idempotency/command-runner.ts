import { ERROR_CATALOG } from '@point/shared';
import type { Database } from '../db/database.js';
import type { Tx } from '../db/tx.js';
import { AppError, InvariantViolation, asAppError } from '../errors/app-error.js';
import { errorEnvelope, successEnvelope } from '../errors/envelope.js';
import { isPgError, mapPgError } from '../errors/pg-constraint-map.js';

export interface CommandContext {
  userId: string;
  idempotencyKey: string;
  /** method + route template, e.g. 'POST /v1/task-offers/{offerId}/accept' */
  operation: string;
  requestHash: string;
  requestId: string;
}

export interface CommandSuccess<T> {
  data: T;
  /** HTTP status of the success response (default 200; 201 for creations). */
  status?: number;
}

export interface CommandResponse {
  status: number;
  body: unknown;
  replayed: boolean;
  /** set when the response is an error (the caller logs it and sets Retry-After if needed) */
  error?: AppError;
}

/** Statuses whose responses are kept with the key (2xx and deterministic 4xx); 401/429/5xx are not (07 §1.4). */
export function isPersistedStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && status !== 401 && status !== 429;
}

const KEY_RE = /^[\x21-\x7e]{8,128}$/;

export function validateIdempotencyKey(key: string | undefined): string {
  if (!key) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  if (!KEY_RE.test(key))
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ field: 'Idempotency-Key', issue: 'length_8_128' }],
    });
  return key;
}

/**
 * The command protocol of 07 §1.4 / 10 §13.3:
 *  L0  INSERT idempotency_keys … ON CONFLICT DO NOTHING (first statement; a concurrent duplicate waits here)
 *      → completed + same hash: replay; different hash/operation: IDEMPOTENCY_KEY_REUSED;
 *        lock_timeout while waiting: IDEMPOTENCY_IN_PROGRESS
 *  SAVEPOINT cmd → command → success: save envelope, COMMIT
 *                         → AppError 4xx: ROLLBACK TO SAVEPOINT (unless keepEffects), save error, COMMIT
 *                         → 401/429/5xx or unexpected: full ROLLBACK, key row disappears, retry allowed
 */
export async function runCommand<T>(
  db: Database,
  ctx: CommandContext,
  fn: (tx: Tx) => Promise<CommandSuccess<T>>,
  opts: { assertAudit?: boolean; pgContext?: { operation?: string } } = {},
): Promise<CommandResponse> {
  try {
    return await db.transaction(async (tx) => {
      const claimed = await claimKey(tx, ctx);
      if (claimed.kind === 'replay') return claimed.response;

      await tx.savepoint('cmd');
      let response: CommandResponse;
      try {
        const ok = await fn(tx);
        const status = ok.status ?? 200;
        if ((opts.assertAudit ?? process.env.NODE_ENV === 'test') && tx.auditCount === 0) {
          throw new InvariantViolation(
            `command ${ctx.operation} committed without an audit_log row (PNT-009)`,
          );
        }
        response = { status, body: successEnvelope(ok.data, ctx.requestId, tx.now), replayed: false };
      } catch (e) {
        // deadlock / serialization failure: let Database.transaction retry the whole transaction
        if (isPgError(e) && (e.code === '40001' || e.code === '40P01')) throw e;
        const appErr = toAppError(e, opts.pgContext ?? { operation: ctx.operation });
        if (!appErr || !isPersistedStatus(appErr.http)) throw isPgError(e) ? e : (appErr ?? e);
        if (!appErr.options.keepEffects) {
          await tx.rollbackTo('cmd');
          // events/hooks registered by the rolled-back work must not run
          tx.events.length = 0;
        }
        await appErr.options.afterRollback?.(tx);
        response = {
          status: appErr.http,
          body: errorEnvelope(appErr.code, appErr.details, ctx.requestId),
          replayed: false,
          error: appErr,
        };
      }
      await tx.query(
        `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4, completed_at = $5
         WHERE user_id = $1 AND key = $2`,
        [ctx.userId, ctx.idempotencyKey, response.status, JSON.stringify(response.body), tx.now],
      );
      return response;
    });
  } catch (e) {
    const appErr = toAppError(e, opts.pgContext ?? { operation: ctx.operation });
    if (appErr)
      return {
        status: appErr.http,
        body: errorEnvelope(appErr.code, appErr.details, ctx.requestId),
        replayed: false,
        error: appErr,
      };
    throw e;
  }
}

/**
 * Same pipeline without an idempotency key (public commands such as login, optional-key routes). A rejection
 * with `keepEffects` still commits its writes (failed-login counters, 08 §1.3 rule 6b).
 */
export async function runInTransaction<T>(
  db: Database,
  requestId: string,
  fn: (tx: Tx) => Promise<CommandSuccess<T>>,
  opts: { pgContext?: { operation?: string } } = {},
): Promise<CommandResponse> {
  try {
    return await db.transaction(async (tx) => {
      try {
        const ok = await fn(tx);
        return {
          status: ok.status ?? 200,
          body: successEnvelope(ok.data, requestId, tx.now),
          replayed: false,
        };
      } catch (e) {
        const appErr = asAppError(e);
        if (appErr?.options.keepEffects) {
          return {
            status: appErr.http,
            body: errorEnvelope(appErr.code, appErr.details, requestId),
            replayed: false,
            error: appErr,
          };
        }
        throw e;
      }
    });
  } catch (e) {
    const appErr = toAppError(e, opts.pgContext ?? {});
    if (appErr) {
      return {
        status: appErr.http,
        body: errorEnvelope(appErr.code, appErr.details, requestId),
        replayed: false,
        error: appErr,
      };
    }
    throw e;
  }
}

type Claim = { kind: 'claimed' } | { kind: 'replay'; response: CommandResponse };

async function claimKey(tx: Tx, ctx: CommandContext): Promise<Claim> {
  let inserted;
  try {
    inserted = await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, operation, request_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '24 hours')
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [ctx.userId, ctx.idempotencyKey, ctx.operation, ctx.requestHash, tx.now],
    );
  } catch (e) {
    if (isPgError(e) && e.code === '55P03')
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', {}, { retryAfterS: 1 });
    throw e;
  }
  if (inserted.rowCount === 1) return { kind: 'claimed' };

  const prev = await tx.one<{
    operation: string;
    request_hash: string;
    status: string;
    response_status: number | null;
    response_body: Record<string, any> | null;
    expires_at: Date;
  }>(
    `SELECT operation, request_hash, status, response_status, response_body, expires_at FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [ctx.userId, ctx.idempotencyKey],
  );
  if (prev.expires_at.getTime() <= tx.now.getTime()) {
    // An expired key not yet purged by job.retention_purge counts as unknown.
    await tx.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [
      ctx.userId,
      ctx.idempotencyKey,
    ]);
    return claimKey(tx, ctx);
  }
  if (prev.request_hash !== ctx.requestHash || prev.operation !== ctx.operation)
    throw new AppError('IDEMPOTENCY_KEY_REUSED');
  if (prev.status !== 'completed' || prev.response_status == null) {
    // Cannot normally happen: the first transaction completes the row before COMMIT.
    throw new AppError('IDEMPOTENCY_IN_PROGRESS', {}, { retryAfterS: 1 });
  }
  const body = prev.response_body ?? {};
  if (body && typeof body === 'object' && 'meta' in body && body.meta && typeof body.meta === 'object') {
    body.meta = { ...body.meta, replayed: true };
  }
  return { kind: 'replay', response: { status: prev.response_status, body, replayed: true } };
}

export function toAppError(e: unknown, pgContext: { operation?: string }): AppError | null {
  const app = asAppError(e);
  if (app) return app;
  if (isPgError(e)) return mapPgError(e, pgContext).error;
  return null;
}

export function retryableFor(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

export { ERROR_CATALOG };
