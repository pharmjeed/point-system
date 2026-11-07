import { isIP } from 'node:net';
import { Injectable, createParamDecorator, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../../../core/errors/app-error.js';
import { COMMAND_KEY, type CommandMeta as CommandRouteMeta } from '../../../http/decorators.js';
import { zodToFields } from '../../../http/zod-pipe.js';
import type { ProfileCommandMeta } from '../application/operator-profile.service.js';

/** The command's route key, request id, client IP (null when not a valid address) and user agent (09 §11). */
export const ProfileCommand = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ProfileCommandMeta => {
    const req = ctx.switchToHttp().getRequest();
    const route = Reflect.getMetadata(COMMAND_KEY, ctx.getHandler()) as CommandRouteMeta | undefined;
    const ua = req.headers?.['user-agent'];
    return {
      operation: route?.operation ?? `${req.method} ${req.route?.path ?? req.path}`,
      requestId: req.requestId,
      ip: typeof req.ip === 'string' && isIP(req.ip) ? req.ip : null,
      userAgent: typeof ua === 'string' ? ua : null,
    };
  },
);

/**
 * Body/query validation with the shared zod schemas: VALIDATION_FAILED with `details.fields`; with `reason: true` a
 * missing, blank or too short `reason` is REASON_REQUIRED (`field`, `min_length`, 08 §4.3) first.
 */
@Injectable()
class InputPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly reason: boolean,
  ) {}
  transform(value: unknown): T {
    const v = (value ?? {}) as Record<string, unknown>;
    if (this.reason && (typeof v.reason !== 'string' || v.reason.trim().length < 3))
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: 3 });
    const r = this.schema.safeParse(v);
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

export const input = <T>(schema: ZodType<T>) => new InputPipe<T>(schema, false);
export const reasoned = <T>(schema: ZodType<T>) => new InputPipe<T>(schema, true);
