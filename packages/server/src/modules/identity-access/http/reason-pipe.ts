import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../../../core/errors/app-error.js';
import { zodToFields } from '../../../http/zod-pipe.js';

/** Like zodBody, but a missing/blank `reason` is REASON_REQUIRED (08 §4.16) instead of VALIDATION_FAILED. */
@Injectable()
export class ReasonBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.reason !== 'string' || v.reason.trim().length === 0) throw new AppError('REASON_REQUIRED');
    const r = this.schema.safeParse(v);
    if (!r.success) {
      if (r.error.issues.some((i) => i.path[0] === 'reason')) throw new AppError('REASON_REQUIRED');
      throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    }
    return r.data;
  }
}

export const reasonBody = <T>(schema: ZodType<T>) => new ReasonBodyPipe(schema);
