import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';
import { AppError } from '../core/errors/app-error.js';

export interface FieldError {
  field: string;
  issue: string;
  message?: string;
}

export function zodToFields(e: ZodError): FieldError[] {
  return e.issues.map((i) => ({ field: i.path.join('.') || '(body)', issue: i.code, message: i.message }));
}

/** Validates a body/query with a shared zod schema; unknown fields rejected by the schemas (strict). */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
    return r.data;
  }
}

export const zodBody = <T>(schema: ZodType<T>) => new ZodPipe(schema);
