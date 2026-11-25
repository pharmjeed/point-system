/**
 * C-04 logic: the name plus versioned consents (01 C-04, `customer_account_consents`). Terms and privacy are
 * required; marketing is optional and separate, never pre-ticked. The answer carries the version the customer
 * saw; the server refuses a stale one (`CUSTOMER_CONSENT_VERSION_STALE`).
 */
import {
  CustomerDisplayNameSchema,
  type CustomerConsentsBody,
  type CustomerMe,
  type CustomerMePatchBody,
} from '@point/shared/customer';

export interface ProfileForm {
  name: string;
  terms: boolean;
  privacy: boolean;
  marketing: boolean;
}

export interface ProfileErrors {
  name?: 'invalid';
  consents?: 'required';
}

/** Pre-fills from the account: a consent counts as ticked only when granted at the current version. */
export function initialProfileForm(me: CustomerMe): ProfileForm {
  return {
    name: me.display_name ?? '',
    terms: me.consents.terms.granted === true,
    privacy: me.consents.privacy.granted === true,
    marketing: me.consents.marketing.granted === true,
  };
}

export function validateProfile(form: ProfileForm): ProfileErrors {
  const errors: ProfileErrors = {};
  if (!CustomerDisplayNameSchema.safeParse(form.name).success) errors.name = 'invalid';
  if (!form.terms || !form.privacy) errors.consents = 'required';
  return errors;
}

export const hasErrors = (e: ProfileErrors): boolean => e.name !== undefined || e.consents !== undefined;

/**
 * Owner's option 4 (DEC-637): pressing «ابدأ» under the line «بالضغط على «ابدأ» توافق على الشروط وسياسة الخصوصية»
 * is the consent to both, so the form sent ticks them. Each is still recorded on its own with the version shown;
 * marketing stays the customer's own separate answer.
 */
export const acceptRequired = (form: ProfileForm): ProfileForm => ({ ...form, terms: true, privacy: true });

/**
 * The two writes C-04 sends: the name only when it changed, and the consent answers that differ from what the
 * server holds for the current version (marketing is always answered once, «no» included).
 */
export function profileRequests(
  form: ProfileForm,
  me: CustomerMe,
): { patch: CustomerMePatchBody | null; consents: CustomerConsentsBody | null } {
  const name = CustomerDisplayNameSchema.parse(form.name);
  const patch = name !== me.display_name ? { display_name: name } : null;
  const answers: CustomerConsentsBody['consents'] = [];
  for (const kind of ['terms', 'privacy', 'marketing'] as const) {
    const state = me.consents[kind];
    if (state.granted !== form[kind])
      answers.push({ kind, version: state.current_version, granted: form[kind] });
  }
  return { patch, consents: answers.length ? { consents: answers } : null };
}
