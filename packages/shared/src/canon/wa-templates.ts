/**
 * Customer WhatsApp messages W-01 … W-12 (canon §11; definitions in file 12 §8–§9, final copy in
 * file 14 §4). W-01 … W-08 are approved UTILITY templates in Arabic; W-09 … W-12 are free session
 * replies, sent only in reply to an inbound customer message. The only button of the whole
 * conversation is the QUICK_REPLY «طلب السيارة» of W-01, whose payload is the action token.
 *
 * This file is the single source of the customer copy (DEC-74): the template bodies registered with
 * Meta (`POST /{waba_id}/message_templates`), the session reply texts and the catalog linter
 * (12 §8.3, AC-18).
 *
 * The customer brand is configuration (`BRAND_CUSTOMER_NAME_AR`, canon §1; V2-D01, DEC-470): the texts
 * below carry the token {@link WA_BRAND_TOKEN} and {@link waCatalog} fills it in. Meta approves a fixed
 * text, so the bodies registered with Meta name the brand configured when they are created; changing
 * the brand afterwards needs new template versions (`_v2`) approved by Meta (DEC-471).
 *
 * Template sets (V2-050, DEC-555): the templates W-01 … W-08 exist in two sets — `v1` (`masaf_*_v1`, canon §11, the
 * V1 wording) and `v2` (`point_*_v2`, canon §11ب: the venue in every message and the operator in W-01, V2-D01/V2-D02).
 * Meta approves each name with its fixed text, so the old set keeps working until Meta approves the new one;
 * `WA_TEMPLATE_SET` chooses the live set and the template sync submits the live set and every later one. The session
 * replies W-09 … W-12 are one set (free text, no approval); W-09 «delivered» and W-10 carry the optional app line
 * with `CUSTOMER_APP_LINK` (DEC-556). The sign-in template (AUTHENTICATION) is outside the sets (DEC-557).
 */
import { z } from 'zod';
import { BRAND_DEFAULTS } from './brand-defaults.js';
import type { WaTemplateCategory } from './enums.js';

export const WA_MESSAGE_IDS = [
  'W-01',
  'W-02',
  'W-03',
  'W-04',
  'W-05',
  'W-06',
  'W-07',
  'W-08',
  'W-09',
  'W-10',
  'W-11',
  'W-12',
] as const;
export type WaMessageId = (typeof WA_MESSAGE_IDS)[number];
export const WaMessageIdSchema = z.enum(WA_MESSAGE_IDS);

/** `template` = approved Meta template; `session` = free text reply inside the service window. */
export const WA_TEMPLATE_KINDS = ['template', 'session'] as const;
export type WaTemplateKind = (typeof WA_TEMPLATE_KINDS)[number];

/** The only button text in the customer conversation (AC-18). */
export const REQUEST_CAR_BUTTON_TEXT = 'طلب السيارة';

/**
 * The template sets of W-01 … W-08 (DEC-555): `v1` = canon §11 (`masaf_*_v1`), `v2` = canon §11ب (`point_*_v2`).
 * Order = age: the sync submits the live set and every later one, so the next set is approved before the switch.
 */
export const WA_TEMPLATE_SETS = ['v1', 'v2'] as const;
export type WaTemplateSet = (typeof WA_TEMPLATE_SETS)[number];
export const WaTemplateSetSchema = z.enum(WA_TEMPLATE_SETS);
/** The live set when `WA_TEMPLATE_SET` is not given: the set already submitted stays live until switched. */
export const WA_DEFAULT_TEMPLATE_SET: WaTemplateSet = 'v1';

/**
 * What a template variable carries (14 §4 «قواعد بناء المتغيرات»). Each template lists its `{{1}}…{{n}}` by these
 * names, so the sender fills every set from the same facts (DEC-555).
 */
export const WA_TEMPLATE_VARIABLES = [
  'venue_name',
  'display_number',
  'vehicle_description',
  'claim_code',
  'operator_name',
] as const;
export type WaTemplateVariable = (typeof WA_TEMPLATE_VARIABLES)[number];

/**
 * Placeholder of the customer brand name in the source texts (not a Meta variable: single braces, never
 * sent). {@link waCatalog} replaces it with `BRAND_CUSTOMER_NAME_AR` (DEC-470).
 */
export const WA_BRAND_TOKEN = '{brand}';

/** A source text with the customer brand filled in. */
export function withCustomerBrand(text: string, customerBrandAr: string): string {
  return text.replaceAll(WA_BRAND_TOKEN, customerBrandAr);
}

export interface WaQuickReplyButton {
  type: 'QUICK_REPLY';
  text: typeof REQUEST_CAR_BUTTON_TEXT;
  /** The button payload is the opaque action token (`action_tokens`). */
  payload: 'action_token';
}

