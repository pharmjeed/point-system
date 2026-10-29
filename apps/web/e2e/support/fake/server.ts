/**
 * A small stateful fake of the POINT API for Playwright (the backend is not part of the web e2e run).
 * It keeps one in-memory world seeded from packages/db/src/seed, answers `/v1/*` for every page attached
 * to it (each page = one signed-in session), and enforces the contract rules the UI relies on: session,
 * CSRF header, role permissions from @point/shared (canon §10), venue scope, `Idempotency-Key` on every
 * required command (with replay and IDEMPOTENCY_KEY_REUSED), `expected_version`, and the business errors
 * of 07/08 with their 08 texts. Tests can inject faults or latency per route and read every call.
 *
 * A real-API mode (PNT-036) replaces `attach()` by the session cookie of a real login; see ../backend.ts.
 */
import type { Page, Route } from '@playwright/test';
import { DRIVE_PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../packages/shared/src/canon/permissions';
import {
  compile,
  errorReply,
  fail,
  HttpError,
  matchRoute,
  nowIso,
  stable,
  uuid,
  type Reply,
  type RoutePattern,
} from './http';
import type { FUser, World } from './model';
import { FakeRealtime, type LiveView } from './realtime';
import { seedWorld, type SeedOptions, type SeedUserKey } from './seed';

export interface Session {
  userId: string | null;
  /** The `devices` row this sign-in linked (09 §9.5), exposed as `Me.session.device_id` (proposed). */
  deviceId: string | null;
}

export interface FDevice {
  id: string;
  user_id: string;
  platform: 'ios' | 'android' | 'desktop' | 'other';
  display_mode: 'browser' | 'standalone';
  notification_permission: 'default' | 'granted' | 'denied' | 'unsupported';
  audio_test_result: 'heard' | 'not_heard' | 'blocked' | null;
  audio_tested_at: string | null;
  created_at: string;
}

export interface Ctx {
  method: string;
  path: string;
  /** `http://localhost:5317` — for absolute URLs in replies (presigned uploads). */
  origin: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  rawBody: Buffer | null;
  headers: Record<string, string>;
  session: Session;
  user: FUser | null;
}

export type Handler = (ctx: Ctx) => Reply;

export interface FakeCall {
  method: string;
  path: string;
  /** The route spec that answered ("POST /v1/tickets/:ticketId/handover"), or null. */
  route: string | null;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  at: number;
}

type Idempotency = 'required' | 'optional' | 'none';

interface RouteDef {
  pattern: RoutePattern;
  handler: Handler;
  idem: Idempotency;
  public: boolean;
}

/** Commands without `x-idempotency: required` (07: auth, devices, audio test, heartbeat). */
const NOT_REQUIRED = [
  /^\/v1\/auth\//,
  /^\/v1\/me\/devices/,
  /^\/v1\/me\/audio-test$/,
  /^\/v1\/me\/heartbeat$/,
];

export const STORAGE_PREFIX = '/__e2e_storage/';

export class FakeServer {
  world: World;
  readonly calls: FakeCall[] = [];
  private readonly routes: RouteDef[] = [];
  private readonly idem = new Map<string, { fingerprint: string; reply: Reply }>();
  private readonly faults: Array<{ pattern: RoutePattern; reply: Reply | 'abort'; times: number }> = [];
  private readonly delays: Array<{ pattern: RoutePattern; ms: number; times: number }> = [];
  /** Uploaded objects by media id (the fake private object storage). */
  readonly storage = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly devices = new Map<string, FDevice>();
  /** `/ws` (off until a spec enables it): Socket.IO frames over `page.routeWebSocket` (PNT-065). */
  readonly realtime = new FakeRealtime(this);
  /** What a driver sees live (set by the driver routes; read by the realtime hub). */
  liveView?: (userId: string) => LiveView;
  /** The TaskCard of a task for a viewer (set by the driver routes). */
  taskCardOf?: (taskId: string, viewerId: string) => (LiveView['tasks'][number] & object) | null;

  constructor(options: SeedOptions = {}) {
    this.world = seedWorld(options);
  }

  /** Every sign-in links a device row (09 §9.5). */
  newDevice(userId: string): string {
    const id = uuid();
    this.devices.set(id, {
      id,
      user_id: userId,
      platform: 'android',
      display_mode: 'browser',
      notification_permission: 'default',
      audio_test_result: null,
      audio_tested_at: null,
      created_at: nowIso(),
    });
    return id;
  }

  // ---------------------------------------------------------------- wiring

  /** Registers a route; unsafe methods require an Idempotency-Key unless 07 says otherwise. */
  on(spec: string, handler: Handler, opts: { idem?: Idempotency; public?: boolean } = {}): this {
    const pattern = compile(spec);
    const unsafe = pattern.method !== 'GET';
    const path = spec.split(' ')[1] ?? '';
    const idem = opts.idem ?? (unsafe && !NOT_REQUIRED.some((r) => r.test(path)) ? 'required' : 'none');
    this.routes.push({ pattern, handler, idem, public: !!opts.public });
    return this;
  }

  /** Answers the next `times` matching requests with `reply` (or a dropped connection). */
  failNext(spec: string, reply: Reply | 'abort', times = 1): this {
    this.faults.push({ pattern: compile(spec), reply, times });
    return this;
  }

  /** Delays the next `times` matching requests (to observe pending buttons). */
  delayNext(spec: string, ms: number, times = 1): this {
    this.delays.push({ pattern: compile(spec), ms, times });
    return this;
  }

  callsTo(spec: string): FakeCall[] {
    return this.calls.filter((c) => c.route === spec);
  }

  /** Attaches a page: its `/v1/*` requests are answered here, as its own session (optionally signed in). */
  async attach(page: Page, as?: SeedUserKey): Promise<Session> {
    const session: Session = { userId: null, deviceId: null };
    if (as) this.signIn(session, as);
    await page.route(
      (url) => url.pathname.startsWith('/v1/') || url.pathname.startsWith(STORAGE_PREFIX),
      (route) => this.serve(route, session),
    );
    await this.realtime.attach(page, session);
    return session;
  }

  signIn(session: Session, key: SeedUserKey): void {
    const user = this.userByKey(key);
    session.userId = user.id;
    session.deviceId = this.newDevice(user.id);
  }

  /**
   * Runs a route as a seeded user without a browser (test set-up and the «other actor» of a scenario: a
   * supervisor's request on behalf, a second driver). Same handlers and rules as the UI's calls, with a
   * fresh Idempotency-Key; not recorded in `calls`. Throws on an error reply.
   */
  exec<T = any>(as: SeedUserKey, spec: string, params: Record<string, string> = {}, body?: unknown): T {
    const def = this.routes.find((r) => r.pattern.spec === spec);
    if (!def) throw new Error(`fake exec: no route ${spec}`);
    const user = this.userByKey(as);
    const path = (spec.split(' ')[1] ?? '').replace(/:([A-Za-z]+)/g, (_, k: string) =>
      encodeURIComponent(params[k] ?? ''),
    );
    const reply = this.dispatch(def, {
      method: def.pattern.method,
      path,
      origin: 'http://localhost',
      query: new URLSearchParams(),
      body,
      rawBody: null,
      headers: { 'x-requested-with': 'point-web', 'idempotency-key': uuid() },
      session: { userId: user.id, deviceId: null },
    });
    this.realtime.afterChange();
    if (reply.status >= 400)
      throw new Error(`fake exec ${spec} → ${reply.status} ${JSON.stringify(reply.body)}`);
    return (reply.body as { data?: T } | undefined)?.data as T;
  }

  userByKey(key: SeedUserKey): FUser {
    const u = this.world.users.find((x) => x.key === key);
    if (!u) throw new Error(`fake: no seeded user ${key}`);
    return u;
  }

  private take<T extends { pattern: RoutePattern; times: number }>(list: T[], method: string, path: string) {
    const i = list.findIndex((f) => f.times > 0 && matchRoute(f.pattern, method, path));
    if (i < 0) return null;
    const hit = list[i] as T;
    hit.times -= 1;
    if (hit.times <= 0) list.splice(i, 1);
    return hit;
  }

  private async serve(route: Route, session: Session): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const headers = await req.allHeaders();
    const rawBody = req.postDataBuffer();
    let body: unknown;
    if (rawBody && !url.pathname.startsWith(STORAGE_PREFIX)) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = rawBody.toString('utf8');
      }
    }
    const delay = this.take(this.delays, method, url.pathname);
    if (delay) await new Promise((r) => setTimeout(r, delay.ms));
    const fault = this.take(this.faults, method, url.pathname);
    const def = this.routes.find((r) => matchRoute(r.pattern, method, url.pathname));
    const call: FakeCall = {
      method,
      path: url.pathname,
      route: def?.pattern.spec ?? null,
      headers,
      body,
      status: 0,
      at: Date.now(),
    };
    this.calls.push(call);
    if (fault?.reply === 'abort') {
      call.status = -1;
      await route.abort('internetdisconnected');
      return;
    }
    const reply = fault
      ? fault.reply
      : this.dispatch(def, {
          method,
          path: url.pathname,
          origin: url.origin,
          query: url.searchParams,
          body,
          rawBody,
          headers,
          session,
        });
    call.status = reply.status;
    this.realtime.afterChange(); // what the API's planners publish at commit (before the HTTP reply)
    if (reply.raw) {
      await route.fulfill({
        status: reply.status,
        contentType: reply.contentType,
        headers: reply.headers,
        body: reply.raw,
      });
      return;
    }
    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      headers: reply.headers,
      body: reply.body === undefined ? '' : JSON.stringify(reply.body),
    });
  }

  private dispatch(def: RouteDef | undefined, input: Omit<Ctx, 'params' | 'user'>): Reply {
    if (!def) return { status: 501, body: { error: { code: 'NOT_MOCKED', message: input.path } } };
    const params = matchRoute(def.pattern, input.method, input.path) ?? {};
    const user = input.session.userId
      ? (this.world.users.find((u) => u.id === input.session.userId) ?? null)
      : null;
    const ctx: Ctx = { ...input, params, user };
    try {
      if (input.method !== 'GET' && !input.path.startsWith(STORAGE_PREFIX)) {
        // 07 §1.3: every unsafe method carries the CSRF header, the login included
        if (input.headers['x-requested-with'] !== 'point-web') fail('PERMISSION_DENIED');
      }
      if (!def.public && !user) fail('AUTH_UNAUTHENTICATED');
      if (user && user.status === 'disabled' && !def.public)
        fail('AUTH_SESSION_REVOKED', { reason: 'disabled' });
      if (def.idem === 'none' || !user) return def.handler(ctx);
      const key = input.headers['idempotency-key'];
      if (!key) {
        if (def.idem === 'required') fail('IDEMPOTENCY_KEY_REQUIRED');
        return def.handler(ctx);
      }
      const store = `${user.id}|${key}`;
      const fingerprint = `${def.pattern.spec}|${stable(params)}|${stable(input.body ?? null)}`;
      const seen = this.idem.get(store);
      if (seen) {
        if (seen.fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
        const replayed = seen.reply.body as { meta?: Record<string, unknown> } | undefined;
        return {
          ...seen.reply,
          headers: { ...seen.reply.headers, 'Idempotent-Replayed': 'true' },
          body: replayed?.meta
            ? { ...replayed, meta: { ...replayed.meta, replayed: true } }
            : seen.reply.body,
        };
      }
      let reply: Reply;
      try {
        reply = def.handler(ctx);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        reply = e.reply;
      }
      if (reply.status < 500) this.idem.set(store, { fingerprint, reply });
      if (reply.status < 300)
        this.world.audit.push({ route: def.pattern.spec, actor_id: user.id, at: nowIso() });
      return reply;
    } catch (e) {
      if (e instanceof HttpError) return e.reply;
      return errorReply('INTERNAL_ERROR', { message: String(e) });
    }
  }

  // ---------------------------------------------------------------- access helpers (canon §10, 07 §1.10)

  permissionsOf(user: FUser): string[] {
    const base = [...ROLE_PERMISSIONS[user.role]];
    if (user.role === 'supervisor' && user.can_drive) base.push(...DRIVE_PERMISSIONS);
    return [...new Set(base)];
  }

  need(ctx: Ctx, permission: string): FUser {
    const user = ctx.user;
    if (!user) return fail('AUTH_UNAUTHENTICATED');
    if (user.must_change_secret) fail('AUTH_SECRET_CHANGE_REQUIRED');
    if (!this.permissionsOf(user).includes(permission)) fail('PERMISSION_DENIED');
    return user;
  }

  activeAssignment(userId: string) {
    return this.world.assignments.find((a) => a.driver_id === userId && a.status === 'active') ?? null;
  }

  venueIdsInScope(user: FUser): string[] {
    if (user.role === 'driver') {
      const a = this.activeAssignment(user.id);
      return a ? [a.venue_id] : [];
    }
    if (user.scopes.includes('org')) return this.world.venues.map((v) => v.id);
    return user.scopes.filter((s) => s !== 'org');
  }

  inScope(user: FUser, venueId: string): boolean {
    return this.venueIdsInScope(user).includes(venueId);
  }

  /** `{venueId}` chosen by the caller: unknown → 404, outside the scope → 403 SCOPE_VENUE_DENIED. */
  needVenue(ctx: Ctx, venueId: string) {
    const venue = this.world.venues.find((v) => v.id === venueId);
    if (!venue) fail('RESOURCE_NOT_FOUND');
    if (!ctx.user || !this.inScope(ctx.user, venueId)) fail('SCOPE_VENUE_DENIED');
    return venue;
  }

  /** A record found by id: unknown or in a venue outside the scope → 404 (non-disclosure, 08 §1.3). */
  needInScope<T extends { venue_id: string }>(
    ctx: Ctx,
    record: T | undefined,
    code: 'RESOURCE_NOT_FOUND' | 'TICKET_NOT_FOUND' = 'RESOURCE_NOT_FOUND',
  ): T {
    if (!record || !ctx.user || !this.inScope(ctx.user, record.venue_id)) fail(code);
    return record;
  }

  /** What a driver holds (08 `details.items`): vehicles, keys, open tasks, the reserved next task. */
  custodyItems(
    userId: string,
  ): Array<{ type: string; ticket_id: string; display_number: number; holder_type?: string }> {
    const items: Array<{ type: string; ticket_id: string; display_number: number; holder_type?: string }> =
      [];
    for (const t of this.world.tickets) {
      if (t.vehicle_holder.type === 'driver' && t.vehicle_holder.id === userId)
        items.push({
          type: 'vehicle',
          ticket_id: t.id,
          display_number: t.display_number,
          holder_type: 'driver',
        });
      if (t.key_holder.type === 'driver' && t.key_holder.id === userId)
        items.push({ type: 'key', ticket_id: t.id, display_number: t.display_number, holder_type: 'driver' });
    }
    for (const task of this.world.tasks) {
      if (task.assignee_id !== userId) continue;
      const ticket = this.world.tickets.find((t) => t.id === task.ticket_id);
      if (!ticket) continue;
      if (task.status === 'in_progress')
        items.push({ type: 'task', ticket_id: ticket.id, display_number: ticket.display_number });
      if (task.status === 'assigned_waiting')
        items.push({ type: 'next_task', ticket_id: ticket.id, display_number: ticket.display_number });
    }
    return items;
  }

  checkVersion(entity: string, record: { id: string; version: number }, expected: unknown): void {
    if (expected === undefined || expected === null) return;
    if (expected !== record.version)
      fail('VERSION_CONFLICT', { entity, id: record.id, current_version: record.version });
  }

  now(): string {
    return nowIso();
  }
}
