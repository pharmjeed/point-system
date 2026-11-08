import { ERROR_CATALOG, type ErrorCode } from '@point/shared';
import type { Tx } from '../db/tx.js';

export interface AppErrorOptions {
  /**
   * Keep the command's writes despite the rejection (07 §1.4 special cases: wrong handover code attempts,
   * login failure counters, draft_abandoned alerts). The saved idempotent response is the error.
   */
  keepEffects?: boolean;
  /** Runs after ROLLBACK TO SAVEPOINT, inside the same transaction (e.g. offer_recipients.response = 'rejected_late'). */
  afterRollback?: (tx: Tx) => Promise<void>;
  /** Seconds for the Retry-After header (429/503/IDEMPOTENCY_IN_PROGRESS). */
  retryAfterS?: number;
  cause?: unknown;
}

/** The only error type domain code throws (canon §8 codes; 08 §9.1). */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly options: AppErrorOptions;

  constructor(code: ErrorCode, details: Record<string, unknown> = {}, options: AppErrorOptions = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.options = options;
  }

  get http(): number {
    return ERROR_CATALOG[this.code].http;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Any object carrying a canon error code (e.g. a DomainError from @point/shared) is treated as an AppError. */
export function asAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    const code = (e as { code: string }).code;
    if (code in ERROR_CATALOG) {
      const details = (e as { details?: Record<string, unknown> }).details ?? {};
      return new AppError(code as ErrorCode, details);
    }
  }
  return null;
}

/** Programming errors (lock order violation, missing audit row...). Never mapped to a user-facing code. */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}
