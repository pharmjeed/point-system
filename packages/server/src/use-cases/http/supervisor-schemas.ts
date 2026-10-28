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
