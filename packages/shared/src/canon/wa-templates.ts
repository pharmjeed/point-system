/**
 * Customer WhatsApp messages W-01 … W-12 (canon §11; definitions in file 12 §8–§9, final copy in
 * file 14 §4). W-01 … W-08 are approved UTILITY templates in Arabic; W-09 … W-12 are free session
 * replies, sent only in reply to an inbound customer message. The only button of the whole
 * conversation is the QUICK_REPLY «طلب السيارة» of W-01, whose payload is the action token.
 *
 * This file and brand-defaults.ts are the only shared files allowed to contain the brand names.
 */
import { z } from 'zod';
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
});

const session = (id: WaMessageId, name: string, purpose_ar: string): WaTemplateDef => ({
  id,
  name,
  kind: 'session',
  purpose_ar,
  variables: 0,
  variable_names: [],
  category: null,
  language: 'ar',
  button: null,
});

/** Canon §11, row for row. */
export const WA_TEMPLATES: readonly WaTemplateDef[] = [
  template(
    'W-01',
    'masaf_ticket_issued_v1',
    'إصدار التذكرة',
    ['venue_name', 'display_number', 'vehicle_description'],
    REQUEST_CAR_BUTTON,
  ),
  template('W-02', 'masaf_request_received_v1', 'تم تسجيل الطلب', ['display_number']),
  template('W-03', 'masaf_request_reserved_v1', 'حجز سائق مشغول', ['display_number']),
  template('W-04', 'masaf_retrieval_started_v1', 'بدء الإحضار الفعلي', ['display_number']),
  template('W-05', 'masaf_vehicle_ready_v1', 'الجاهزية ورمز التسليم', ['display_number', 'claim_code']),
  template('W-06', 'masaf_vehicle_delivered_v1', 'تم التسليم', ['display_number']),
  template('W-07', 'masaf_request_canceled_v1', 'إلغاء الطلب ميدانيًا', ['display_number']),
  template('W-08', 'masaf_returned_to_parking_v1', 'إعادة الصف لغياب العميل', ['display_number']),
  // W-09 reflects the ticket's current status (file 12 §9); never resends the handover code.
  session('W-09', 'reply_current_status', 'رد على ضغط مكرر للزر'),
  session('W-10', 'reply_free_text_guidance', 'رد على رسالة حرة'),
  session('W-11', 'reply_link_received', 'استلام رسالة ربط QR'),
  session('W-12', 'reply_opted_out', 'تأكيد إيقاف الرسائل'),
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
