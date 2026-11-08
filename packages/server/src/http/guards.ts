import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Env } from '../core/config/env.js';
import { AppError } from '../core/errors/app-error.js';
import { ENV } from './tokens.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF (DEC-29, 09 §8.1): every unsafe method except the WhatsApp webhook — including login — needs
 * `X-Requested-With: point-web` and an Origin equal to APP_BASE_URL; otherwise PERMISSION_DENIED (reason csrf).
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
    const xrw = req.header('X-Requested-With');
    const origin = req.header('Origin');
    if (xrw !== 'point-web' || !origin || origin !== this.origin) {
      throw new AppError('PERMISSION_DENIED', { reason: 'csrf' });
    }
    return true;
  }
}
