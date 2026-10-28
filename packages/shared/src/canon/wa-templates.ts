/**
 * Customer WhatsApp messages W-01 … W-12 (canon §11; definitions in file 12 §8–§9, final copy in
 * file 14 §4). W-01 … W-08 are approved UTILITY templates in Arabic; W-09 … W-12 are free session
 * replies, sent only in reply to an inbound customer message. The only button of the whole
 * conversation is the QUICK_REPLY «طلب السيارة» of W-01, whose payload is the action token.
 *
 * This file is the single source of the customer copy (DEC-74): the template bodies registered with
 * Meta (`POST /{waba_id}/message_templates`), the session reply texts and the catalog linter
 * (12 §8.3, AC-18). The approved bodies name the customer brand literally because Meta approves a
 * fixed text.
 *
 * This file and brand-defaults.ts are the only shared files allowed to contain the brand names.
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
  variable_names: readonly string[];
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
  id: WaMessageId,
  name: string,
  purpose_ar: string,
  variable_names: readonly string[],
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
  delivered: 'تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك مصاف.',
  inactive: 'هذه التذكرة غير نشطة. للمساعدة تواصل مع سائق الفاليت في الموقع.',
};

/** W-11 texts (14 §4). */
export const W11_VARIANTS = ['received', 'invalid'] as const;
export type W11Variant = (typeof W11_VARIANTS)[number];

const W11_TEXTS: Readonly<Record<W11Variant, string>> = {
  received: 'استلمنا رمز الربط. سيتحقق السائق من مركبتك الآن، ثم تصلك رسالة التذكرة.',
  invalid: 'رمز الربط غير صالح أو انتهت صلاحيته. اطلب من سائق الفاليت رمزًا جديدًا.',
};

/** Canon §11, row for row; texts from 14 §4. */
export const WA_TEMPLATES: readonly WaTemplateDef[] = [
  template(
    'W-01',
    'masaf_ticket_issued_v1',
    'إصدار التذكرة',
    ['venue_name', 'display_number', 'vehicle_description'],
    'مصاف — {{1}} — تذكرة {{2}}\nتم استلام مركبتك: {{3}}.\nعند رغبتك بالخروج اضغط «طلب السيارة».',
    ['قاعة ريماس', '125', 'تويوتا كامري بيضاء — لوحة 4821'],
    REQUEST_CAR_BUTTON,
  ),
  template(
    'W-02',
    'masaf_request_received_v1',
    'تم تسجيل الطلب',
    ['display_number'],
    'تم تسجيل طلب سيارتك رقم {{1}}؛ سنبلغك عند جاهزيتها.',
    ['125'],
  ),
  template(
    'W-03',
    'masaf_request_reserved_v1',
    'حجز سائق مشغول',
    ['display_number'],
    'طلبك لسيارتك رقم {{1}} في الانتظار وتم إسناده؛ سنبلغك عند بدء الإحضار.',
    ['125'],
  ),
  template(
    'W-04',
    'masaf_retrieval_started_v1',
    'بدء الإحضار الفعلي',
    ['display_number'],
    'جارٍ إحضار سيارتك رقم {{1}} الآن.',
    ['125'],
  ),
  template(
    'W-05',
    'masaf_vehicle_ready_v1',
    'الجاهزية ورمز التسليم',
    ['display_number', 'claim_code'],
    'سيارتك رقم {{1}} جاهزة عند نقطة التسليم.\nرمز التسليم: {{2}}\nأعطِ الرمز للسائق عند الاستلام ولا تشاركه مع غيره.',
    ['125', '482731'],
  ),
  template(
    'W-06',
    'masaf_vehicle_delivered_v1',
    'تم التسليم',
    ['display_number'],
    'تم تسليم سيارتك رقم {{1}}. شكرًا لاختيارك مصاف.',
    ['125'],
  ),
  template(
    'W-07',
    'masaf_request_canceled_v1',
    'إلغاء الطلب ميدانيًا',
    ['display_number'],
    'تم إلغاء طلب إحضار سيارتك رقم {{1}}، وتبقى سيارتك محفوظة لدينا. متى رغبت اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125'],
  ),
  template(
    'W-08',
    'masaf_returned_to_parking_v1',
    'إعادة الصف لغياب العميل',
    ['display_number'],
    'لم يتم استلام سيارتك رقم {{1}}، لذلك تُعاد الآن إلى الموقف. متى كنت جاهزًا اضغط «طلب السيارة» في رسالة التذكرة.',
    ['125'],
  ),
  // W-09 reflects the ticket's current status (file 12 §9); never resends the handover code.
  session('W-09', 'reply_current_status', 'رد على ضغط مكرر للزر', W09_TEXTS.requested, W09_TEXTS),
  session(
    'W-10',
    'reply_free_text_guidance',
    'رد على رسالة حرة',
    'مرحبًا بك في مصاف. لطلب سيارتك اضغط زر «طلب السيارة» في رسالة تذكرتك، أو اطلبها مباشرة من سائق الفاليت في الموقع. لإيقاف رسائل مصاف أرسل كلمة: إيقاف',
  ),
  session('W-11', 'reply_link_received', 'استلام رسالة ربط QR', W11_TEXTS.received, W11_TEXTS),
  session(
    'W-12',
    'reply_opted_out',
    'تأكيد إيقاف الرسائل',
    'تم إيقاف رسائل مصاف لهذا الرقم. اطلب سيارتك مباشرة من سائق الفاليت في الموقع.',
  ),
];

