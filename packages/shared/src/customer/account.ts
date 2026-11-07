/**
 * The customer account (`customer_accounts`, `customer_account_consents`; docs/v2/03_Data_Model.md §3) on the
 * wire: `GET/PATCH /v1/customer/me` and `POST /v1/customer/consents` (05 §1). Shapes chosen in V2-011 (DEC-482).
 */
import { z } from 'zod';
import { SAUDI_MOBILE_E164_RE } from '../phone.js';

export const CUSTOMER_LOCALES = ['ar', 'en'] as const;
export type CustomerLocale = (typeof CUSTOMER_LOCALES)[number];
export const CustomerLocaleSchema = z.enum(CUSTOMER_LOCALES);

export const CUSTOMER_ACCOUNT_STATUSES = ['active', 'suspended', 'deleted'] as const;
export const CustomerAccountStatusSchema = z.enum(CUSTOMER_ACCOUNT_STATUSES);

/** `customer_account_consents.kind` (03 §3). */
export const CUSTOMER_CONSENT_KINDS = ['terms', 'privacy', 'marketing', 'card_on_file'] as const;
export type CustomerConsentKind = (typeof CUSTOMER_CONSENT_KINDS)[number];
export const CustomerConsentKindSchema = z.enum(CUSTOMER_CONSENT_KINDS);

/** Answered on C-04: terms and privacy are required, marketing is optional and separate (01 C-04). */
export const CUSTOMER_PROFILE_CONSENT_KINDS = ['terms', 'privacy', 'marketing'] as const;
export type CustomerProfileConsentKind = (typeof CUSTOMER_PROFILE_CONSENT_KINDS)[number];
export const CUSTOMER_REQUIRED_CONSENT_KINDS = ['terms', 'privacy'] as const;

export const CUSTOMER_DISPLAY_NAME_MIN = 2;
export const CUSTOMER_DISPLAY_NAME_MAX = 60;

/** A Saudi mobile in E.164 (V2: the customer signs in with a Saudi number only, C-02). */
export const SaudiMobileE164Schema = z.string().regex(SAUDI_MOBILE_E164_RE);

/** The display name: trimmed, inner whitespace collapsed, 2–60 characters. */
export const CustomerDisplayNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(CUSTOMER_DISPLAY_NAME_MIN).max(CUSTOMER_DISPLAY_NAME_MAX));

/**
 * One consent as the server sees it now. `current_version` is the version of the text in force (settings);
 * `granted` is the latest answer to *that* version (`null` = not answered yet, or answered an older version).
 */
export const CustomerConsentStateSchema = z.object({
  kind: CustomerConsentKindSchema,
  current_version: z.string().min(1),
  granted: z.boolean().nullable(),
  /** Version of the latest answer, whatever it is (may be older than `current_version`). */
  answered_version: z.string().nullable(),
  answered_at: z.iso.datetime({ offset: true }).nullable(),
  /** Public page of the text, opened from C-04 (`null` when the owner has not published it yet). */
  document_url: z.url().nullable(),
});
export type CustomerConsentState = z.infer<typeof CustomerConsentStateSchema>;

/** `GET /v1/customer/me` → `data`. */
export const CustomerMeSchema = z.object({
  id: z.uuid(),
  phone_e164: SaudiMobileE164Schema,
  /** `05•••••123` (canon §15) for places that do not need the full number. */
  phone_masked: z.string(),
  display_name: z.string().nullable(),
  locale: CustomerLocaleSchema,
  status: CustomerAccountStatusSchema,
  consents: z.object({
    terms: CustomerConsentStateSchema,
    privacy: CustomerConsentStateSchema,
    marketing: CustomerConsentStateSchema,
  }),
  /**
   * Computed by the server: a display name is set and terms and privacy are granted at their current version.
   * `false` sends the app to C-04 (also after the owner publishes a new version of a required text).
   */
  profile_complete: z.boolean(),
  vehicles_count: z.int().min(0),
  created_at: z.iso.datetime({ offset: true }),
});
export type CustomerMe = z.infer<typeof CustomerMeSchema>;

/** `PATCH /v1/customer/me` body: at least one field. */
export const CustomerMePatchBodySchema = z
  .strictObject({
    display_name: CustomerDisplayNameSchema.optional(),
    locale: CustomerLocaleSchema.optional(),
  })
  .refine((b) => b.display_name !== undefined || b.locale !== undefined, { message: 'empty patch' });
export type CustomerMePatchBody = z.infer<typeof CustomerMePatchBodySchema>;

/** One answer: the version is the one the customer saw (a stale one → `CUSTOMER_CONSENT_VERSION_STALE`). */
export const CustomerConsentAnswerSchema = z.strictObject({
  kind: z.enum(CUSTOMER_PROFILE_CONSENT_KINDS),
  version: z.string().min(1).max(40),
  granted: z.boolean(),
});

/**
 * `POST /v1/customer/consents` body (append-only rows, 03 §3). Terms and privacy can only be granted here;
 * withdrawing them is deleting the account (C-20). `card_on_file` is answered in the payment flow (C-10).
 */
export const CustomerConsentsBodySchema = z
  .strictObject({ consents: z.array(CustomerConsentAnswerSchema).min(1).max(3) })
  .refine((b) => new Set(b.consents.map((c) => c.kind)).size === b.consents.length, {
    message: 'duplicate kind',
  })
  .refine((b) => b.consents.every((c) => c.kind === 'marketing' || c.granted), {
    message: 'terms and privacy can only be granted',
  });
export type CustomerConsentsBody = z.infer<typeof CustomerConsentsBodySchema>;
