import { isIP } from 'node:net';
import { Injectable, createParamDecorator, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../../../core/errors/app-error.js';
import { COMMAND_KEY, type CommandMeta as CommandRouteMeta } from '../../../http/decorators.js';
import type { CommandMeta } from '../application/support.js';
import { zodIssuesToFields } from '../domain/settings.js';

/**
 * Validation pipe of this module: the shared zod schemas, VALIDATION_FAILED with `details.fields` carrying the
 * full dotted path of every invalid field — an unknown key is reported at its own path (`settings.dispatch.foo`),
 * not on its parent (PNT-018 AC2).
 */
@Injectable()
class InputPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodIssuesToFields(r.error) });
    return r.data;
  }
}

export const input = <T>(schema: ZodType<T>) => new InputPipe<T>(schema);

/**
 * The command's route key (from `@Command`), request id, client IP and user agent for the audit row (09 §11).
 * An IP that is not a valid address (e.g. a forged X-Forwarded-For) is recorded as null instead of failing the
 * `inet` column.
 */
export const CommandContext = createParamDecorator((_: unknown, ctx: ExecutionContext): CommandMeta => {
  const req = ctx.switchToHttp().getRequest();
  const route = Reflect.getMetadata(COMMAND_KEY, ctx.getHandler()) as CommandRouteMeta | undefined;
  const ua = req.headers?.['user-agent'];
  return {
    operation: route?.operation ?? `${req.method} ${req.route?.path ?? req.path}`,
    requestId: req.requestId,
    ip: typeof req.ip === 'string' && isIP(req.ip) ? req.ip : null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
});
