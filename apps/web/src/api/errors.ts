import { ui } from '@/i18n/ar';
import { errorMessagesAr, type ErrorCode } from '@/i18n/errors';
import { fmt } from '@/i18n/fmt';
import type { ErrorBody, FieldError } from './types';

/**
 * A server error from the error envelope (07 §1.6, 08 §1). The UI branches on `code` only (08 §1.3 rule 2)
 * and shows `message_ar` — the server text first, the 08 map as fallback.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: string;
  readonly message_ar: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly requestId: string | null;
  /** Seconds from the `Retry-After` header (429, 503, IDEMPOTENCY_IN_PROGRESS), when present. */
  readonly retryAfterS: number | null;

  constructor(init: {
    code: string;
    message?: string;
    message_ar?: string;
    status: number;
    details?: Record<string, unknown>;
    retryable?: boolean;
    requestId?: string | null;
    retryAfterS?: number | null;
  }) {
    super(init.message || init.code);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? {};
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? null;
    this.retryAfterS = init.retryAfterS ?? null;
    this.message_ar = init.message_ar || fallbackMessageAr(init.code, this.requestId);
  }

  static fromBody(body: ErrorBody, status: number, retryAfterS: number | null): ApiError {
    return new ApiError({
      code: body.code,
      message: body.message,
      message_ar: body.message_ar,
      status,
      details: body.details ?? {},
      retryable: body.retryable,
      requestId: body.request_id ?? null,
      retryAfterS,
    });
  }

  /** `details.fields` of VALIDATION_FAILED (08 §4.3). */
  get fields(): FieldError[] {
    const fields = this.details.fields;
    return Array.isArray(fields) ? (fields as FieldError[]) : [];
  }

  is(...codes: Array<ErrorCode | string>): boolean {
    return codes.includes(this.code);
  }
}

/** No reply from the network (offline, DNS, CORS, abort by timeout): the outcome is unknown (08 §8.1–8.2). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
  constructor(
    readonly reason: 'offline' | 'timeout' | 'network',
    options?: { cause?: unknown },
  ) {
    super(`network: ${reason}`, options);
  }
}

export function isApiError(error: unknown, ...codes: string[]): error is ApiError {
  return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

/**
 * Whether a failed read is the server's definitive answer — a deterministic 4xx that waiting will not change
 * (no session, no assignment, no permission…) — rather than a failure to read the state at all (5xx such as
 * INTERNAL_ERROR / SERVICE_UNAVAILABLE / DEPENDENCY_TIMEOUT, a proxy 502, RATE_LIMITED, a retryable code, no
 * reply). The sync protocol counts only the former as a completed sync (PNT-065 acceptance 2, 02 §1.7).
 */
export function isDefinitiveError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !error.retryable &&
    error.code !== 'RATE_LIMITED' &&
    error.code !== 'IDEMPOTENCY_IN_PROGRESS'
  );
}

export function fallbackMessageAr(code: string, requestId: string | null = null): string {
  const known = (errorMessagesAr as Record<string, string | undefined>)[code];
  if (known && known !== '—') return known; // «—» = webhook-only code without UI text (08 §4.13)
  return requestId ? fmt(ui.internal, { id: requestId }) : (errorMessagesAr.INTERNAL_ERROR ?? '');
}

/** The text to show for any thrown value (server error, network failure, programming error). */
export function displayMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message_ar;
  if (error instanceof NetworkError) return ui.noResponse;
  return errorMessagesAr.INTERNAL_ERROR;
}
