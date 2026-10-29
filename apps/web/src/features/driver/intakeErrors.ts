import type { IntakeDraft } from './intakeStore';
import type { ChannelForm } from './linkModel';

/**
 * Where a server error of the first intake step shows on D-05 (02 D-05 «الأخطاء», D-06 `INTAKE_INCOMPLETE`;
 * 08 field / code mapping), unit-tested in test/intakeErrors.test.ts.
 */

/** Field keys a server error points at on D-05. */
export type IntakeField = 'plate' | 'make' | 'color' | 'paper_serial' | 'phone' | 'consent';

/**
 * 02 D-05 «الأخطاء» (and D-06's row sending the driver back here): the number refused or opted out → under
 * the phone («للعميل الموقف للرسائل: QR أو تذكرة ورقية» — the two other choices stay on the form); the consent
 * box highlighted; the stub number in use.
 */
const CODE_FIELD: Record<string, IntakeField> = {
  PLATE_INVALID: 'plate',
  PAPER_SERIAL_IN_USE: 'paper_serial',
  PHONE_INVALID: 'phone',
  WA_CUSTOMER_OPTED_OUT: 'phone',
  CONSENT_REQUIRED: 'consent',
};

function fieldOf(path: string): IntakeField | null {
  if (path.startsWith('plate')) return 'plate';
  if (path === 'vehicle.make' || path === 'vehicle_make') return 'make';
  if (path === 'vehicle.color' || path === 'vehicle_color') return 'color';
  if (path === 'paper_serial') return 'paper_serial';
  if (path === 'customer_phone') return 'phone';
  if (path === 'consent') return 'consent';
  return null;
}

export type StepError =
  | (NonNullable<IntakeDraft['step1Error']> & { fields?: Array<{ field: string; message_ar?: string }> })
  | null;

/**
 * The D-05 fields on screen for the channel choice: the number and the consent belong to the direct WhatsApp
 * method (`phone` false while the number on record is shown instead of the input, `consent` false while that
 * number is kept), the stub number to paper.
 */
export function shownFields(
  link: Pick<ChannelForm, 'channel' | 'method'>,
  open: { phone: boolean; consent: boolean },
): Set<IntakeField> {
  const shown = new Set<IntakeField>(['plate', 'make', 'color']);
  if (link.channel === 'paper') shown.add('paper_serial');
  else if (link.method === 'direct') {
    if (open.phone) shown.add('phone');
    if (open.consent) shown.add('consent');
  }
  return shown;
}

/**
 * Errors of a step-1 save → field messages + a form message (02 §1.9, 08). A field message needs its field on
 * screen (`shown`); an error about a field the current choice does not show — a missing customer number in
 * the QR mode, say — is the form message instead, so nothing the server said is lost (02 D-06 «إبراز الحقول في
 * details.missing»).
 */
export function errorsOf(error: StepError, shown: ReadonlySet<IntakeField>) {
  const fields: Partial<Record<IntakeField, string>> = {};
  let form: string | null = null;
  if (!error) return { fields, form };
  let unplaced = false;
  const put = (key: IntakeField | null, message: string) => {
    if (key && shown.has(key)) fields[key] = message;
    else unplaced = true;
  };
  const byCode = CODE_FIELD[error.code];
  if (byCode) put(byCode, error.message);
  else if (error.code === 'VALIDATION_FAILED' && error.fields?.length) {
    for (const f of error.fields) {
      const key = fieldOf(f.field);
      if (key && shown.has(key)) fields[key] = f.message_ar || error.message;
    }
    form = error.message;
  } else if (error.code === 'INTAKE_INCOMPLETE' && error.missing?.length) {
    // 02 D-06 «إبراز الحقول في details.missing والانتقال للخطوة التي تحتويها»
    for (const f of error.missing) put(fieldOf(f), error.message);
  } else unplaced = true;
  if (unplaced && !form) form = error.message;
  return { fields, form };
}