export interface WaTemplateDef {
  id: WaMessageId;
  name: string;
  kind: WaTemplateKind;
  /** Purpose (canon §11 «الغرض»). */
  purpose_ar: string;
  /** Number of positional body variables `{{1}}…` (0 for session replies). */
  variables: number;
  /** Meaning of `{{1}}…{{n}}`, in order. */
  variable_names: readonly WaTemplateVariable[];
  /** The template set of a Meta template (DEC-555); `null` for session replies. */
  set: WaTemplateSet | null;
  /** Templates only (DEC-10: every customer notification is a UTILITY template). */
  category: WaTemplateCategory | null;
  language: 'ar';
  button: WaQuickReplyButton | null;
  /**
   * Final Arabic text (14 §4, = 12 §8.2 / §9). Templates: the approved BODY with `{{n}}` variables and
   * `\n` line breaks. Session replies: the text of the default variant.
   */
  body_ar: string;
  /** One example value per `{{n}}` (Meta requires examples at creation, 12 §8.2). */
  example: readonly string[];
  /**
   * Session replies with several texts: W-09 by the ticket state (`{{1}}` = ticket number) and W-11
   * received / invalid. `null` for single-text messages.
   */
  variants: Readonly<Record<string, string>> | null;
}

const REQUEST_CAR_BUTTON: WaQuickReplyButton = {
  type: 'QUICK_REPLY',
  text: REQUEST_CAR_BUTTON_TEXT,
  payload: 'action_token',
};

const template = (
  set: WaTemplateSet,
  id: WaMessageId,
  name: string,
  purpose_ar: string,
  variable_names: readonly WaTemplateVariable[],
  body_ar: string,
  example: readonly string[],
  button: WaQuickReplyButton | null = null,
): WaTemplateDef => ({
  id,
  name,
  kind: 'template',
  purpose_ar,
  variables: variable_names.length,
  variable_names,
  set,
  category: 'UTILITY',
  language: 'ar',
  button,
  body_ar,
  example,
  variants: null,
});

const session = (
  id: WaMessageId,
  name: string,
  purpose_ar: string,
  body_ar: string,
  variants: Readonly<Record<string, string>> | null = null,
): WaTemplateDef => ({
  id,
  name,
  kind: 'session',
  purpose_ar,
  variables: 0,
  variable_names: [],
  set: null,
  category: null,
  language: 'ar',
  button: null,
  body_ar,
  example: [],
  variants,
});

/** W-09 texts by the ticket state at the press (14 §4); `{{1}}` = ticket number. */
export const W09_VARIANTS = [
  'pending_early',
  'requested',
  'assigned',
  'assigned_waiting',
  'retrieving',
  'ready',
  'delivered',
  'inactive',
] as const;
export type W09Variant = (typeof W09_VARIANTS)[number];

const W09_TEXTS: Readonly<Record<W09Variant, string>> = {
  pending_early: 'طلبك لسيارتك رقم {{1}} مسجل، وسننفذه فور انتهاء صفها.',
  requested: 'طلبك لسيارتك رقم {{1}} مسجل وننتظر أول سائق متاح، ولا حاجة لإعادة الضغط.',
  assigned: 'طلبك لسيارتك رقم {{1}} مقبول، وسيبدأ الإحضار قريبًا.',
  assigned_waiting: 'طلبك لسيارتك رقم {{1}} في الانتظار وتم إسناده؛ سنبلغك عند بدء الإحضار.',
  retrieving: 'جارٍ إحضار سيارتك رقم {{1}} الآن.',
  ready: 'سيارتك رقم {{1}} جاهزة عند نقطة التسليم. استخدم رمز التسليم المرسل في رسالة الجاهزية.',
  delivered: 'تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك {brand}.{app_line}',
  inactive: 'هذه التذكرة غير نشطة. للمساعدة تواصل مع سائق الفاليت في الموقع.',
};

/** W-11 texts (14 §4). */
export const W11_VARIANTS = ['received', 'invalid'] as const;
export type W11Variant = (typeof W11_VARIANTS)[number];

const W11_TEXTS: Readonly<Record<W11Variant, string>> = {
  received: 'استلمنا رمز الربط. سيتحقق السائق من مركبتك الآن، ثم تصلك رسالة التذكرة.',
  invalid: 'رمز الربط غير صالح أو انتهت صلاحيته. اطلب من سائق الفاليت رمزًا جديدًا.',
};

/**
 * Placeholder of the optional app line in the session texts W-09 «delivered» and W-10 (DEC-556): {@link waCatalog}
 * replaces it with an empty line and {@link WA_APP_LINE_SOURCE} when `CUSTOMER_APP_LINK` is set, else with nothing.
 * Never in a Meta template (12 §8.1: no links, no promotional phrases; F-13) nor in the sign-in template.
 */
export const WA_APP_LINE_TOKEN = '{app_line}';
/** The app line itself; `{app_link}` = `CUSTOMER_APP_LINK` (the download / deep link page, https). */
export const WA_APP_LINE_SOURCE = 'لطلب سيارتك ومتابعتها في زيارتك القادمة، حمّل تطبيق {brand}: {app_link}';

/** W-09 … W-12, the same in every template set (session replies need no approval). */
const SESSION_SOURCES: readonly WaTemplateDef[] = [
  // W-09 reflects the ticket's current status (file 12 §9); never resends the handover code.
  session('W-09', 'reply_current_status', 'رد على ضغط مكرر للزر', W09_TEXTS.requested, W09_TEXTS),
  session(
    'W-10',
    'reply_free_text_guidance',
    'رد على رسالة حرة',
    'مرحبًا بك في {brand}. لطلب سيارتك اضغط زر «طلب السيارة» في رسالة تذكرتك، أو اطلبها مباشرة من سائق الفاليت في الموقع. لإيقاف رسائل {brand} أرسل كلمة: إيقاف{app_line}',
  ),
  session('W-11', 'reply_link_received', 'استلام رسالة ربط QR', W11_TEXTS.received, W11_TEXTS),
  session(
    'W-12',
    'reply_opted_out',
    'تأكيد إيقاف الرسائل',
    'تم إيقاف رسائل {brand} لهذا الرقم. اطلب سيارتك مباشرة من سائق الفاليت في الموقع.',
  ),
];

