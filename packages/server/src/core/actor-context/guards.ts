import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PLATFORM_SELF_PATHS,
  ROUTES,
  hasPlatformPermission,
  type Permission,
  type PlatformPermission,
} from '@point/shared';
import type { Request } from 'express';
import type { Clock } from '../clock/clock.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/database.js';
import { AppError } from '../errors/app-error.js';
import { CUSTOMER_KEY, PERMISSION_KEY, PLATFORM_PERMISSION_KEY, PUBLIC_KEY } from '../../http/decorators.js';
import { CLOCK, DATABASE, ENV } from '../../http/tokens.js';
import { hasPermission, type ActorContext } from './actor-context.js';
import { loadActor, touchSession } from './actor-loader.js';
import { loadCustomerActor, touchCustomerSession, type CustomerActorContext } from './customer-actor.js';
import { loadPlatformActor, touchPlatformSession, type PlatformActorContext } from './platform-actor.js';

type Req = Request & {
  actor?: ActorContext;
  platformActor?: PlatformActorContext;
  customerActor?: CustomerActorContext;
};

/** The auth.self routes a restricted session may still use (08 §4.1 `allowed_paths`). */
export const AUTH_SELF_PATHS = ROUTES.filter((r) => r.permission === 'auth.self').map(
  (r) => `${r.method} ${r.path}`,
);

/**
 * SessionAuthGuard + PermissionGuard (09 §8.1). Public routes skip both. For every other route: session →
 * restricted-session limits (AUTH_SECRET_CHANGE_REQUIRED first, then AUTH_MFA_SETUP_REQUIRED, except for
 * auth.self routes) → role permission. Resource scope and duty are checked by the handlers' policies.
 *
 * V2 (DEC-462): a @RequirePlatformPermission route reads the platform cookie only and checks the platform matrix;
 * a staff route reads the staff cookie only. Neither session can authorize the other kind of route.
 *
 * V2-010 (DEC-497): a @RequireCustomer route reads the customer Bearer access token only (no cookie at all), and the
 * staff and platform paths never read the Authorization header: a customer token opens no staff or platform route,
 * and a staff or platform session opens no customer route.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookieName: string;
  private readonly platformCookieName: string;
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) env: Env,
  ) {
    this.cookieName = env.SESSION_COOKIE_NAME;
    this.platformCookieName = env.PLATFORM_SESSION_COOKIE_NAME;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const platform = this.reflector.getAllAndOverride<PlatformPermission | undefined>(
      PLATFORM_PERMISSION_KEY,
      targets,
    );
    if (platform) return this.platform(ctx, platform);
    if (this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, targets)) return this.customer(ctx);
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

  /** Customer access token → session → account (loadCustomerActor). */
  private async customer(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const now = this.clock.now();
    const actor = await loadCustomerActor(this.db, req.headers.authorization, now);
    req.customerActor = actor;
    void touchCustomerSession(this.db, actor.sessionId, now).catch(() => {});
    return true;
  }

  /**
   * Platform session → restricted limits (AUTH_SECRET_CHANGE_REQUIRED, then AUTH_MFA_SETUP_REQUIRED: MFA is always
   * required, so a session that has not passed TOTP reaches `platform.self` routes only) → platform role matrix.
   */
  private async platform(ctx: ExecutionContext, permission: PlatformPermission): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const now = this.clock.now();
    const actor = await loadPlatformActor(this.db, req.cookies?.[this.platformCookieName], now);
    req.platformActor = actor;
    if (permission !== 'platform.self') {
      if (actor.mustChangeSecret)
        throw new AppError('AUTH_SECRET_CHANGE_REQUIRED', {
          secret_kind: 'password',
          allowed_paths: PLATFORM_SELF_PATHS,
        });
      if (!actor.mfaVerified)
        throw new AppError('AUTH_MFA_SETUP_REQUIRED', { allowed_paths: PLATFORM_SELF_PATHS });
    }
    if (!hasPlatformPermission(actor.role, permission))
      throw new AppError('PERMISSION_DENIED', { permission });
    void touchPlatformSession(this.db, actor.sessionId, now).catch(() => {});
    return true;
  }
}
