import { Injectable, ParseUUIDPipe, type PipeTransform } from '@nestjs/common';
import { EXPORT_KINDS, PAYMENT_METHODS, WA_MESSAGE_STATUSES } from '@point/shared';
import { z, type ZodType } from 'zod';
import { AppError } from '../../../core/errors/app-error.js';
import { zodToFields } from '../../../http/zod-pipe.js';
import { posReferenceIssues, type PaymentInput } from '../domain/payment-rules.js';

/**
 * Bodies and queries of the payments-reports routes (07_openapi.yaml), strict: an unknown key is
 * VALIDATION_FAILED. The `pos_reference` rules of 13 §5.6 are input-shape rules (08 §2 step 6) and run in the
 * pipe, before the resource is loaded.
 */
const uuid = z.uuid();
const dateTime = z.iso.datetime({ offset: true });

export const PaymentInputSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  amount_halalas: z.number().int().min(0),
  pos_reference: z.string().max(40).nullable().optional(),
});

export const WaiverBodySchema = z.strictObject({ reason: z.string().max(500) });

export const ReverseBodySchema = z.strictObject({
  reason: z.string().max(500),
  replacement: PaymentInputSchema.nullable().optional(),
});

export const CashHandoverBodySchema = z.strictObject({
  event_id: uuid,
  driver_id: uuid,
  amount_halalas: z.number().int().min(0),
  note: z.string().max(300).nullable().optional(),
});

export const DriversReportQuery = z.strictObject({
  venue_id: uuid.optional(),
  from: dateTime,
  to: dateTime,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

export const PaymentsReportQuery = z.strictObject({
  venue_id: uuid.optional(),
  from: dateTime,
  to: dateTime,
  event_id: uuid.optional(),
});

export const MessagesReportQuery = z.strictObject({
  venue_id: uuid.optional(),
  from: dateTime,
  to: dateTime,
  status: z.enum(WA_MESSAGE_STATUSES).optional(),
});

export const ExportBodySchema = z.strictObject({
  kind: z.enum(EXPORT_KINDS),
  filters: z.strictObject({
    venue_id: uuid.optional(),
    event_id: uuid.optional(),
    from: dateTime.optional(),
    to: dateTime.optional(),
  }),
});

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: zodToFields(r.error) });
  return r.data;
}

/** A reason of at least 3 characters after trimming, else REASON_REQUIRED (08 §4.3, §4.16). */
function requireReason(value: unknown): void {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.reason !== 'string' || v.reason.trim().length < 3)
    throw new AppError('REASON_REQUIRED', { field: 'reason', min_length: 3 });
}

function assertReference(input: PaymentInput | null | undefined, prefix: string): void {
  if (!input) return;
  const issues = posReferenceIssues(input, prefix);
  if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { fields: issues });
}

@Injectable()
export class PaymentInputPipe implements PipeTransform<unknown, PaymentInput> {
  transform(value: unknown): PaymentInput {
    const body = parse(PaymentInputSchema, value);
    assertReference(body, '');
    return body;
  }
}

@Injectable()
export class WaiverBodyPipe implements PipeTransform<unknown, z.infer<typeof WaiverBodySchema>> {
  transform(value: unknown) {
    requireReason(value);
    return parse(WaiverBodySchema, value);
  }
}

@Injectable()
export class ReverseBodyPipe implements PipeTransform<unknown, z.infer<typeof ReverseBodySchema>> {
  transform(value: unknown) {
    requireReason(value);
    const body = parse(ReverseBodySchema, value);
    assertReference(body.replacement, 'replacement.');
    return body;
  }
}

/** Any other body or query of this module. */
@Injectable()
export class InputPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    return parse(this.schema, value);
  }
}
export const input = <T>(schema: ZodType<T>) => new InputPipe<T>(schema);

/** A ticket id that is not a UUID is simply an unknown ticket (08 §1.3 rule 4). */
export const ticketIdParam = new ParseUUIDPipe({ exceptionFactory: () => new AppError('TICKET_NOT_FOUND') });