/**
 * Canon §11, row for row (the `v1` set); texts from 14 §4 with the customer brand as {@link WA_BRAND_TOKEN}. Use
 * {@link waCatalog} (configured brand and set) or {@link WA_TEMPLATES} (defaults) for the texts to send.
 */
export const WA_TEMPLATE_SOURCES: readonly WaTemplateDef[] = [
  template(
    'v1',
    'W-01',
    'masaf_ticket_issued_v1',
    'إصدار التذكرة',
    ['venue_name', 'display_number', 'vehicle_description'],
    '{brand} — {{1}} — تذكرة {{2}}\nتم استلام مركبتك: {{3}}.\nعند رغبتك بالخروج اضغط «طلب السيارة».',
    ['قاعة ريماس', '125', 'تويوتا كامري بيضاء — لوحة 4821'],
    REQUEST_CAR_BUTTON,
  ),
  template(
    'v1',
    'W-02',
    'masaf_request_received_v1',
    'تم تسجيل الطلب',
    ['display_number'],
    'تم تسجيل طلب سيارتك رقم {{1}}؛ سنبلغك عند جاهزيتها.',
    ['125'],
  ),
  template(
    'v1',
    'W-03',
    'masaf_request_reserved_v1',
    'حجز سائق مشغول',
    ['display_number'],
    'طلبك لسيارتك رقم {{1}} في الانتظار وتم إسناده؛ سنبلغك عند بدء الإحضار.',
    ['125'],
  ),
  template(
    'v1',
    'W-04',
    'masaf_retrieval_started_v1',
    'بدء الإحضار الفعلي',
    ['display_number'],
    'جارٍ إحضار سيارتك رقم {{1}} الآن.',
    ['125'],
  ),
  template(
    'v1',
    'W-05',
    'masaf_vehicle_ready_v1',
    'الجاهزية ورمز التسليم',
    ['display_number', 'claim_code'],
    'سيارتك رقم {{1}} جاهزة عند نقطة التسليم.\nرمز التسليم: {{2}}\nأعطِ الرمز للسائق عند الاستلام ولا تشاركه مع غيره.',
    ['125', '482731'],
  ),
  template(
    'v1',
    'W-06',
    'masaf_vehicle_delivered_v1',
    'تم التسليم',
    ['display_number'],
    'تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك {brand}.',
    ['125'],
  ),
  template(
    'v1',
    'W-07',
    'masaf_request_canceled_v1',
    'إلغاء الطلب ميدانيًا',
    ['display_number'],
    'تم إلغاء طلب إحضار سيارتك رقم {{1}}، وتبقى سيارتك محفوظة لدينا. متى رغبت اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125'],
  ),
  template(
    'v1',
    'W-08',
    'masaf_returned_to_parking_v1',
    'إعادة الصف لغياب العميل',
    ['display_number'],
    'لم يتم استلام سيارتك رقم {{1}}، لذلك تُعاد الآن إلى الموقف. متى كنت جاهزًا اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125'],
  ),
  ...SESSION_SOURCES,
];

/**
 * The `v2` set (V2-050, canon §11ب, 14 §4ب; DEC-555): the same messages under the customer brand of the one POINT
 * number for every operator (V2-D02), so each message names its venue (`venue_name`) and W-01 adds the operator line
 * «تشغيل: …» (V2-D01). The only button stays «طلب السيارة» in W-01; no links (12 §8.1).
 */
