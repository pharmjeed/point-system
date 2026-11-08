/**
 * Staff Web Push (file 14 §6; DEC-23): the payload the server encrypts for a device, its headers and the
 * Arabic copy of 14 §6.3. The brand prefix of every title is `BRAND_STAFF_NAME_AR` (canon §1), never a
 * literal here. The Service Worker of the web app reads the same contract.
 *
 * Lock-screen rule (DEC-23, canon §2.11): a payload carries the ticket display number and ids only —
 * never a phone, a plate, a key or spot position, a customer name or a handover code. The schema is strict,
 * so such a field cannot even be added.
 */
import { z } from 'zod';
import { PushNotificationTypeSchema, type PushNotificationType } from './enums.js';

/** Version of the payload format (`v`). */
export const PUSH_PAYLOAD_VERSION = 1;

/** Why a quiet `closed` notification replaces the request under the same tag (14 §6.3). */
export const PUSH_CLOSED_VARIANTS = ['claimed', 'ended', 'withdrawn', 'canceled'] as const;
export type PushClosedVariant = (typeof PUSH_CLOSED_VARIANTS)[number];
export const PushClosedVariantSchema = z.enum(PUSH_CLOSED_VARIANTS);

/** Where a click opens the app (14 §6.4.5): the driver home D-04, or the supervisor alert centre S-04. */
export const PUSH_URLS = { driver: '/d', alerts: '/ops/alerts' } as const;

/**
 * `TTL` header in seconds (14 §6.2). `offer` is the time left in the round, capped by this value; the
 * others are fixed. A retry never goes past the notification's deadline (14 §6.6).
 */
export const PUSH_TTL_S: Readonly<Record<PushNotificationType, number>> = {
  offer: 30,
  broadcast: 60,
  reminder: 60,
  next_due: 300,
  closed: 300,
  escalation: 600,
};

/** `Urgency` header (14 §6.2). */
export const PUSH_URGENCY = 'high' as const;

/** `Topic` header: the task or alert id without dashes (32 characters, 14 §6.2). */
export function pushTopic(id: string): string {
  return id.replace(/-/g, '');
}

/** `tag`: one notification slot per task (or per alert for `escalation`), replaced by the next one. */
export function pushTag(target: { taskId: string } | { alertId: string }): string {
  return 'taskId' in target ? `task:${target.taskId}` : `alert:${target.alertId}`;
}

const uuid = z.guid();
const isoDateTime = z.iso.datetime({ offset: true });

/** The JSON a device receives (14 §6.2). Every key is always present; `null` when it does not apply. */
export const PushPayloadSchema = z.strictObject({
  v: z.literal(PUSH_PAYLOAD_VERSION),
  kind: PushNotificationTypeSchema,
  tag: z.string().regex(/^(task|alert):[0-9a-f-]{36}$/),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(160),
  /** `tickets.display_number` — the only ticket datum allowed on the lock screen */
  ticket_no: z.number().int().min(1).nullable(),
  task_id: uuid.nullable(),
  offer_id: uuid.nullable(),
  url: z.enum([PUSH_URLS.driver, PUSH_URLS.alerts]),
  renotify: z.boolean(),
  silent: z.boolean(),
  sent_at: isoDateTime,
  /** end of the offer round (offer, single-round reminder); a payload past it is shown as a quiet `closed` */
  expires_at: isoDateTime.nullable(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/** Title suffix after the staff brand (14 §6.3); `closed` shows the brand alone. */
export const PUSH_TITLES: Readonly<Record<PushNotificationType, string | null>> = {
  offer: 'طلب إحضار',
  broadcast: 'طلب مفتوح',
  reminder: 'تذكير',
  next_due: 'مهمتك التالية',
  escalation: 'تنبيه عاجل',
  closed: null,
};

/** Bodies of 14 §6.3 (the ticket number only). */
export const PUSH_BODIES = {
  offer: (n: number) => `تذكرة ${n} — افتح التطبيق للقبول`,
  broadcast: (n: number) => `تذكرة ${n} — افتح للقبول أو الحجز`,
  reminder: (n: number) => `تذكرة ${n} ما زالت بانتظار القبول`,
  next_due: (n: number) => `تذكرة ${n} — ابدأ عند جاهزيتك`,
  closed: {
    claimed: () => 'تم قبول الطلب',
    ended: () => 'انتهى العرض — افتح التطبيق لمعرفة الجديد',
    withdrawn: (n: number) => `سُحبت مهمة تذكرة ${n} — لا تُحضر السيارة`,
    canceled: (n: number) => `أُلغي طلب تذكرة ${n}`,
  } satisfies Record<PushClosedVariant, (n: number) => string>,
} as const;

/**
 * `escalation` bodies: the short form of the 14 §8 alert texts with the ticket number only (no venue,
 * driver or customer data). Only `critical` alerts are pushed (14 §10: `info` never, `warning` in-page).
 */
export function escalationBody(alertType: string, ticketNo: number | null): string {
  const t = ticketNo === null ? '' : ` ${ticketNo}`;
  switch (alertType) {
    case 'no_drivers_on_duty':
      return ticketNo === null
        ? 'لا يوجد سائق متاح وهناك طلب إحضار مفتوح'
        : `لا يوجد سائق متاح وهناك طلب إحضار مفتوح (تذكرة ${ticketNo})`;
    case 'request_unaccepted':
      return `طلب تذكرة${t} دون قبول`;
    case 'handover_code_locked':
      return `تجاوز عميل تذكرة${t} محاولات رمز التسليم — مطلوب حضور المشرف`;
    case 'wa_channel_down':
      return 'واتساب متعطل — اطلب من العملاء مراجعة السائق مباشرة';
    case 'outbox_lag':
      return 'تأخر معالجة الأحداث — قد تتأخر التنبيهات والرسائل';
    case 'wa_webhook_silent':
      return 'توقفت رسائل واتساب الواردة — اطلب من العملاء مراجعة السائق مباشرة';
    default:
      return 'تنبيه عاجل — افتح مركز التنبيهات';
  }
}

/** Title of a notification: `«brand» — «suffix»`, or the brand alone for `closed`. */
export function pushTitle(kind: PushNotificationType, staffBrandAr: string): string {
  const suffix = PUSH_TITLES[kind];
  return suffix ? `${staffBrandAr} — ${suffix}` : staffBrandAr;
}
