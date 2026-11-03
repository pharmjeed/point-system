import type { IntakePatch } from '@/api/field';
import type {
  DriverHome,
  LinkCodeQr,
  TicketDetail,
  TicketStatus,
  WaLinkPending,
  WaLinkStatus,
} from '@/api/types';
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
  recorded?: string | null,
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
  // the number (and its consent) already on the server stays as it is: neither is sent
  if (keepsRecordedPhone(form, recorded)) return { channel: 'whatsapp', paper_serial: null };
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
export function channelIssues(
  form: ChannelForm,
  e164: string | null,
  recorded?: string | null,
): ChannelIssue[] {
  if (form.channel === 'paper') return form.paperSerial.trim() ? [] : ['paper_serial'];
  if (form.method === 'qr' || keepsRecordedPhone(form, recorded)) return [];
  const issues: ChannelIssue[] = [];
  if (!e164) issues.push('phone');
  if (!form.consent) issues.push('consent');
  return issues;
}

/**
 * A direct draft whose customer number is on the server already, without this device's copy of it (a draft
 * resumed on another device or after the browser storage was cleared, 05 §14): D-05 shows the masked number
 * and keeps it — nothing to type again, and neither the number nor the consent is sent — until the driver
 * types another one (which then needs the consent again).
 */
export function keepsRecordedPhone(form: ChannelForm, recorded: string | null | undefined): boolean {
  return form.channel === 'whatsapp' && form.method === 'direct' && !form.phone.trim() && !!recorded;
}

type FormTicket = Pick<TicketDetail, 'channel' | 'paper_serial' | 'customer'> &
  Partial<Pick<TicketDetail, 'plate' | 'vehicle_detail'>>;

/** The first step was saved on the server (a plate or a make on record): a fresh draft has neither. */
const stepSaved = (t: FormTicket) => !!(t.plate?.digits || t.plate?.raw || t.vehicle_detail?.make);

/**
 * The form a draft starts from: what this device kept (the typed number stays in the draft only, 05 §14), or
 * the server's ticket (channel, stub number) — the method follows the number on record: a WhatsApp draft
 * saved without a number was saved in the QR mode; a fresh draft starts with «رقم جوال العميل» (02 D-05).
 */
export function channelForm(ticket: FormTicket, draft: Partial<ChannelForm>): ChannelForm {
  const qrSaved = ticket.channel === 'whatsapp' && stepSaved(ticket) && !ticket.customer?.phone_masked;
  return {
    // a draft saved before the WhatsApp choice existed carries a stub number only: it was a paper intake
    channel: draft.channel ?? (draft.paperSerial ? 'paper' : ticket.channel),
    method: draft.method ?? (qrSaved ? 'qr' : 'direct'),
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

/** What D-07 draws: ج the stub, أ the send status, ب the customer panel (02 D-07). */
export type LinkBody = 'paper' | 'status' | 'panel';

/**
 * The body of D-07 for its mode: the QR method shows the customer panel until the ticket is linked — also
 * while an earlier W-01 is still pending (DEC-PROPOSED-13: whichever links first wins), and with «انتهت صلاحية
 * الرمز.» + «رمز جديد» once the code ran out; only `linked` turns it into mode أ's status with «تم الربط — وصلت
 * التذكرة للعميل.». The direct method always shows mode أ.
 */
export function linkBody(mode: LinkMode, status: WaLinkStatus): LinkBody {
  if (mode === 'paper') return 'paper';
  if (mode === 'direct') return 'status';
  return status === 'linked' ? 'status' : 'panel';
}

/**
 * The message waiting for «هل هو جوال العميل الذي أمامك؟» (02 D-07) and the link code the answer goes to: the
 * ticket's own `wa_link_pending` when its projection carries the field (null = none, 09 §5.1), else the one a
 * `ticket.updated` brought — unless it is for another code than the one this driver issued since (a code is
 * issued only while none waits, 07: an older message cannot be his customer's) —, else the code he issued.
 */
export function pendingConfirmation(
  ticket: Pick<TicketDetail, 'wa_link_status' | 'wa_link_pending'>,
  noted: WaLinkPending | null | undefined,
  qr: Pick<LinkCodeQr, 'link_code_id'> | undefined,
): { linkCodeId: string; pending: WaLinkPending | null } | null {
  if (ticket.wa_link_status !== 'pending_confirmation') return null;
  const pending =
    ticket.wa_link_pending !== undefined
      ? ticket.wa_link_pending
      : noted && (!qr || noted.link_code_id === qr.link_code_id)
        ? noted
        : null;
  const linkCodeId = pending?.link_code_id ?? qr?.link_code_id ?? null;
  return linkCodeId ? { linkCodeId, pending } : null;
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
 * D-13 «إعادة الربط بواتساب» (02 D-13: link `none` or `failed`) only when D-07 can act on it: a QR while the
 * ticket is received / parking / parked, or the direct resend to a number this viewer sees on record (the
 * minimal projection shows none, 09 §5.1).
 */
export function canRelink(
  ticket: Pick<TicketDetail, 'status' | 'channel' | 'wa_link_status' | 'customer'>,
): boolean {
  if (ticket.wa_link_status !== 'none' && ticket.wa_link_status !== 'failed') return false;
  const actions = linkActions(ticket);
  return actions.qr || (actions.resend && !!ticket.customer?.phone_masked);
}

/**
 * The park / repark task of this ticket in this driver's hands, if any (02 D-07 «متابعة إلى الصف»; DEC-40's
 * paper conversion is the parking driver's): the ticket's open task shown with him as its assignee, or his
 * current task on the home snapshot. D-07 opened on another driver's ticket (D-13 relink) has none: «العودة».
 */
export function ownParkTask(
  ticket: Pick<TicketDetail, 'id' | 'open_task'>,
  home: Pick<DriverHome, 'current_task'> | undefined,
  userId: string,
): string | null {
  const parking = (type: string) => type === 'park' || type === 'repark';
  const open = ticket.open_task;
  if (open && parking(open.type) && (open.assignee?.id === userId || home?.current_task?.task.id === open.id))
    return open.id;
  const current = home?.current_task;
  return current && current.ticket.id === ticket.id && parking(current.task.type) ? current.task.id : null;
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
