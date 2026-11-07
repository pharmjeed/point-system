/**
 * The HTTP seam of the customer API client: the real app sends with `fetch` (`httpTransport`), development and
 * tests answer in memory (`createFakeBackend`, ./fake). Both speak JSON and the envelopes of 07/08.
 */

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path with query string, e.g. `/v1/customer/locations?limit=5`. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** The request never reached the server or its answer never came back (offline, DNS, timeout). */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export interface HttpTransportOptions {
  /** `https://api.example/` — the API origin (V2-010). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** JSON over `fetch` with a timeout. Non-JSON bodies become `null` (the client then reports a bad response). */
export function httpTransport({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 15000,
}: HttpTransportOptions): Transport {
  const origin = baseUrl.replace(/\/+$/, '');
  return async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${origin}${req.path}`, {
        method: req.method,
        headers: {
          Accept: 'application/json',
          ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...req.headers,
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: res.status, body };
    } catch (cause) {
      throw new NetworkError('request failed', { cause });
    } finally {
      clearTimeout(timer);
    }
  };
}
