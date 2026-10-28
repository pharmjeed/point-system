import { CustodyHolderTypeSchema, CustodySubjectSchema } from '@point/shared';
import { z } from 'zod';

/**
 * Request bodies of the S6 supervisor commands (07_openapi.yaml), strict: unknown fields are VALIDATION_FAILED.
 * `reason` is checked first by the ReasonBodyPipe (REASON_REQUIRED below 3 characters, 08).
 */
const uuid = z.uuid();
const reason = z.string().max(500);

export const InspectionExceptionBody = z.strictObject({ reason });

export const CustodyTransferBody = z.strictObject({
  subject: CustodySubjectSchema,
  to_holder_type: CustodyHolderTypeSchema,
  to_holder_id: uuid.nullable().optional(),
  reason,
});

export const RevealPhoneBody = z.strictObject({ reason });

export const PaymentInputAttributed = z.strictObject({
  method: z.enum(['cash', 'pos']),
  amount_halalas: z.number().int().min(0),
  pos_reference: z.string().max(40).nullable().optional(),
  collected_by: uuid,
});

export const ManualReconcileBody = z.strictObject({
  target_status: z.enum(['parked', 'delivered', 'voided']),
  reason,
  evidence: z.strictObject({
    paper_log_ref: z.string().trim().min(1).max(60),
    note: z.string().max(500).optional(),
  }),
  parking_spot_id: uuid.nullable().optional(),
  spot_note: z.string().max(120).nullable().optional(),
  key_slot_id: uuid.nullable().optional(),
  incident_id: uuid.nullable().optional(),
  payment: PaymentInputAttributed.nullable().optional(),
  expected_version: z.number().int().min(1).optional(),
});
