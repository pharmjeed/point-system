/**
 * C-21 «الشكاوى» and C-22 «شكوى جديدة» (V2-037; docs/v2/01; DEC-603, DEC-604; annex clauses 5 and 6): a complaint
 * registered from the app gets its reference number at once (`PT-C-000123`); the customer follows its status and the
 * platform's note. A complaint may name one of the account's visits or subscriptions.
 */
import { z } from 'zod';
import { COMPLAINT_LIMITS, ComplaintCategorySchema, ComplaintStatusSchema } from '../canon/complaints.js';

const iso = z.iso.datetime({ offset: true });

/** `POST /v1/customer/complaints` (Idempotency-Key). A body with a card-like run of 13 digits is refused. */
export const CustomerComplaintCreateBodySchema = z
  .strictObject({
    category: ComplaintCategorySchema,
    body: z.string().trim().min(COMPLAINT_LIMITS.body_min).max(COMPLAINT_LIMITS.body_max),
    ticket_id: z.uuid().nullish(),
    subscription_id: z.uuid().nullish(),
  })
  .refine((b) => !/[0-9]{13,}/.test(b.body.replace(/[\s-]/g, '')), {
    message: 'no card number in a complaint',
    path: ['body'],
  });
export type CustomerComplaintCreateBody = z.infer<typeof CustomerComplaintCreateBodySchema>;

export const CustomerComplaintSchema = z.object({
  complaint_id: z.uuid(),
  /** `PT-C-000123` */
  reference: z.string(),
  category: ComplaintCategorySchema,
  status: ComplaintStatusSchema,
  body: z.string(),
  ticket_id: z.uuid().nullable(),
  subscription_id: z.uuid().nullable(),
  venue_name_ar: z.string().nullable(),
  venue_name_en: z.string().nullable(),
  /** the platform's last note to the customer */
  resolution_note: z.string().nullable(),
  created_at: iso,
  updated_at: iso,
});
export type CustomerComplaint = z.infer<typeof CustomerComplaintSchema>;

export const CustomerComplaintListSchema = z.object({ items: z.array(CustomerComplaintSchema) });
export type CustomerComplaintList = z.infer<typeof CustomerComplaintListSchema>;
