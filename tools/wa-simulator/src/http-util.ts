import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 3 * 1024 * 1024;

/** Control-API error: `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A fully formed answer (e.g. a Graph error body) thrown from deep inside a handler. */
export class HttpAnswer extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export async function readRawBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain',
): void {
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export type Params = Record<string, string>;

export interface Route<C> {
  method: string;
  pattern: string;
  segments: string[];
  handler: (ctx: C, params: Params) => Promise<void> | void;
}

/** Minimal path router: `/:version/:id/messages` style patterns, exact segment count. */
export class Router<C> {
  private readonly routes: Route<C>[] = [];

  on(method: string, pattern: string, handler: Route<C>['handler']): this {
    this.routes.push({ method, pattern, segments: split(pattern), handler });
    return this;
  }

  match(method: string, path: string): { route: Route<C>; params: Params } | { allowed: string[] } | null {
    const parts = split(path);
    const allowed: string[] = [];
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === method) return { route, params };
      allowed.push(route.method);
    }
    return allowed.length > 0 ? { allowed } : null;
  }
}

function split(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function matchSegments(pattern: string[], parts: string[]): Params | null {
  if (pattern.length !== parts.length) return null;
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const v = parts[i] as string;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(v);
      } catch {
        return null;
      }
    } else if (p !== v) return null;
  }
  return params;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
