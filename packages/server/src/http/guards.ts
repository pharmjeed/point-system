import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { isCustomerPath } from '@point/shared/customer';
import type { Request } from 'express';
import type { Env } from '../core/config/env.js';
import { AppError } from '../core/errors/app-error.js';
import { ENV } from './tokens.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF (DEC-29, 09 §8.1): every unsafe method except the WhatsApp webhook — including login — needs
 * `X-Requested-With: point-web` and an Origin equal to APP_BASE_URL; otherwise PERMISSION_DENIED (reason csrf).
 *
 * V2-010 (DEC-497): the customer API `/v1/customer/*` is exempt. It is called by the native app (no browser
 * Origin), it never sets or reads a cookie, and its only credential is the `Authorization: Bearer` header, which a
 * browser never attaches on its own to a cross-site request — CSRF needs an ambient credential, there is none.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly origin: string;
  constructor(@Inject(ENV) env: Env) {
    this.origin = new URL(env.APP_BASE_URL).origin;
  }
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!UNSAFE.has(req.method)) return true;
    if (req.path.startsWith('/webhooks/')) return true;
    if (isCustomerPath(req.path)) return true;
    const xrw = req.header('X-Requested-With');
    const origin = req.header('Origin');
    if (xrw !== 'point-web' || !origin || origin !== this.origin) {
      throw new AppError('PERMISSION_DENIED', { reason: 'csrf' });
    }
    return true;
  }
}