export const WA_TEMPLATE_SOURCES_V2: readonly WaTemplateDef[] = [
  template(
    'v2',
    'W-01',
    'point_ticket_issued_v2',
    'إصدار التذكرة',
    ['venue_name', 'display_number', 'operator_name', 'vehicle_description'],
    '{brand} — {{1}} — تذكرة {{2}}\nتشغيل: {{3}}\nتم استلام مركبتك: {{4}}.\nعند رغبتك بالخروج اضغط «طلب السيارة»، وسنبلغك هنا بكل خطوة حتى التسليم.',
    ['قاعة ريماس', '125', 'شركة ريماس للضيافة', 'تويوتا كامري بيضاء — لوحة 4821'],
    REQUEST_CAR_BUTTON,
  ),
  template(
    'v2',
    'W-02',
    'point_request_received_v2',
    'تم تسجيل الطلب',
    ['display_number', 'venue_name'],
    'تم تسجيل طلب سيارتك رقم {{1}} في {{2}}؛ سنبلغك عند جاهزيتها.',
    ['125', 'قاعة ريماس'],
  ),
  template(
    'v2',
    'W-03',
    'point_request_reserved_v2',
    'حجز سائق مشغول',
    ['display_number', 'venue_name'],
    'طلبك لسيارتك رقم {{1}} لدى {{2}} في الانتظار وتم إسناده؛ سنبلغك عند بدء الإحضار.',
    ['125', 'قاعة ريماس'],
  ),
  template(
    'v2',
    'W-04',
    'point_retrieval_started_v2',
    'بدء الإحضار الفعلي',
    ['display_number', 'venue_name'],
    'جارٍ إحضار سيارتك رقم {{1}} الآن إلى نقطة التسليم في {{2}}.',
    ['125', 'قاعة ريماس'],
  ),
  template(
    'v2',
    'W-05',
    'point_vehicle_ready_v2',
    'الجاهزية ورمز التسليم',
    ['display_number', 'venue_name', 'claim_code'],
    'سيارتك رقم {{1}} جاهزة عند نقطة التسليم في {{2}}.\nرمز التسليم: {{3}}\nأعطِ الرمز للسائق عند الاستلام ولا تشاركه مع غيره.',
    ['125', 'قاعة ريماس', '482731'],
  ),
  template(
    'v2',
    'W-06',
    'point_vehicle_delivered_v2',
    'تم التسليم',
    ['display_number', 'venue_name'],
    'تم تسليم سيارتك رقم {{1}} في {{2}}. شكرًا لاختيارك {brand}.',
    ['125', 'قاعة ريماس'],
  ),
  template(
    'v2',
    'W-07',
    'point_request_canceled_v2',
    'إلغاء الطلب ميدانيًا',
    ['display_number', 'venue_name'],
    'تم إلغاء طلب إحضار سيارتك رقم {{1}}، وتبقى سيارتك محفوظة لدينا في {{2}}. متى رغبت اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125', 'قاعة ريماس'],
  ),
  template(
    'v2',
    'W-08',
    'point_returned_to_parking_v2',
    'إعادة الصف لغياب العميل',
    ['display_number', 'venue_name'],
    'لم يتم استلام سيارتك رقم {{1}}، لذلك تُعاد الآن إلى الموقف في {{2}}. متى كنت جاهزًا اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125', 'قاعة ريماس'],
  ),
  ...SESSION_SOURCES,
];

/** The sources of each template set, W-01 … W-12 in canon order (DEC-555). */
export const WA_TEMPLATE_SET_SOURCES: Readonly<Record<WaTemplateSet, readonly WaTemplateDef[]>> = {
  v1: WA_TEMPLATE_SOURCES,
  v2: WA_TEMPLATE_SOURCES_V2,
};

/**
 * The positional parameters `{{1}}…{{n}}` of a template from the named facts (DEC-555): the same facts fill every
 * set, whatever its variable order.
 */
export function waTemplateParams(
  def: Pick<WaTemplateDef, 'variable_names'>,
  values: Partial<Record<WaTemplateVariable, string>>,
): string[] {
  return def.variable_names.map((v) => values[v] ?? '');
}

// ---------------------------------------------------------------- V2: the customer app sign-in code (V2-010)

/**
 * The customer app's sign-in code over WhatsApp (V2-D11 as amended by DEC-460; V2-010, DEC-496): a Meta
 * **AUTHENTICATION** template with a copy-code button, sent from the Point number. It is not one of W-01 … W-12
 * (canon §11 keeps its twelve rows and the linter its rules: no other button there): the conversation's only
 * button stays «طلب السيارة». Meta fixes the text of authentication templates (no custom body, no links, no
 * brand): `body_*` below is Meta's preset text, kept here to render the message locally (simulator, redacted
 * copies). The brand reaches the customer as the number's display name (`BRAND_CUSTOMER_NAME_*`, 12 §10).
 */
export const WA_CUSTOMER_OTP_TEMPLATE_NAME = 'point_customer_otp_v1';
export const WA_CUSTOMER_OTP_LANGUAGES = ['ar', 'en'] as const;
export type WaCustomerOtpLanguage = (typeof WA_CUSTOMER_OTP_LANGUAGES)[number];
/** The code's lifetime shown in the footer (= `CUSTOMER_OTP_TTL_S`, 300 s). */
export const WA_CUSTOMER_OTP_EXPIRY_MINUTES = 5;

export interface WaAuthTemplateDef {
  /** our id of the message (not a canon §11 W-##) */
  id: 'C-OTP';
  name: typeof WA_CUSTOMER_OTP_TEMPLATE_NAME;
  category: 'AUTHENTICATION';
  languages: readonly WaCustomerOtpLanguage[];
  /** `{{1}}` = the code; Meta's preset body with the security recommendation and the expiry footer */
  body: Readonly<Record<WaCustomerOtpLanguage, string>>;
  /** the copy-code button (Meta: `OTP` / `COPY_CODE`) */
  button: { type: 'OTP'; otp_type: 'COPY_CODE'; text: Readonly<Record<WaCustomerOtpLanguage, string>> };
  code_expiration_minutes: number;
  /** the customer brand of the catalog (the number's display name; not part of the Meta text) */
  brand: string;
}

/** Meta creation body of an authentication template (`POST /{waba_id}/message_templates`). */
export interface WaAuthTemplateCreation {
  name: typeof WA_CUSTOMER_OTP_TEMPLATE_NAME;
  language: WaCustomerOtpLanguage;
  category: 'AUTHENTICATION';
  /** Meta drops the message when it could not be delivered within the code's lifetime */
  message_send_ttl_seconds: number;
  components: (
    | { type: 'BODY'; add_security_recommendation: true }
    | { type: 'FOOTER'; code_expiration_minutes: number }
    | { type: 'BUTTONS'; buttons: { type: 'OTP'; otp_type: 'COPY_CODE'; text: string }[] }
  )[];
}