/** Template names (W-01 … W-08), as registered with Meta. */
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
export type WaTemplateName = (typeof WA_TEMPLATE_NAMES)[number];
export const WaTemplateNameSchema = z.enum(WA_TEMPLATE_NAMES);

/** Session reply names (W-09 … W-12). */
export const WA_SESSION_REPLY_NAMES = [
  'reply_current_status',
  'reply_free_text_guidance',
  'reply_link_received',
  'reply_opted_out',
] as const;
export type WaSessionReplyName = (typeof WA_SESSION_REPLY_NAMES)[number];

const BY_ID = new Map(WA_TEMPLATES.map((t) => [t.id, t]));
const BY_NAME = new Map(WA_TEMPLATES.map((t) => [t.name, t]));

export function waTemplateById(id: WaMessageId): WaTemplateDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown WhatsApp message id ${id}`);
  return def;
}

export function waTemplateByName(name: string): WaTemplateDef | undefined {
  return BY_NAME.get(name);
}

/**
 * Text prefilled by the QR wa.me link (12 §7.2, `prefilled_text` of 07); `{{1}}` = the link code. The
 * customer must press send for anything to happen (12 F-22).
 */
export const WA_LINK_PREFILLED_TEXT = 'ربط تذكرة مصاف {{1}}';

/** True for the approved templates W-01 … W-08 (`kind = template`). */
export function isWaTemplateMessage(id: WaMessageId): boolean {
  return waTemplateById(id).kind === 'template';
}

/** Replaces `{{n}}` with `params[n - 1]` (missing values are left as written). */
export function renderWaText(text: string, params: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/** Text of a message (default or named variant) before variables are filled in. */
export function waMessageText(id: WaMessageId, variant?: string | null): string {
  const def = waTemplateById(id);
  if (variant && def.variants) {
    const text = def.variants[variant];
    if (text === undefined) throw new Error(`Unknown variant ${variant} of ${id}`);
    return text;
  }
  return def.body_ar;
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

/** The creation definitions of W-01 … W-08, generated from {@link WA_TEMPLATES}. */
export const WA_TEMPLATE_DEFINITIONS: readonly WaTemplateCreation[] = WA_TEMPLATES.filter(
  (t) => t.kind === 'template',
).map((t) => ({
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
}));

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
 * 3. The staff brand never appears in a customer text; the customer brand names the business (W-01 opens
 *    every conversation with it) and is the only brand used.
 * 4. `{{n}}` of each body = its variables = its examples, contiguous from 1.
 * 5. No body starts or ends with a variable; length ≤ 1024; no links or emojis.
 * 6. Names match canon §11; templates are UTILITY in `ar`.
 */
export function lintWaCatalog(
  catalog: readonly WaTemplateDef[] = WA_TEMPLATES,
  brands: { customer: readonly string[]; staff: readonly string[] } = {
    customer: [BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR],
    staff: [BRAND_DEFAULTS.BRAND_STAFF_NAME_AR, BRAND_DEFAULTS.BRAND_STAFF_NAME_EN],
  },
): string[] {
  const problems: string[] = [];
  const names = catalog.filter((t) => t.kind === 'template').map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(WA_TEMPLATE_NAMES))
    problems.push(`template names differ from canon §11: ${names.join(', ')}`);
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
      for (const s of brands.staff)
        if (text.toLowerCase().includes(s.toLowerCase()))
          problems.push(`${t.id}: staff brand «${s}» in customer text`);
      if (URL_LIKE.test(text)) problems.push(`${t.id}: links are not allowed`);
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
