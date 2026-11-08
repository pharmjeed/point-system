/**
 * The server's refusal as the app handles it (08 §1 envelope). Screens read `code` and `details`
 * (`attempts_left`, `locked_until`, `retry_after_s`, `field`, `reason`, `max`) and show the dictionary text for
 * known codes, else the server's `message_ar`/`message` (DEC-482).
 */
import type { CustomerErrorBody } from '@point/shared/customer';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageAr: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(status: number, body: CustomerErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.messageAr = body.message_ar;
    this.details = body.details;
    this.retryable = body.retryable;
    this.requestId = body.request_id;
  }

  /** A number in `details` (e.g. `attempts_left`), or undefined. */
  detailNumber(key: string): number | undefined {
    const v = this.details[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  /** A string in `details` (e.g. `locked_until`, `field`), or undefined. */
  detailString(key: string): string | undefined {
    const v = this.details[key];
    return typeof v === 'string' ? v : undefined;
  }
}

/** The server answered something that is not the contract (no envelope, wrong shape). */
export class BadResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BadResponseError';
  }
}

/** The session is gone (refresh refused, or the account was deleted — C-20): the app returns to sign-in. */
export class SignedOutError extends Error {
  constructor(readonly reason: 'revoked' | 'missing' | 'deleted') {
    super(`signed out: ${reason}`);
    this.name = 'SignedOutError';
  }
}

export const isApiError = (e: unknown, code?: string): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code);
