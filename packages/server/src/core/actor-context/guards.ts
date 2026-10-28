import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROUTES, type Permission } from '@point/shared';
import type { Request } from 'express';
import type { Clock } from '../clock/clock.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/database.js';
import { AppError } from '../errors/app-error.js';
import { PERMISSION_KEY, PUBLIC_KEY } from '../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../http/tokens.js';
import { hasPermission, type ActorContext } from './actor-context.js';
import { loadActor, touchSession } from './actor-loader.js';

type Req = Request & { actor?: ActorContext };

/** The auth.self routes a restricted session may still use (08 §4.1 `allowed_paths`). */
export const AUTH_SELF_PATHS = ROUTES.filter((r) => r.permission === 'auth.self').map(
  (r) => `${r.method} ${r.path}`,
);

/**
 * SessionAuthGuard + PermissionGuard (09 §8.1). Public routes skip both. For every other route: session →
 * restricted-session limits (AUTH_SECRET_CHANGE_REQUIRED first, then AUTH_MFA_SETUP_REQUIRED, except for
 * auth.self routes) → role permission. Resource scope and duty are checked by the handlers' policies.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookieName: string;
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) env: Env,
  ) {
    this.cookieName = env.SESSION_COOKIE_NAME;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, targets);
    if (!permission)
      throw new Error(
        `route without @RequirePermission or @Public: ${ctx.getClass().name}.${ctx.getHandler().name}`,
      );
    const req = ctx.switchToHttp().getRequest<Req>();
    const now = this.clock.now();
    const actor = await loadActor(this.db, req.cookies?.[this.cookieName], now);
    req.actor = actor;
    if (permission !== 'auth.self') {
      if (actor.mustChangeSecret)
        throw new AppError('AUTH_SECRET_CHANGE_REQUIRED', {
          secret_kind: actor.secretKind,
          allowed_paths: AUTH_SELF_PATHS,
        });
      if (actor.mfaSetupRequired)
        throw new AppError('AUTH_MFA_SETUP_REQUIRED', { allowed_paths: AUTH_SELF_PATHS });
    }
    if (!hasPermission(actor, permission)) throw new AppError('PERMISSION_DENIED', { permission });
    void touchSession(this.db, actor.sessionId, now).catch(() => {});
    return true;
  }
}
