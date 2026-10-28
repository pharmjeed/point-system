import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_CATALOG, type ErrorCode } from '@point/shared';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, asAppError } from '../core/errors/app-error.js';
import { errorEnvelope } from '../core/errors/envelope.js';
import { isPgError, mapPgError } from '../core/errors/pg-constraint-map.js';
import type { Logger } from '../core/logging/logger.js';
import { LOGGER } from './tokens.js';
import { resolveRequestId } from './request-id.js';
import { zodToFields } from './zod-pipe.js';

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
    const fields = {
      request_id: requestId,
      code: error.code,
      http: def.http,
      user_id: req.actor?.userId,
      role: req.actor?.role,
      venue_id: req.actor?.venueId,
      route: req.route?.path ?? req.path,
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
    if (code)
      return { error: new AppError(code, status === 404 ? { resource: 'route' } : {}), unexpected: false };
  }
  // body-parser errors (malformed JSON, too large) are plain errors with a status
  const status = (err as { status?: number; type?: string })?.status;
  if (status === 413) return { error: new AppError('PAYLOAD_TOO_LARGE'), unexpected: false };
  if (status === 400)
    return {
      error: new AppError('VALIDATION_FAILED', { fields: [{ field: 'body', issue: 'malformed_json' }] }),
      unexpected: false,
    };
  return { error: new AppError('INTERNAL_ERROR'), unexpected: true };
}

function describe(err: unknown) {
  if (err instanceof Error)
    return { name: err.name, message: err.message, stack: err.stack, cause: (err as any).cause };
  return { value: String(err) };
}
