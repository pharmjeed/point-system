import { ApiError, displayMessage } from '@/api/errors';

/**
 * Where a command error goes on a form (02 §1.9, 08 §8): `VALIDATION_FAILED` under each field of
 * `details.fields`; a code that names one field under that field; anything else above the button with the
 * follow-up code. The text is the server's `message_ar` (the 08 text, DEC-80); `FieldError.message_ar` wins
 * for a field when the server sends one.
 */
export interface FormErrors {
  form: string | null;
  requestId: string | null;
  fields: Record<string, string>;
}

export const NO_ERRORS: FormErrors = { form: null, requestId: null, fields: {} };

export function toFormErrors(error: unknown, codeFields: Record<string, string> = {}): FormErrors {
  if (!error) return NO_ERRORS;
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_FAILED' && error.fields.length > 0) {
      const fields: Record<string, string> = {};
      for (const f of error.fields) fields[f.field] = f.message_ar || error.message_ar;
      return { form: error.message_ar, requestId: null, fields };
    }
    const field = codeFields[error.code];
    if (field) return { form: null, requestId: null, fields: { [field]: error.message_ar } };
    return { form: error.message_ar, requestId: error.requestId, fields: {} };
  }
  return { form: displayMessage(error), requestId: null, fields: {} };
}

/** First error for any of these field paths (`fee_halalas`, `range.to`, …). */
export function fieldError(errors: FormErrors, ...paths: string[]): string | undefined {
  for (const p of paths) {
    const hit = errors.fields[p] ?? Object.entries(errors.fields).find(([k]) => k.startsWith(`${p}.`))?.[1];
    if (hit) return hit;
  }
  return undefined;
}
