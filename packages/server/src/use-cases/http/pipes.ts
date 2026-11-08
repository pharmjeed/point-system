import { Injectable, ParseUUIDPipe, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../../core/errors/app-error.js';
import { zodToFields } from '../../http/zod-pipe.js';

/**
 * Like zodBody, but a missing, blank or shorter-than-3 `reason` is REASON_REQUIRED with the 08 details
 * (`field: "reason"`, `min_length: 3`) instead of VALIDATION_FAILED.
 */
@Injectable()
export class ReasonBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.reason !== 'string' || v.reason.trim().length < 3)
      throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: 3 });
    const r = this.schema.safeParse(v);
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

export const reasonBody = <T>(schema: ZodType<T>) => new ReasonBodyPipe(schema);

/** Path ids that are not UUIDs are reported with the resource's own not-found code. */
export const ticketIdParam = new ParseUUIDPipe({ exceptionFactory: () => new AppError('TICKET_NOT_FOUND') });
export const taskIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'task' }),
});
export const offerIdParam = new ParseUUIDPipe({ exceptionFactory: () => new AppError('OFFER_NOT_FOUND') });
export const cycleIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'retrieval_cycle' }),
});
export const sessionIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'duty_session' }),
});
export const driverIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'driver' }),
});
export const transferIdParam = new ParseUUIDPipe({
  exceptionFactory: () => new AppError('RESOURCE_NOT_FOUND', { resource: 'driver_transfer' }),
});
