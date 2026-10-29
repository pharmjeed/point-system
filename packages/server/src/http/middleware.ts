import { performance } from 'node:perf_hooks';
import { fromExpressPath } from '@point/shared';
import type { NextFunction, Request, Response } from 'express';
import { metrics } from '../core/metrics/metrics.js';
import { resolveRequestId } from './request-id.js';

/**
 * The `route` label of `point_http_request_duration_seconds` (05 §12.2): the method and the canon path template of
 * the matched route (`POST /v1/tickets/{ticketId}/submit-intake`), never the raw path (no ids in labels); a request
 * no route matched is `unmatched`.
 */
export function httpRouteLabel(
  req: Pick<Request, 'method' | 'baseUrl'> & { route?: { path?: unknown } },
): string {
  const path = req.route?.path;
  if (typeof path !== 'string') return 'unmatched';
  return `${req.method} ${fromExpressPath(`${req.baseUrl ?? ''}${path}`) || '/'}`;
}

/** The `status` label of a request whose client closed the connection before the response was sent. */
export const HTTP_ABORTED_STATUS = 'aborted';

/**
 * Sets req.requestId and the X-Request-Id response header; API responses are never cached (05 §14.1). Every request
 * is timed once into `point_http_request_duration_seconds{route,status}` (05 §12.2; the request-save target of
 * 15 §10 reads it for `POST /v1/tickets/{ticketId}/retrievals`): at `finish` with the HTTP status, or — Node emits no
 * `finish` when the client gave up first (the PWA aborts after 10 s) — at `close` with the status `aborted`, so the
 * slowest requests, the tail behind the target, stay in the histogram.
 */
export function requestContextMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
) {
  const started = performance.now();
  const id = resolveRequestId(req.headers['x-request-id']);
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  if (req.path.startsWith('/v1')) res.setHeader('Cache-Control', 'no-store');
  let timed = false;
  const observe = (status: string) => {
    if (timed) return;
    timed = true;
    metrics.httpDuration.observe(
      { route: httpRouteLabel(req), status },
      (performance.now() - started) / 1000,
    );
  };
  res.once('finish', () => observe(String(res.statusCode)));
  res.once('close', () => observe(res.writableFinished ? String(res.statusCode) : HTTP_ABORTED_STATUS));
  next();
}
