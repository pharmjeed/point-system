import type { Page, Request } from '@playwright/test';
import { compile, matchRoute, type RoutePattern } from './fake/http';

/**
 * What the command-press checks need from a backend: the calls that reached a route (`"POST /v1/tickets/:id"`)
 * with their headers, body and status, and a way to hold the next one back so the pending button can be
 * observed. The fake backend has both; `BrowserCommandLog` gives the same to a page talking to the real API.
 */
export interface LoggedCall {
  method: string;
  path: string;
  route: string | null;
  headers: Record<string, string>;
  body: unknown;
  /** 0 until the reply arrived; -1 for a dropped connection. */
  status: number;
  /** `meta.request_id` / `error.request_id` of the reply (the audit row carries it). */
  requestId?: string | null;
}

export interface CommandLog {
  readonly calls: readonly LoggedCall[];
  callsTo(spec: string): LoggedCall[];
  delayNext(spec: string, ms: number, times?: number): unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Records every `/v1/*` request of one page in the browser and lets it through to the network unchanged
 * (`route.continue()`, so cookies and the same-origin proxy behave as in production); replies are matched
 * by the `response` event. Used by the live-API run (PNT-036), where nothing server-side can be inspected.
 */
export class BrowserCommandLog implements CommandLog {
  readonly calls: LoggedCall[] = [];
  private readonly delays: Array<{ pattern: RoutePattern; ms: number; times: number }> = [];
  private readonly byRequest = new WeakMap<Request, LoggedCall>();

  static async attach(page: Page): Promise<BrowserCommandLog> {
    const log = new BrowserCommandLog();
    page.on('response', async (response) => {
      const call = log.byRequest.get(response.request());
      if (!call) return;
      const json = (await response.json().catch(() => null)) as {
        meta?: { request_id?: string };
        error?: { request_id?: string };
      } | null;
      call.requestId = json?.meta?.request_id ?? json?.error?.request_id ?? null;
      call.status = response.status();
    });
    page.on('requestfailed', (request) => {
      const call = log.byRequest.get(request);
      if (call) call.status = -1;
    });
    await page.route(
      (url) => url.pathname.startsWith('/v1/'),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const raw = request.postData();
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        const call: LoggedCall = {
          method: request.method(),
          path: url.pathname,
          route: `${request.method()} ${url.pathname}`,
          headers: await request.allHeaders(),
          body,
          status: 0,
        };
        log.calls.push(call);
        log.byRequest.set(request, call);
        const i = log.delays.findIndex((d) => d.times > 0 && matchRoute(d.pattern, call.method, call.path));
        if (i >= 0) {
          const d = log.delays[i] as (typeof log.delays)[number];
          d.times -= 1;
          if (d.times <= 0) log.delays.splice(i, 1);
          await sleep(d.ms);
        }
        await route.continue();
      },
    );
    return log;
  }

  callsTo(spec: string): LoggedCall[] {
    const pattern = compile(spec);
    return this.calls.filter((c) => matchRoute(pattern, c.method, c.path));
  }

  delayNext(spec: string, ms: number, times = 1): this {
    this.delays.push({ pattern: compile(spec), ms, times });
    return this;
  }
}
