import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { RateLimitClass } from '@point/shared';
import type { Request, Response } from 'express';
import type { Clock } from '../core/clock/clock.js';
import type { Env } from '../core/config/env.js';
import { AppError } from '../core/errors/app-error.js';
import {
  clientAddressKey,
  extraRateRules,
  rateLimitClassOf,
  rateLimitRules,
  type RateRule,
} from '../core/rate-limit/policy.js';
import { TokenBucketLimiter, type RateDecision } from '../core/rate-limit/token-bucket.js';
import { CLOCK, ENV } from './tokens.js';

type Req = Request & {
  actor?: { userId: string; sessionId: string };
  /** user/device rules left for UserRateLimitGuard once the session is known */
  rateLimitPending?: RateRule[];
};

/**
 * 07 §1.9 rate limits (PNT-096, 09 §8.1 step 1): every route has a class (ROUTES.rateLimitClass =
 * `x-rate-limit-class`). Buckets are kept per process (TokenBucketLimiter). Exceeding a limit answers
 * `429 RATE_LIMITED` with `Retry-After` and `details.retry_after_s`; `RateLimit-Limit`, `RateLimit-Remaining`
 * and `RateLimit-Reset` are sent on every limited route.
 */
@Injectable()
export class RateLimiter {
  readonly enabled: boolean;
  readonly store = new TokenBucketLimiter();
  private readonly rules: Readonly<Record<RateLimitClass, RateRule | null>>;
  private readonly extra: Readonly<Record<string, RateRule>>;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.enabled = env.RATE_LIMIT_ENABLED ?? env.NODE_ENV !== 'test';
    this.rules = rateLimitRules(env);
    this.extra = extraRateRules(env);
  }

  /** The rules of the matched route (class first, then the extra rules of 07 §1.9). */
  rulesFor(req: Request): RateRule[] {
    const path = (req.route as { path?: string } | undefined)?.path;
    if (typeof path !== 'string') return [];
    const cls = rateLimitClassOf(req.method, path);
    const out: RateRule[] = [];
    const base = this.rules[cls];
    if (base) out.push(base);
    const extra = this.extra[`${req.method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`];
    if (extra) out.push(extra);
    return out;
  }

  /** Consumes one token from every rule (in order); the first exhausted bucket answers 429. */
  consume(rules: readonly RateRule[], subjectKey: (r: RateRule) => string, res: Response): void {
    if (rules.length === 0) return;
    const now = this.clock.now().getTime();
    let shown: RateDecision | null = null;
    for (const r of rules) {
      const d = this.store.take(`${r.name}:${subjectKey(r)}`, r.limit, r.windowMs, now);
      if (!shown || d.remaining < shown.remaining || !d.allowed) shown = d;
      if (!d.allowed) {
        setHeaders(res, d);
        throw new AppError('RATE_LIMITED', { retry_after_s: d.retryAfterS }, { retryAfterS: d.retryAfterS });
      }
    }
    if (shown) setHeaders(res, shown);
  }
}

function setHeaders(res: Response, d: RateDecision): void {
  res.setHeader('RateLimit-Limit', String(d.limit));
  res.setHeader('RateLimit-Remaining', String(d.remaining));
  res.setHeader('RateLimit-Reset', String(d.resetS));
}

/**
 * First guard (before CSRF and the session, 08 §2 step 1): IP-keyed classes (`auth`, `webhook`) and, for a
 * request without a session cookie, every class by IP («حسب IP قبل الدخول», 09 §8.1). A request with a
 * session cookie keeps its user/device rules for UserRateLimitGuard.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly cookieName: string;
  constructor(
    private readonly limiter: RateLimiter,
    @Inject(ENV) env: Env,
  ) {
    this.cookieName = env.SESSION_COOKIE_NAME;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.limiter.enabled) return true;
    const req = ctx.switchToHttp().getRequest<Req>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const rules = this.limiter.rulesFor(req);
    const hasSession = typeof req.cookies?.[this.cookieName] === 'string';
    const now = rules.filter((r) => r.subject === 'ip' || !hasSession);
    req.rateLimitPending = hasSession ? rules.filter((r) => r.subject !== 'ip') : [];
    const ip = clientAddressKey(req.ip);
    this.limiter.consume(now, () => `ip:${ip}`, res);
    return true;
  }
}

/** After the session guard: the user (or device = session) buckets of the route (09 §8.1 «حسب المستخدم بعده»). */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiter) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Req>();
    const pending = req.rateLimitPending ?? [];
    if (!this.limiter.enabled || pending.length === 0 || !req.actor) return true;
    const actor = req.actor;
    this.limiter.consume(
      pending,
      (r) => (r.subject === 'device' ? `session:${actor.sessionId}` : `user:${actor.userId}`),
      ctx.switchToHttp().getResponse<Response>(),
    );
    return true;
  }
}
