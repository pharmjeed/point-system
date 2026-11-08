import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_CATALOG, type ErrorCode } from '@point/shared';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, asAppError } from '../core/errors/app-error.js';
import { errorEnvelope } from '../core/errors/envelope.js';
import { dbUnavailableError, isPgError, mapPgError } from '../core/errors/pg-constraint-map.js';
import type { Logger } from '../core/logging/logger.js';
import { LOGGER } from './tokens.js';
import { resolveRequestId } from './request-id.js';
import { zodToFields } from './zod-pipe.js';
import { requestLogFields } from './middleware.js';

/** One envelope for every non-2xx response (canon §8, 08 §9.2). */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request & { requestId?: string; actor?: any }>();
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const { error, unexpected } = toHttpAppError(err);
    const def = ERROR_CATALOG[error.code];
    sendError(res, error, requestId);
    // 05 §7.6 fields; an unmatched route also logs its path (never the query: it may carry tokens)
    const fields = {
      ...requestLogFields(req, def.http),
      request_id: requestId,
      code: error.code,
      ...(req.route ? {} : { path: req.path }),
    };
    if (unexpected || def.http >= 500) this.logger.error({ ...fields, err: describe(err) }, 'request failed');
    else if (def.log === 'warn') this.logger.warn(fields, 'request rejected');
    else this.logger.info(fields, 'request rejected');
  }
}

export function sendError(res: Response, error: AppError, requestId: string): void {
  const def = ERROR_CATALOG[error.code];
  if (def.http === 429 || def.http === 503 || error.code === 'IDEMPOTENCY_IN_PROGRESS') {
    res.setHeader('Retry-After', String(error.options.retryAfterS ?? 1));
  }
  res.setHeader('X-Request-Id', requestId);
  res
    .status(def.http)
    .type('application/json; charset=utf-8')
    .send(JSON.stringify(errorEnvelope(error.code, error.details, requestId)));
}

export function toHttpAppError(err: unknown): { error: AppError; unexpected: boolean } {
  const app = asAppError(err);
  if (app) return { error: app, unexpected: false };
  if (err instanceof ZodError)
    return { error: new AppError('VALIDATION_FAILED', { fields: zodToFields(err) }), unexpected: false };
  // the database cannot be reached (08 §5 class 08 without a SQLSTATE): SERVICE_UNAVAILABLE, before isPgError
  const unavailable = dbUnavailableError(err);
  if (unavailable) return { error: unavailable, unexpected: false };
  if (isPgError(err)) {
    const m = mapPgError(err);
    return { error: m.error, unexpected: m.unexpected };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const map: Record<number, ErrorCode> = {
      404: 'RESOURCE_NOT_FOUND',
      413: 'PAYLOAD_TOO_LARGE',
      400: 'VALIDATION_FAILED',
      415: 'VALIDATION_FAILED',
      429: 'RATE_LIMITED',
    };
    const code = map[status];
    if (code) {
      const details =
        status === 404
          ? { resource: 'route' }
          : status === 413
            ? maxBytes(err.cause)
            : status === 400 && isJsonSyntaxError(err)
              ? MALFORMED_BODY
              : {};
      return { error: new AppError(code, details), unexpected: false };
    }
  }
  // body-parser errors (malformed JSON, too large) as plain errors with a status (other adapters)
  const status = (err as { status?: number; type?: string })?.status;
  if (status === 413) return { error: new AppError('PAYLOAD_TOO_LARGE', maxBytes(err)), unexpected: false };
  if (status === 400) return { error: new AppError('VALIDATION_FAILED', MALFORMED_BODY), unexpected: false };
  return { error: new AppError('INTERNAL_ERROR'), unexpected: true };
}

/** 08 §4.3 / DEC-126: a body that is not JSON is a problem at the root of the body, the field `(body)`. */
const MALFORMED_BODY = { fields: [{ field: '(body)', issue: 'malformed_json' }] };

/**
 * The Express adapter of Nest 12 turns body-parser's `SyntaxError` (a body that is not JSON) into a
 * `BadRequestException` carrying only its message, and does the same with Express's `URIError` for a path
 * parameter that does not decode ("Failed to decode param …"), which is not a body problem.
 */
function isJsonSyntaxError(err: HttpException): boolean {
  return /\bJSON\b/.test(err.message) && !/decode param/i.test(err.message);
}

/**
 * 08 §4.15: PAYLOAD_TOO_LARGE carries the limit the body exceeded (body-parser's `limit`, in bytes, DEC-130). The
 * Express adapter hands a body-parser error over as the `cause` of an HttpException.
 */
function maxBytes(err: unknown): Record<string, unknown> {
  const limit = (err as { limit?: unknown })?.limit;
  return typeof limit === 'number' ? { max_bytes: limit } : {};
}

function describe(err: unknown) {
  if (err instanceof Error)
    return { name: err.name, message: err.message, stack: err.stack, cause: (err as any).cause };
  return { value: String(err) };
}
