/**
 * Pure intake rules (11 TT-03, TT-04a; 08 INTAKE_INCOMPLETE, DRAFT_HAS_DATA).
 */
export interface IntakeSnapshot {
  channel: 'whatsapp' | 'paper';
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_type: string | null;
  key_tag: string | null;
  paper_serial: string | null;
  customer_id: string | null;
  notes: string | null;
  wa_link_status: string;
}

export function hasPlate(
  t: Pick<IntakeSnapshot, 'plate_country' | 'plate_digits' | 'plate_letters_ar' | 'plate_raw'>,
) {
  return t.plate_country === 'SA' ? !!t.plate_digits && !!t.plate_letters_ar : !!t.plate_raw;
}

/**
 * Required fields for `submit-intake` (08 INTAKE_INCOMPLETE: plate, make, colour, key tag, and per channel the
 * customer phone or a QR link code for whatsapp, the paper serial for paper). A phone without consent is
 * CONSENT_REQUIRED, decided by the caller.
 */
export function missingIntakeFields(t: IntakeSnapshot, opts: { hasQrLink: boolean }): string[] {
  const missing: string[] = [];
  if (!hasPlate(t)) missing.push('plate');
  if (!t.vehicle_make?.trim()) missing.push('vehicle.make');
  if (!t.vehicle_color?.trim()) missing.push('vehicle.color');
  if (!t.key_tag) missing.push('key_tag');
  if (t.channel === 'paper') {
    if (!t.paper_serial) missing.push('paper_serial');
  } else if (!t.customer_id && !opts.hasQrLink && t.wa_link_status !== 'linked') {
    missing.push('customer_phone');
  }
  return missing;
}

/**
 * Fields that make a draft non-empty (DEC-20: vehicle data, phone, key tag or an uploaded photo; the paper
 * serial, notes and damage marks are data the driver entered too).
 */
export function draftFieldsPresent(
  t: IntakeSnapshot,
  extra: { uploadedPhotos: number; damageMarks: number },
): string[] {
  const present: string[] = [];
  if (t.plate_digits || t.plate_letters_ar || t.plate_raw) present.push('plate');
  if (t.vehicle_make || t.vehicle_model || t.vehicle_color || t.vehicle_type) present.push('vehicle');
  if (t.customer_id) present.push('customer_phone');
  if (t.key_tag) present.push('key_tag');
  if (t.paper_serial) present.push('paper_serial');
  if (t.notes?.trim()) present.push('notes');
  if (extra.damageMarks > 0) present.push('damage_marks');
  if (extra.uploadedPhotos > 0) present.push('photos');
  return present;
}