const CUSTOMER_OTP_BODY: Readonly<Record<WaCustomerOtpLanguage, string>> = {
  ar: `{{1}} هو رمز التحقق الخاص بك. للحفاظ على أمانك، لا تشارك هذا الرمز.\nتنتهي صلاحية هذا الرمز خلال ${WA_CUSTOMER_OTP_EXPIRY_MINUTES} دقائق.`,
  en: `{{1}} is your verification code. For your security, do not share this code.\nThis code expires in ${WA_CUSTOMER_OTP_EXPIRY_MINUTES} minutes.`,
};
const CUSTOMER_OTP_BUTTON: Readonly<Record<WaCustomerOtpLanguage, string>> = {
  ar: 'نسخ الرمز',
  en: 'Copy code',
};

function customerOtpOf(brand: string): WaAuthTemplateDef {
  return {
    id: 'C-OTP',
    name: WA_CUSTOMER_OTP_TEMPLATE_NAME,
    category: 'AUTHENTICATION',
    languages: WA_CUSTOMER_OTP_LANGUAGES,
    body: CUSTOMER_OTP_BODY,
    button: { type: 'OTP', otp_type: 'COPY_CODE', text: CUSTOMER_OTP_BUTTON },
    code_expiration_minutes: WA_CUSTOMER_OTP_EXPIRY_MINUTES,
    brand,
  };
}

function customerOtpCreations(t: WaAuthTemplateDef): WaAuthTemplateCreation[] {
  return t.languages.map((language) => ({
    name: t.name,
    language,
    category: 'AUTHENTICATION',
    message_send_ttl_seconds: t.code_expiration_minutes * 60,
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: t.code_expiration_minutes },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: t.button.text[language] }] },
    ],
  }));
}

/**
 * The Cloud API send body of a sign-in code: the code fills the body variable and the copy-code button (Meta's
 * authentication templates take it as the `url` button parameter). Built by the worker only, never logged.
 */
