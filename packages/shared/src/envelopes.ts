/**
 * Response envelopes: success `{ data, meta }` (canon §9, file 07 §1.6) and error `{ error }`
 * (canon §8, file 08 §1).
 */
import { z } from 'zod';
import type { ErrorCode } from './errors.js';
import { ERROR_CATALOG, ErrorCodeSchema } from './errors.js';

export interface SuccessMeta {
  /** `req_` + ULID; equals the `X-Request-Id` response header. */
  request_id: string;
  /** ISO-8601 UTC */
  server_time: string;
  /** Lists only: cursor of the next page, `null` at the end. */
  next_cursor?: string | null;
  /** `true` when a stored response is replayed for the same `Idempotency-Key` (`Meta.replayed` in 07). */
  replayed?: boolean;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: SuccessMeta;
}

export interface ErrorBody {
  code: ErrorCode;
  /** Short English text for developers and logs. */
  message: string;
  /** Arabic text ready to display. */
  message_ar: string;
  request_id: string;
  retryable: boolean;
  /** Code-specific fields (08 §4); `{}` when none. */
  details: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

/** One invalid field in `VALIDATION_FAILED` → `details.fields` (`FieldError` in 07). */
export interface FieldError {
  field: string;
  issue: string;
  message_ar?: string;
}

export const successMetaSchema = z.object({
  request_id: z.string(),
  server_time: z.iso.datetime({ offset: true }),
  next_cursor: z.string().nullable().optional(),
  replayed: z.boolean().optional(),
});

/** zod schema of `{ data, meta }` for a given data schema. */
export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: successMetaSchema });
}

export const errorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  message_ar: z.string(),
  request_id: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const errorEnvelopeSchema = z.object({ error: errorBodySchema });

export const fieldErrorSchema = z.object({
  field: z.string(),
  issue: z.string(),
  message_ar: z.string().optional(),
});

/** Builds the error body of a code from the catalog (texts and `retryable` never vary per call). */
export function buildErrorBody(
  code: ErrorCode,
  requestId: string,
  details: Record<string, unknown> = {},
): ErrorBody {
  const def = ERROR_CATALOG[code];
  return {
    code,
    message: def.message,
    message_ar: def.message_ar,
    request_id: requestId,
    retryable: def.retryable,
    details,
  };
}

/** Builds `{ error }` for a code. */
export function buildErrorEnvelope(
  code: ErrorCode,
  requestId: string,
  details: Record<string, unknown> = {},
): ErrorEnvelope {
  return { error: buildErrorBody(code, requestId, details) };
}
