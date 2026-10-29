import { describe, expect, it } from 'vitest';
import { errorsOf, shownFields } from '@/features/driver/intakeErrors';

/**
 * Where the server's answer to the first intake step shows on D-05 (02 D-05 «الأخطاء», D-06 «إبراز الحقول في
 * details.missing»): under a field only when that field is on screen, else as the form message.
 */
const TEXT = 'أكمل بيانات الاستلام الناقصة.';
const incomplete = (missing: string[]) => ({ code: 'INTAKE_INCOMPLETE', message: TEXT, missing });

describe('D-05 errors of the first step', () => {
  const direct = shownFields({ channel: 'whatsapp', method: 'direct' }, { phone: true, consent: true });
  const qr = shownFields({ channel: 'whatsapp', method: 'qr' }, { phone: true, consent: true });
  const paper = shownFields({ channel: 'paper', method: 'direct' }, { phone: true, consent: true });

  it('the fields of each choice: the number and the consent for the direct method, the stub for paper', () => {
    expect([...direct].sort()).toEqual(['color', 'consent', 'make', 'phone', 'plate']);
    expect([...qr].sort()).toEqual(['color', 'make', 'plate']);
    expect([...paper].sort()).toEqual(['color', 'make', 'paper_serial', 'plate']);
    // the number on record shown instead of the input, kept with its consent
    expect(
      [...shownFields({ channel: 'whatsapp', method: 'direct' }, { phone: false, consent: false })].sort(),
    ).toEqual(['color', 'make', 'plate']);
  });

  it('INTAKE_INCOMPLETE: under the fields on screen, no form message', () => {
    expect(errorsOf(incomplete(['customer_phone', 'vehicle.color']), direct)).toEqual({
      fields: { phone: TEXT, color: TEXT },
      form: null,
    });
  });

  it('INTAKE_INCOMPLETE about the number in the QR mode: the form message (the field is not there)', () => {
    expect(errorsOf(incomplete(['customer_phone']), qr)).toEqual({ fields: {}, form: TEXT });
    expect(errorsOf(incomplete(['customer_phone', 'vehicle.color']), qr)).toEqual({
      fields: { color: TEXT },
      form: TEXT,
    });
  });

  it('a code mapped to a field not on screen is the form message', () => {
    const optedOut = { code: 'WA_CUSTOMER_OPTED_OUT', message: 'أوقف العميل رسائل واتساب.' };
    expect(errorsOf(optedOut, direct)).toEqual({ fields: { phone: optedOut.message }, form: null });
    expect(errorsOf(optedOut, paper)).toEqual({ fields: {}, form: optedOut.message });
  });

  it('VALIDATION_FAILED: the fields on screen and the form message; any other code: the form message', () => {
    const validation = {
      code: 'VALIDATION_FAILED',
      message: 'راجع الحقول المظللة.',
      fields: [
        { field: 'plate.digits', message_ar: 'رقم اللوحة غير صالح.' },
        { field: 'customer_phone', message_ar: 'الجوال غير صالح.' },
      ],
    };
    expect(errorsOf(validation, qr)).toEqual({
      fields: { plate: 'رقم اللوحة غير صالح.' },
      form: 'راجع الحقول المظللة.',
    });
    expect(errorsOf({ code: 'EVENT_NOT_OPEN', message: 'الحفل لم يعد مفتوحًا.' }, direct)).toEqual({
      fields: {},
      form: 'الحفل لم يعد مفتوحًا.',
    });
    expect(errorsOf(null, direct)).toEqual({ fields: {}, form: null });
  });
});
