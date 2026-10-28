import type { NextFunction, Request, Response } from 'express';
import { resolveRequestId } from './request-id.js';

/** Sets req.requestId and the X-Request-Id response header; API responses are never cached (05 §14.1). */
export function requestContextMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
) {
  const id = resolveRequestId(req.headers['x-request-id']);
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  if (req.path.startsWith('/v1')) res.setHeader('Cache-Control', 'no-store');
  next();
}
