import type { IntakePatch } from '@/api/field';
import type { LinkCodeQr, TicketDetail, TicketStatus, WaLinkStatus } from '@/api/types';
import type { LinkMethod } from './linkStore';

/**
 * Pure rules of the WhatsApp link on the driver screens (02 D-05, D-06, D-07; 07 `PATCH …/intake`,
 * `submit-intake`, `whatsapp-link`; 12 §7.1–§7.3), unit-tested in test/linkModel.test.ts. The server decides
 * every command again; these only choose what the screens offer and send.
 */

export type IntakeChannel = 'whatsapp' | 'paper';

/** D-05 «تذكرة العميل» + «طريقة الربط» + the phone, the consent and the stub number. */
export interface ChannelForm {
  channel: IntakeChannel;
  method: LinkMethod;
  phone: string;
  consent: boolean;
  paperSerial: string;
}

export const DEFAULT_CHANNEL_FORM: ChannelForm = {
  channel: 'whatsapp',
  method: 'direct',
  phone: '',
  consent: false,
  paperSerial: '',
};

/**
 * The channel part of the step-1 PATCH. «طريقة الربط» is not sent (02 D-05: no field in the contract); it is
 * derived from the data: a phone with the verbal consent → the direct link W-01 at «إتمام التسجيل»; no phone →
 * the QR issued right before the submit. Whatever the channel does not use goes as `null` (02 D-05: the QR
 * method empties the phone and the consent; a paper ticket keeps no customer number, 05 §14 «لا لبيانات
 * العميل خارج مسودة الاستلام الجارية»).
 */
export function channelBody(
  form: ChannelForm,
  e164: string | null,
): Pick<IntakePatch, 'channel' | 'customer_phone' | 'consent' | 'paper_serial'> {
  if (form.channel === 'paper')
    return {
      channel: 'paper',
      paper_serial: form.paperSerial.trim(),
      customer_phone: null,
      consent: null,
    };
  if (form.method === 'qr')
    return { channel: 'whatsapp', customer_phone: null, consent: null, paper_serial: null };
  return {
    channel: 'whatsapp',
    customer_phone: e164,
    consent: form.consent ? { method: 'verbal_staff_confirmed', confirmed: true } : null,
    paper_serial: null,
  };
}

export type ChannelIssue = 'phone' | 'consent' | 'paper_serial';

/**
 * The local mandatory checks of 02 D-05 before «التالي» (DEC-356): the stub number for a paper ticket; the
 * phone and the consent for the direct WhatsApp link («الجوال وخانة الموافقة إلزاميان»); nothing for QR.
 */
export function channelIssues(form: ChannelForm, e164: string | null): ChannelIssue[] {
  if (form.channel === 'paper') return form.paperSerial.trim() ? [] : ['paper_serial'];
  if (form.method === 'qr') return [];
  const issues: ChannelIssue[] = [];
  if (!e164) issues.push('phone');
  if (!form.consent) issues.push('consent');
  return issues;
}

/**
 * The form a draft starts from: what this device kept (the typed number stays in the draft only, 05 §14), or
 * the server's ticket (channel, stub number) — the method follows the number on record.
 */
export function channelForm(
  ticket: Pick<TicketDetail, 'channel' | 'paper_serial' | 'customer'>,
  draft: Partial<ChannelForm>,
): ChannelForm {
  return {
    // a draft saved before the WhatsApp choice existed carries a stub number only: it was a paper intake
    channel: draft.channel ?? (draft.paperSerial ? 'paper' : ticket.channel),
    method: draft.method ?? 'direct',
    phone: draft.phone ?? '',
    consent: draft.consent ?? false,
    paperSerial: draft.paperSerial ?? ticket.paper_serial ?? '',
  };
}

/** «الرقم المنتهي بـ 123» / «من رقم ينتهي بـ 123»: the last three digits of a masked number (09 §5.1). */
export function phoneTail(masked: string | null | undefined): string {
  return (masked ?? '').replace(/\D/g, '').slice(-3);
}

const CLOSED: readonly TicketStatus[] = ['delivered', 'voided'];

