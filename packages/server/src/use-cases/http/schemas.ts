import { z } from 'zod';

/** Request bodies of the S2 slice (07_openapi.yaml), strict: unknown fields are VALIDATION_FAILED. */
const uuid = z.uuid();
const version = z.number().int().min(1);

export const DutyStartBody = z.strictObject({
  venue_id: uuid.nullable().optional(),
  device_id: uuid.nullable().optional(),
});
export const DutyBreakBody = z.strictObject({ active: z.boolean() });
export const EmptyBody = z.strictObject({});

export const StartIntakeBody = z.strictObject({
  event_id: uuid.nullable().optional(),
  channel: z.enum(['whatsapp', 'paper']).optional(),
});

const PlateInput = z.strictObject({
  country: z.string().trim().min(2).max(3).optional(),
  digits: z.string().max(8).optional(),
  letters_ar: z.string().max(16).optional(),
  letters_en: z.string().max(16).optional(),
  raw: z.string().max(20).optional(),
});
const VehicleInfo = z.strictObject({
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  color: z.string().max(40).nullable().optional(),
  type: z.enum(['sedan', 'suv', 'pickup', 'van', 'other']).nullable().optional(),
});
const DamageMark = z.strictObject({ area: z.string().min(1).max(40), note: z.string().max(200).optional() });

export const PatchIntakeBody = z.strictObject({
  expected_version: version,
  channel: z.enum(['whatsapp', 'paper']).optional(),
  plate: PlateInput.optional(),
  vehicle: VehicleInfo.optional(),
  customer_phone: z.string().max(32).nullable().optional(),
  consent: z
    .strictObject({ method: z.literal('verbal_staff_confirmed'), confirmed: z.literal(true) })
    .nullable()
    .optional(),
  paper_serial: z.string().max(20).nullable().optional(),
  key_tag: z.string().max(20).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  damage_marks: z.array(DamageMark).max(20).optional(),
});

export const SubmitIntakeBody = z.strictObject({
  expected_version: version,
  acknowledge_incomplete_inspection: z.boolean().optional(),
});
export const VersionOnlyBody = z.strictObject({ expected_version: version.optional() });

export const VoidBody = z.strictObject({
  reason: z.string().max(500),
  custody_returned_to_customer: z.boolean(),
  expected_version: version.optional(),
});
export const ReasonOnlyBody = z.strictObject({ reason: z.string().max(500) });

export const CompleteParkingBody = z.strictObject({
  parking_spot_id: uuid.nullable().optional(),
  spot_note: z.string().max(120).nullable().optional(),
  key_slot_id: uuid.nullable().optional(),
  expected_version: version.optional(),
});
export const KeyPickupBody = z.strictObject({ key_slot_id: uuid, expected_version: version.optional() });

export const HandoverBody = z.strictObject({
  verification: z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('code'), code: z.string().regex(/^[0-9]{6}$/) }),
    z.strictObject({ method: z.literal('paper_stub'), paper_serial: z.string().min(1).max(20) }),
  ]),
  payment: z
    .strictObject({
      method: z.enum(['cash', 'pos']),
      amount_halalas: z.number().int().min(0),
      pos_reference: z.string().max(40).nullable().optional(),
    })
    .nullable()
    .optional(),
  expected_version: version.optional(),
});

export const ListTicketsQuery = z.strictObject({
  event_id: uuid.optional(),
  venue_id: uuid.optional(),
  status: z.string().max(200).optional(),
  q: z.string().max(20).optional(),
  open_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