export function customerOtpMessage(to: string, language: WaCustomerOtpLanguage, code: string) {
  return {
    messaging_product: 'whatsapp' as const,
    recipient_type: 'individual' as const,
    to,
    type: 'template' as const,
    template: {
      name: WA_CUSTOMER_OTP_TEMPLATE_NAME,
      language: { code: language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
}

/** Template names (W-01 … W-08) of the `v1` set, as registered with Meta (canon §11). */
export const WA_TEMPLATE_NAMES = [
  'masaf_ticket_issued_v1',
  'masaf_request_received_v1',
  'masaf_request_reserved_v1',
  'masaf_retrieval_started_v1',
  'masaf_vehicle_ready_v1',
  'masaf_vehicle_delivered_v1',
  'masaf_request_canceled_v1',
  'masaf_returned_to_parking_v1',
] as const;

/** Template names (W-01 … W-08) of the `v2` set (canon §11ب, V2-050, DEC-555). */
export const WA_TEMPLATE_NAMES_V2 = [
  'point_ticket_issued_v2',
  'point_request_received_v2',
  'point_request_reserved_v2',
  'point_retrieval_started_v2',
  'point_vehicle_ready_v2',
  'point_vehicle_delivered_v2',
  'point_request_canceled_v2',
  'point_returned_to_parking_v2',
] as const;

/** The W-01 … W-08 names of each set, in canon order. */
export const WA_TEMPLATE_NAMES_BY_SET = {
  v1: WA_TEMPLATE_NAMES,
  v2: WA_TEMPLATE_NAMES_V2,
} as const satisfies Record<WaTemplateSet, readonly string[]>;

/** Every W-01 … W-08 template name of every set (oldest set first). */
export const WA_ALL_TEMPLATE_NAMES = [...WA_TEMPLATE_NAMES, ...WA_TEMPLATE_NAMES_V2] as const;
export type WaTemplateName = (typeof WA_ALL_TEMPLATE_NAMES)[number];
export const WaTemplateNameSchema = z.enum(WA_ALL_TEMPLATE_NAMES);

/** Session reply names (W-09 … W-12). */
export const WA_SESSION_REPLY_NAMES = [
  'reply_current_status',
  'reply_free_text_guidance',
  'reply_link_received',
  'reply_opted_out',
] as const;
export type WaSessionReplyName = (typeof WA_SESSION_REPLY_NAMES)[number];

/**
 * Source of the text prefilled by the QR wa.me link (12 §7.2, `prefilled_text` of 07); `{{1}}` = the link
 * code. The customer must press send for anything to happen (12 F-22). The configured text is
 * {@link WaCatalog.linkPrefilledText}.
 */
export const WA_LINK_PREFILLED_SOURCE = 'ربط تذكرة {brand} {{1}}';

/** Replaces `{{n}}` with `params[n - 1]` (missing values are left as written). */
export function renderWaText(text: string, params: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/**
 * Payload of `job.wa_send` (11 §8.11): the notification id plus the ids and flags the sender needs to
 * re-check the fresh state (12 §5.5) — never phones, codes or tokens (DEC-38). Written by the
 * NotificationPlanner, read by the WhatsApp sender.
 */
export const WaSendJobPayloadSchema = z.object({
  notification_id: z.guid(),
  /** retrieval cycle of W-02/W-03/W-04/W-06/W-07/W-08 */
  cycle_id: z.guid().nullable().optional(),
  /** handover code of W-05 (the sender decrypts `claim_codes.code_ciphertext` at send time) */
  claim_code_id: z.guid().nullable().optional(),
  /** `tickets.link_version` the W-01 belongs to */
  link_version: z.number().int().nullable().optional(),
  /** W-09 `inactive`/`status`, W-11 `received`/`invalid` */
  variant: z.string().max(32).nullable().optional(),
  /** our whatsapp_messages row of the customer message a session reply answers */
  inbound_message_id: z.guid().nullable().optional(),
  /** W-02 of an early request (DEC-13) */
  early: z.boolean().optional(),
});
export type WaSendJobPayload = z.infer<typeof WaSendJobPayloadSchema>;

/** Meta template creation body (`POST /{api_version}/{waba_id}/message_templates`, 12 §8.2). */
export interface WaTemplateCreation {
  name: WaTemplateName;
  language: 'ar';
  category: 'UTILITY';
  components: (
    | { type: 'BODY'; text: string; example?: { body_text: string[][] } }
    | { type: 'BUTTONS'; buttons: { type: 'QUICK_REPLY'; text: string }[] }
  )[];
}

/** What the server configures in its customer copy (`WA_TEMPLATE_SET`, `CUSTOMER_APP_LINK`; DEC-555, DEC-556). */
export interface WaCatalogOptions {
  /** the live template set of W-01 … W-08 (default {@link WA_DEFAULT_TEMPLATE_SET}) */
  set?: WaTemplateSet;
  /** the app download / deep link of the app line in W-09 «delivered» and W-10; empty = no app line */
  appLink?: string | null;
}

/**
 * The customer copy with one customer brand filled in (canon §1: `BRAND_CUSTOMER_NAME_AR`; V2-D01,
 * DEC-470), one live template set (DEC-555) and the optional app link (DEC-556). The server builds it from its
 * configuration; the module-level exports below are the catalog of the defaults ({@link BRAND_DEFAULTS}, `v1`,
 * no app link).
 */
export interface WaCatalog {
  /** The customer brand name the texts carry. */
  readonly customerBrandAr: string;
  /** The live template set: the names and texts the sender uses for W-01 … W-08. */
  readonly templateSet: WaTemplateSet;
  /** The app link of the app line (null = none). */
  readonly appLink: string | null;
  /** W-01 … W-12 of the live set, canon §11 (or §11ب) row for row. */
  readonly templates: readonly WaTemplateDef[];
  /** W-01 … W-08 names of the live set, in canon order. */
  readonly templateNames: readonly WaTemplateName[];
  /** Meta creation bodies of W-01 … W-08 of the live set (12 §8.2). */
  readonly definitions: readonly WaTemplateCreation[];
  /**
   * What the template sync submits and follows (DEC-555): the live set and every later set, so the next set gets
   * approved by Meta while the live one keeps being sent. An earlier set is no longer created.
   */
  readonly syncDefinitions: readonly WaTemplateCreation[];
  /** Text prefilled by the QR wa.me link; `{{1}}` = the link code. */
  readonly linkPrefilledText: string;
  /** V2: the customer app's sign-in code (AUTHENTICATION template, DEC-496), the same in every set (DEC-557). */
  readonly customerOtp: WaAuthTemplateDef;
  /** Meta creation bodies of the sign-in template, one per language. */
  readonly authDefinitions: readonly WaAuthTemplateCreation[];
  byId(id: WaMessageId): WaTemplateDef;
  byName(name: string): WaTemplateDef | undefined;
  /** True for a W-01 … W-08 name of the live set. */
  isLiveTemplate(name: string): boolean;
  /** Text of a message (default or named variant) before `{{n}}` are filled in. */
  messageText(id: WaMessageId, variant?: string | null): string;
}

/** The customer text of a source: the app line (or nothing), then the brand. */
function customerText(text: string, brand: string, appLink: string | null): string {
  const line = appLink ? `\n\n${WA_APP_LINE_SOURCE.replace('{app_link}', appLink)}` : '';
  return withCustomerBrand(text.replaceAll(WA_APP_LINE_TOKEN, line), brand);
}

function brandedDef(t: WaTemplateDef, brand: string, appLink: string | null): WaTemplateDef {
  return {
    ...t,
    body_ar: customerText(t.body_ar, brand, appLink),
    variants: t.variants
      ? Object.fromEntries(Object.entries(t.variants).map(([k, v]) => [k, customerText(v, brand, appLink)]))
      : null,
  };
}

function creationOf(t: WaTemplateDef): WaTemplateCreation {
  return {
    name: t.name as WaTemplateName,
    language: 'ar',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY' as const,
        text: t.body_ar,
        ...(t.variables > 0 ? { example: { body_text: [[...t.example]] } } : {}),
      },
      ...(t.button
        ? [{ type: 'BUTTONS' as const, buttons: [{ type: 'QUICK_REPLY' as const, text: t.button.text }] }]
        : []),
    ],
  };
}

/** Meta creation bodies of W-01 … W-08 of one set with a customer brand (templates carry no app line). */
function setCreations(set: WaTemplateSet, brand: string): WaTemplateCreation[] {
  return WA_TEMPLATE_SET_SOURCES[set]
    .filter((t) => t.kind === 'template')
    .map((t) => creationOf(brandedDef(t, brand, null)));
}

function buildCatalog(customerBrandAr: string, set: WaTemplateSet, appLink: string | null): WaCatalog {
  const templates = WA_TEMPLATE_SET_SOURCES[set].map((t) => brandedDef(t, customerBrandAr, appLink));
  const byId = new Map(templates.map((t) => [t.id, t]));
  const byName = new Map(templates.map((t) => [t.name, t]));
  const def = (id: WaMessageId): WaTemplateDef => {
    const found = byId.get(id);
    if (!found) throw new Error(`Unknown WhatsApp message id ${id}`);
    return found;
  };
  const customerOtp = customerOtpOf(customerBrandAr);
  const templateNames: readonly WaTemplateName[] = WA_TEMPLATE_NAMES_BY_SET[set];
  const definitions = templates.filter((t) => t.kind === 'template').map(creationOf);
  return {
    customerBrandAr,
    templateSet: set,
    appLink,
    templates,
    templateNames,
    definitions,
    syncDefinitions: WA_TEMPLATE_SETS.slice(WA_TEMPLATE_SETS.indexOf(set)).flatMap((s) =>
      s === set ? definitions : setCreations(s, customerBrandAr),
    ),
    linkPrefilledText: withCustomerBrand(WA_LINK_PREFILLED_SOURCE, customerBrandAr),
    customerOtp,
    authDefinitions: customerOtpCreations(customerOtp),
    byId: def,
    byName: (name) => byName.get(name),
    isLiveTemplate: (name) => (templateNames as readonly string[]).includes(name),
    messageText(id, variant) {
      const d = def(id);
      if (variant && d.variants) {
        const text = d.variants[variant];
        if (text === undefined) throw new Error(`Unknown variant ${variant} of ${id}`);
        return text;
      }
      return d.body_ar;
    },
  };
}

const CATALOGS = new Map<string, WaCatalog>();

/**
 * The catalog of a customer brand, a template set and an app link (memoized). Blank values fall back to the
 * defaults (the default brand, as `resolveBrand` does; set `v1`; no app line).
 */
export function waCatalog(
  customerBrandAr: string = BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR,
  options: WaCatalogOptions = {},
): WaCatalog {
  const brand = customerBrandAr.trim() || BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR;
  const set = options.set ?? WA_DEFAULT_TEMPLATE_SET;
  const appLink = options.appLink?.trim() || null;
  const key = JSON.stringify([brand, set, appLink]);
  let c = CATALOGS.get(key);
  if (!c) {
    c = buildCatalog(brand, set, appLink);
    CATALOGS.set(key, c);
  }
  return c;
}

const DEFAULT_CATALOG = waCatalog();

/** W-01 … W-12 with the default customer brand; the server sends {@link waCatalog} of its configuration. */
export const WA_TEMPLATES: readonly WaTemplateDef[] = DEFAULT_CATALOG.templates;

/** The creation definitions of W-01 … W-08 (`v1`) with the default customer brand. */
export const WA_TEMPLATE_DEFINITIONS: readonly WaTemplateCreation[] = DEFAULT_CATALOG.definitions;

/** W-01 … W-12 of the `v2` set with the default customer brand and no app line (canon §11ب, DEC-555). */
export const WA_TEMPLATES_V2: readonly WaTemplateDef[] = waCatalog(undefined, { set: 'v2' }).templates;

/** The creation definitions of W-01 … W-08 (`v2`) with the default customer brand (the submission sheet). */
export const WA_TEMPLATE_DEFINITIONS_V2: readonly WaTemplateCreation[] = waCatalog(undefined, {
  set: 'v2',
}).definitions;

/** The wa.me prefilled text with the default customer brand. */
export const WA_LINK_PREFILLED_TEXT = DEFAULT_CATALOG.linkPrefilledText;

/** A message definition (default brand, set `v1`; names, kinds and variables do not depend on the brand). */
export function waTemplateById(id: WaMessageId): WaTemplateDef {
  return DEFAULT_CATALOG.byId(id);
}

export function waTemplateByName(name: string): WaTemplateDef | undefined {
  return DEFAULT_CATALOG.byName(name);
}

/** True for the approved templates W-01 … W-08 (`kind = template`). */
export function isWaTemplateMessage(id: WaMessageId): boolean {
  return waTemplateById(id).kind === 'template';
}

/** Text of a message with the default customer brand (see {@link WaCatalog.messageText}). */
export function waMessageText(id: WaMessageId, variant?: string | null): string {
  return DEFAULT_CATALOG.messageText(id, variant);
}

/** Highest `{{n}}` of a text and whether the variables are exactly 1…n. */
function variablesOf(text: string): { count: number; contiguous: boolean } {
  const seen = new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  const count = seen.size ? Math.max(...seen) : 0;
  return { count, contiguous: seen.size === count };
}

const URL_LIKE = /(https?:\/\/|www\.|wa\.me\/|\.com\b|\.sa\b)/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const FORBIDDEN_BUTTON_TYPES = ['URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM'];

/**
 * Catalog linter (12 §8.3, AC-18, PNT-039): returns the problems found (empty = valid).
 * 1. Only W-01 has buttons: exactly one QUICK_REPLY «طلب السيارة» whose payload is the action token.
 * 2. No URL / phone / copy-code / OTP buttons anywhere.
 * 3. A staff brand name that is not also a customer brand name never appears in a customer text; the
 *    customer brand names the business (W-01 opens every conversation with it) and is the only brand
 *    used. Since V2-D01 the default customer brand is the staff brand «POINT» itself (DEC-470), so with
 *    the defaults no staff-only name is left to forbid; a deployment with a distinct customer brand
 *    keeps the V1 rule. No source text keeps the unfilled {@link WA_BRAND_TOKEN}.
 * 4. `{{n}}` of each body = its variables = its examples, contiguous from 1.
 * 5. No body starts or ends with a variable; length ≤ 1024; no links or emojis. The one exception (DEC-556): the
 *    configured app link `appLink`, in a session reply only (W-09 «delivered», W-10) and only as https; never in a
 *    Meta template.
 * 6. Names match canon §11 (`v1`) or §11ب (`v2`), one whole set; templates are UTILITY in `ar`.
 */
export function lintWaCatalog(
  catalog: readonly WaTemplateDef[] = WA_TEMPLATES,
  brands: { customer: readonly string[]; staff: readonly string[] } = {
    customer: [BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR, BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_EN],
    staff: [BRAND_DEFAULTS.BRAND_STAFF_NAME_AR, BRAND_DEFAULTS.BRAND_STAFF_NAME_EN],
  },
  options: { appLink?: string | null } = {},
): string[] {
  const problems: string[] = [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const staffOnly = brands.staff.filter((s) => !brands.customer.some((c) => same(c, s)));
  const appLink = options.appLink?.trim() || null;
  if (appLink && !/^https:\/\/[^\s]+$/.test(appLink)) problems.push('the app link must be an https URL');
  const names = catalog.filter((t) => t.kind === 'template').map((t) => t.name);
  const set = WA_TEMPLATE_SETS.find(
    (s) => JSON.stringify(names) === JSON.stringify(WA_TEMPLATE_NAMES_BY_SET[s]),
  );
  if (!set) problems.push(`template names differ from canon §11 / §11ب: ${names.join(', ')}`);
  for (const t of catalog)
    if (t.kind === 'template' && set && t.set !== set) problems.push(`${t.id}: not of the ${set} set`);
  const withButtons = catalog.filter((t) => t.button);
  if (withButtons.length !== 1 || withButtons[0]?.id !== 'W-01')
    problems.push(
      `only W-01 may have a button (found: ${withButtons.map((t) => t.id).join(', ') || 'none'})`,
    );
  for (const t of catalog) {
    const texts = [t.body_ar, ...Object.values(t.variants ?? {})];
    if (t.button) {
      const b = t.button as { type: string; text: string; payload: string };
      if (b.type !== 'QUICK_REPLY' || b.text !== REQUEST_CAR_BUTTON_TEXT || b.payload !== 'action_token')
        problems.push(`${t.id}: the button must be QUICK_REPLY «${REQUEST_CAR_BUTTON_TEXT}» (action token)`);
      if (FORBIDDEN_BUTTON_TYPES.includes(b.type)) problems.push(`${t.id}: forbidden ${b.type} button`);
    }
    if (t.kind === 'template') {
      if (t.category !== 'UTILITY') problems.push(`${t.id}: category must be UTILITY`);
      if (t.language !== 'ar') problems.push(`${t.id}: language must be ar`);
      const v = variablesOf(t.body_ar);
      if (v.count !== t.variables || !v.contiguous)
        problems.push(
          `${t.id}: body has ${v.count} variables (contiguous: ${v.contiguous}), canon ${t.variables}`,
        );
      if (t.example.length !== t.variables || t.variable_names.length !== t.variables)
        problems.push(`${t.id}: examples/variable names must match the ${t.variables} variables`);
      if (/^\s*\{\{\d+\}\}/.test(t.body_ar) || /\{\{\d+\}\}\s*$/.test(t.body_ar))
        problems.push(`${t.id}: a body must not start or end with a variable`);
      if (t.body_ar.length > 1024) problems.push(`${t.id}: body longer than 1024 characters`);
    } else if (variablesOf(t.body_ar).count > 0 && t.id !== 'W-09') {
      problems.push(`${t.id}: session replies have no variables`);
    }
    for (const text of texts) {
      for (const s of staffOnly)
        if (text.toLowerCase().includes(s.toLowerCase()))
          problems.push(`${t.id}: staff brand «${s}» in customer text`);
      if (text.includes(WA_BRAND_TOKEN)) problems.push(`${t.id}: the customer brand is not filled in`);
      if (text.includes(WA_APP_LINE_TOKEN) || text.includes('{app_link}'))
        problems.push(`${t.id}: the app line is not filled in`);
      // the app link may stand in a session reply only (DEC-556); a template never carries a link (12 §8.1)
      const checked = appLink && t.kind === 'session' ? text.split(appLink).join('') : text;
      if (URL_LIKE.test(checked)) problems.push(`${t.id}: links are not allowed`);
      if (EMOJI.test(text)) problems.push(`${t.id}: emojis are not allowed`);
      if (/طلب السيارة/.test(text) && !text.includes(`«${REQUEST_CAR_BUTTON_TEXT}»`))
        problems.push(`${t.id}: the button name must be quoted «${REQUEST_CAR_BUTTON_TEXT}»`);
    }
  }
  const opener = catalog.find((t) => t.id === 'W-01');
  if (!opener || !brands.customer.some((c) => opener.body_ar.includes(c)))
    problems.push('W-01 must name the customer brand (it opens every conversation)');
  return problems;
}