export const isClosedTicket = (status: TicketStatus): boolean => CLOSED.includes(status);

/** The D-07 mode: أ direct send, ب the customer-brand QR panel, ج the paper stub (02 D-07). */
export type LinkMode = 'direct' | 'qr' | 'paper';

const SENT_STATES: readonly WaLinkStatus[] = ['pending_send', 'linked', 'failed'];

/**
 * Which mode D-07 shows: paper for a paper ticket; QR while a message waits for «هل هذا العميل أمامك؟»;
 * then the method the driver chose (D-05, or switched to on D-07), a QR still in memory, a direct send in
 * progress or done; otherwise the number on record decides (direct) or not (QR).
 */
export function linkMode(
  ticket: Pick<TicketDetail, 'channel' | 'wa_link_status' | 'customer'>,
  chosen: LinkMethod | undefined,
  hasQr: boolean,
): LinkMode {
  if (ticket.channel === 'paper') return 'paper';
  if (ticket.wa_link_status === 'pending_confirmation') return 'qr';
  if (chosen) return chosen;
  if (hasQr) return 'qr';
  if (SENT_STATES.includes(ticket.wa_link_status)) return 'direct';
  return ticket.customer?.phone_masked ? 'direct' : 'qr';
}

export interface LinkActions {
  /** «إعادة الإرسال»: `whatsapp-link {direct}` from none / failed / pending_send after the intake (DEC-193). */
  resend: boolean;
  /** «الربط عبر QR» / «رمز جديد»: received / parking / parked, from none / failed / opted_out / pending_send (DEC-196). */
  qr: boolean;
  /** «تذكرة ورقية»: during `parking` while not linked (DEC-40). */
  paper: boolean;
}

const RESEND_FROM: readonly WaLinkStatus[] = ['none', 'failed', 'pending_send'];
const QR_FROM: readonly WaLinkStatus[] = ['none', 'failed', 'opted_out', 'pending_send'];
const QR_STATUSES: readonly TicketStatus[] = ['received', 'parking', 'parked'];

/** What D-07 offers on this ticket now (07 `linkWhatsApp` conditions, DEC-40); the server decides anyway. */
export function linkActions(
  ticket: Pick<TicketDetail, 'status' | 'channel' | 'wa_link_status'>,
): LinkActions {
  if (ticket.channel !== 'whatsapp' || isClosedTicket(ticket.status))
    return { resend: false, qr: false, paper: false };
  const s = ticket.wa_link_status;
  return {
    resend: ticket.status !== 'received' && RESEND_FROM.includes(s),
    qr: QR_STATUSES.includes(ticket.status) && QR_FROM.includes(s),
    paper: ticket.status === 'parking' && s !== 'linked',
  };
}

/**
 * 02 D-06 «ثم في وضع QR فقط `POST …/whatsapp-link` بـ`method = qr`»: a WhatsApp draft saved without the
 * customer's number gets its QR right before `submit-intake` (which takes such a draft only with a live or
 * confirmed code, 07). The server's ticket decides, so a draft restored on another device asks the same.
 */
export function needsQrAtSubmit(
  ticket: Pick<TicketDetail, 'channel' | 'customer' | 'wa_link_status'>,
): boolean {
  return (
    ticket.channel === 'whatsapp' && !ticket.customer?.phone_masked && QR_FROM.includes(ticket.wa_link_status)
  );
}

/** Milliseconds a QR stays valid by server time (02 D-07 «صالح لمدة 9:41», `link.qr_ttl_min`). */
export function qrRemainingMs(qr: Pick<LinkCodeQr, 'expires_at'>, now: number): number {
  return Math.max(0, Date.parse(qr.expires_at) - now);
}

/** A QR worth reusing for the submit (D-06): live for at least this long, else a new one is issued. */
export const QR_REUSE_MIN_MS = 60_000;

export function reusableQr(qr: LinkCodeQr | undefined, now: number): LinkCodeQr | null {
  return qr && qr.status === 'active' && qrRemainingMs(qr, now) >= QR_REUSE_MIN_MS ? qr : null;
}
