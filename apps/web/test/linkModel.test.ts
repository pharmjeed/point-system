import { describe, expect, it } from 'vitest';
import type { DriverHome, LinkCodeQr, Task, TaskCard, TicketDetail } from '@/api/types';
import {
  canRelink,
  channelBody,
  channelForm,
  channelIssues,
  DEFAULT_CHANNEL_FORM,
  keepsRecordedPhone,
  linkActions,
  linkBody,
  linkMode,
  needsQrAtSubmit,
  ownParkTask,
  pendingConfirmation,
  phoneTail,
  qrRemainingMs,
  QR_REUSE_MIN_MS,
  reusableQr,
  type ChannelForm,
} from '@/features/driver/linkModel';

/** The WhatsApp link rules of D-05, D-06 and D-07 (02 D-05 «قناة العميل», D-06 QR before submit, D-07 modes). */
const form = (patch: Partial<ChannelForm>): ChannelForm => ({ ...DEFAULT_CHANNEL_FORM, ...patch });

type LinkTicket = Pick<TicketDetail, 'status' | 'channel' | 'wa_link_status' | 'customer' | 'paper_serial'>;
const ticket = (patch: Partial<LinkTicket>): LinkTicket => ({
  status: 'parking',
  channel: 'whatsapp',
  wa_link_status: 'none',
  customer: null,
  paper_serial: null,
  ...patch,
});

const qr = (patch: Partial<LinkCodeQr> = {}): LinkCodeQr => ({
  link_code_id: '0f9a4c1e-7d55-4f5e-9a51-2b1d3c4e5f60',
  code: 'K7Q2M9',
  status: 'active',
  expires_at: '2026-06-01T18:10:00.000Z',
  wa_me_url: 'https://wa.me/966500000000?text=K7Q2M9',
  prefilled_text: 'K7Q2M9',
  qr_text: 'https://wa.me/966500000000?text=K7Q2M9',
  ...patch,
});

describe('D-05 channel body (PATCH …/intake)', () => {
  it('direct: the E.164 number and the verbal consent; no stub number', () => {
    expect(channelBody(form({ phone: '0501234567', consent: true }), '+966501234567')).toEqual({
      channel: 'whatsapp',
      customer_phone: '+966501234567',
      consent: { method: 'verbal_staff_confirmed', confirmed: true },
      paper_serial: null,
    });
  });

  it('direct without the box ticked sends no consent (the server answers CONSENT_REQUIRED at submit)', () => {
    expect(channelBody(form({ consent: false }), '+966501234567').consent).toBeNull();
  });

  it('QR: no number and no consent (02 D-05: switching to QR empties both)', () => {
    expect(channelBody(form({ method: 'qr', phone: '0501234567', consent: true }), '+966501234567')).toEqual({
      channel: 'whatsapp',
      customer_phone: null,
      consent: null,
      paper_serial: null,
    });
  });

  it('paper: the trimmed stub number, never the customer number typed before (05 §14)', () => {
    expect(
      channelBody(
        form({ channel: 'paper', paperSerial: ' 004521 ', phone: '0501234567', consent: true }),
        '+966501234567',
      ),
    ).toEqual({ channel: 'paper', paper_serial: '004521', customer_phone: null, consent: null });
  });
});

describe('D-05 local checks before «التالي» (DEC-356)', () => {
  it('direct: phone and consent are mandatory', () => {
    expect(channelIssues(form({}), null)).toEqual(['phone', 'consent']);
    expect(channelIssues(form({ consent: true }), null)).toEqual(['phone']);
    expect(channelIssues(form({}), '+966501234567')).toEqual(['consent']);
    expect(channelIssues(form({ consent: true }), '+966501234567')).toEqual([]);
  });

  it('QR asks nothing; paper asks the stub number', () => {
    expect(channelIssues(form({ method: 'qr' }), null)).toEqual([]);
    expect(channelIssues(form({ channel: 'paper', paperSerial: '  ' }), null)).toEqual(['paper_serial']);
    expect(channelIssues(form({ channel: 'paper', paperSerial: '7' }), null)).toEqual([]);
  });

  it('the form starts from the local draft, else from the ticket (WhatsApp by number by default)', () => {
    expect(channelForm(ticket({ status: 'received' }), {})).toEqual(DEFAULT_CHANNEL_FORM);
    expect(channelForm(ticket({ channel: 'paper', paper_serial: '0045' }), {})).toMatchObject({
      channel: 'paper',
      paperSerial: '0045',
    });
    expect(channelForm(ticket({}), { method: 'qr', phone: '', consent: false })).toMatchObject({
      method: 'qr',
    });
  });

  it('a draft saved before the WhatsApp choice existed (a stub number only) comes back as paper', () => {
    expect(channelForm(ticket({ status: 'received' }), { paperSerial: '004521' })).toMatchObject({
      channel: 'paper',
      paperSerial: '004521',
    });
    expect(channelForm(ticket({}), { channel: 'whatsapp', paperSerial: '004521' }).channel).toBe('whatsapp');
  });

  it("without this device's draft the method follows the number on record (a QR draft stays QR)", () => {
    const saved = { plate: { country: 'SA', digits: '1234', display: '1234' } } as Partial<TicketDetail>;
    // saved in the QR mode: WhatsApp, the first step on the server, no number
    expect(channelForm({ ...ticket({ status: 'received' }), ...saved }, {}).method).toBe('qr');
    // saved with a number: direct
    expect(
      channelForm(
        { ...ticket({ status: 'received', customer: { phone_masked: '05•••••567' } }), ...saved },
        {},
      ).method,
    ).toBe('direct');
    // a fresh draft (nothing saved yet) starts with «رقم جوال العميل» (02 D-05)
    expect(channelForm(ticket({ status: 'received' }), {}).method).toBe('direct');
    // this device's choice wins
    expect(channelForm({ ...ticket({ status: 'received' }), ...saved }, { method: 'direct' }).method).toBe(
      'direct',
    );
  });

  it('a number on record without the local copy is kept: nothing to type, neither it nor the consent sent', () => {
    const recorded = '05•••••567';
    expect(keepsRecordedPhone(form({}), recorded)).toBe(true);
    expect(keepsRecordedPhone(form({ phone: '0501112222' }), recorded)).toBe(false);
    expect(keepsRecordedPhone(form({ method: 'qr' }), recorded)).toBe(false);
    expect(keepsRecordedPhone(form({}), null)).toBe(false);
    expect(channelIssues(form({}), null, recorded)).toEqual([]);
    expect(channelBody(form({}), null, recorded)).toEqual({ channel: 'whatsapp', paper_serial: null });
    // another number typed: the number and a new consent are needed again
    expect(channelIssues(form({ phone: '0501112222' }), '+966501112222', recorded)).toEqual(['consent']);
    // QR still empties the number on record (02 D-05)
    expect(channelBody(form({ method: 'qr' }), null, recorded)).toMatchObject({ customer_phone: null });
  });
});

describe('D-06 QR right before the submit', () => {
  it('a WhatsApp draft without a number needs a code; one with a number links directly', () => {
    expect(needsQrAtSubmit(ticket({ status: 'received' }))).toBe(true);
    expect(needsQrAtSubmit(ticket({ customer: { phone_masked: '05•••••567' } }))).toBe(false);
    expect(needsQrAtSubmit(ticket({ channel: 'paper' }))).toBe(false);
  });

  it('a code already waiting for the driver or a linked ticket needs none (submit-intake takes it)', () => {
    expect(needsQrAtSubmit(ticket({ wa_link_status: 'pending_confirmation' }))).toBe(false);
    expect(needsQrAtSubmit(ticket({ wa_link_status: 'linked' }))).toBe(false);
  });

  it('a code in memory is reused only while active with a minute left (server time)', () => {
    const now = Date.parse('2026-06-01T18:00:00.000Z');
    expect(reusableQr(qr(), now)).not.toBeNull();
    expect(reusableQr(qr({ expires_at: new Date(now + QR_REUSE_MIN_MS - 1).toISOString() }), now)).toBeNull();
    expect(reusableQr(qr({ status: 'pending_confirmation' }), now)).toBeNull();
    expect(reusableQr(undefined, now)).toBeNull();
    expect(qrRemainingMs(qr(), now)).toBe(10 * 60_000);
    expect(qrRemainingMs(qr(), now + 11 * 60_000)).toBe(0);
  });
});

describe('D-07 mode and actions', () => {
  it('paper → ج; a message waiting for «هل هو جوال العميل…؟» → ب; then the chosen method', () => {
    expect(linkMode(ticket({ channel: 'paper' }), 'qr', true)).toBe('paper');
    expect(linkMode(ticket({ wa_link_status: 'pending_confirmation' }), 'direct', false)).toBe('qr');
    expect(linkMode(ticket({}), 'qr', false)).toBe('qr');
    expect(linkMode(ticket({}), 'direct', true)).toBe('direct');
  });

  it('without a choice in memory (a reload): a code, a send in progress, then the number on record', () => {
    expect(linkMode(ticket({}), undefined, true)).toBe('qr');
    expect(linkMode(ticket({ wa_link_status: 'failed' }), undefined, false)).toBe('direct');
    expect(linkMode(ticket({ customer: { phone_masked: '05•••••567' } }), undefined, false)).toBe('direct');
    expect(linkMode(ticket({}), undefined, false)).toBe('qr');
  });

  it('«إعادة الإرسال» after the intake from none / failed / pending_send (DEC-193)', () => {
    expect(linkActions(ticket({ wa_link_status: 'failed' })).resend).toBe(true);
    expect(linkActions(ticket({ wa_link_status: 'linked' })).resend).toBe(false);
    expect(linkActions(ticket({ wa_link_status: 'opted_out' })).resend).toBe(false);
    expect(linkActions(ticket({ status: 'received', wa_link_status: 'failed' })).resend).toBe(false);
  });

  it('«الربط عبر QR» while received / parking / parked, also after an opt-out (12 §7.6)', () => {
    expect(linkActions(ticket({ wa_link_status: 'opted_out' })).qr).toBe(true);
    expect(linkActions(ticket({ status: 'parked' })).qr).toBe(true);
    expect(linkActions(ticket({ status: 'requested' })).qr).toBe(false);
    expect(linkActions(ticket({ wa_link_status: 'pending_confirmation' })).qr).toBe(false);
  });

  it('«تذكرة ورقية» only during parking while not linked (DEC-40); nothing on a paper or closed ticket', () => {
    expect(linkActions(ticket({ wa_link_status: 'failed' })).paper).toBe(true);
    expect(linkActions(ticket({ wa_link_status: 'linked' })).paper).toBe(false);
    expect(linkActions(ticket({ status: 'parked' })).paper).toBe(false);
    expect(linkActions(ticket({ channel: 'paper' }))).toEqual({ resend: false, qr: false, paper: false });
    expect(linkActions(ticket({ status: 'delivered' }))).toEqual({ resend: false, qr: false, paper: false });
  });

  it('the last three digits of a masked number (09 §5.1: never the full number)', () => {
    expect(phoneTail('05•••••567')).toBe('567');
    expect(phoneTail('')).toBe('');
    expect(phoneTail(undefined)).toBe('');
  });
});

describe('D-07 body (review: the QR method shows the panel until the ticket is linked)', () => {
  it('a code issued while W-01 is pending keeps the panel — also once it expired; linked → mode أ', () => {
    expect(linkBody('qr', 'pending_send')).toBe('panel');
    expect(linkBody('qr', 'none')).toBe('panel');
    expect(linkBody('qr', 'failed')).toBe('panel');
    expect(linkBody('qr', 'pending_confirmation')).toBe('panel');
    expect(linkBody('qr', 'linked')).toBe('status');
    expect(linkBody('direct', 'pending_send')).toBe('status');
    expect(linkBody('direct', 'failed')).toBe('status');
    expect(linkBody('paper', 'none')).toBe('paper');
  });
});

describe('D-07 pending confirmation (review: a stale message never answers for a newer code)', () => {
  const c1 = { link_code_id: 'c1', inbound_phone_masked: '05•••••887', received_at: '2026-06-01T18:00:00Z' };
  const c2 = { ...c1, link_code_id: 'c2', inbound_phone_masked: '05•••••223' };

  it('the projection decides when it carries the field (null = none)', () => {
    const t = { wa_link_status: 'pending_confirmation' as const, wa_link_pending: c2 };
    expect(pendingConfirmation(t, c1, qr({ link_code_id: 'c2' }))).toEqual({ linkCodeId: 'c2', pending: c2 });
  });

  it('a noted message for another code than the one issued since is ignored; the issued code answers', () => {
    const t = { wa_link_status: 'pending_confirmation' as const };
    expect(pendingConfirmation(t, c1, qr({ link_code_id: 'c2' }))).toEqual({
      linkCodeId: 'c2',
      pending: null,
    });
    expect(pendingConfirmation(t, c2, qr({ link_code_id: 'c2' }))).toEqual({ linkCodeId: 'c2', pending: c2 });
    // no code issued here (the creator of a parked ticket): the noted message
    expect(pendingConfirmation(t, c1, undefined)).toEqual({ linkCodeId: 'c1', pending: c1 });
    expect(pendingConfirmation(t, null, undefined)).toBeNull();
  });

  it('nothing to confirm unless a message waits', () => {
    expect(pendingConfirmation({ wa_link_status: 'none' }, c1, qr())).toBeNull();
  });
});

describe('D-13 relink and D-07 own task (review)', () => {
  it('«إعادة الربط بواتساب» only when D-07 can act: a QR until parked, or a resend to a number on record', () => {
    expect(canRelink(ticket({ status: 'parked', wa_link_status: 'failed' }))).toBe(true);
    expect(canRelink(ticket({ status: 'requested', wa_link_status: 'failed' }))).toBe(false);
    expect(
      canRelink(
        ticket({ status: 'requested', wa_link_status: 'failed', customer: { phone_masked: '05•••••567' } }),
      ),
    ).toBe(true);
    expect(canRelink(ticket({ status: 'parked', wa_link_status: 'linked' }))).toBe(false);
    expect(canRelink(ticket({ status: 'parked', wa_link_status: 'pending_send' }))).toBe(false);
  });

  const task = (patch: Partial<Task>): Task => ({
    id: 'park-1',
    ticket_id: 't1',
    type: 'park',
    status: 'in_progress',
    priority_at: '2026-06-01T18:00:00Z',
    seq: 1,
    version: 1,
    ...patch,
  });
  const home = (current: Partial<TaskCard> | null): Pick<DriverHome, 'current_task'> => ({
    current_task: current as TaskCard | null,
  });

  it("«متابعة إلى الصف» and the paper stub only on the park task in this driver's hands", () => {
    const mine = { id: 't1', open_task: task({ assignee: { id: 'me', full_name: 'أحمد' } }) };
    expect(ownParkTask(mine, undefined, 'me')).toBe('park-1');
    // another driver's park task: the assignee is hidden from the minimal projection
    const theirs = { id: 't1', open_task: task({ assignee: null }) };
    expect(ownParkTask(theirs, home(null), 'me')).toBeNull();
    // the home snapshot's current task (the detail may not show the assignee yet)
    expect(
      ownParkTask(theirs, home({ task: task({}), ticket: { id: 't1' } as TaskCard['ticket'] }), 'me'),
    ).toBe('park-1');
    // a retrieval is not a parking task
    const retrieval = task({ type: 'retrieve', assignee: { id: 'me', full_name: 'أحمد' } });
    expect(ownParkTask({ id: 't1', open_task: retrieval }, undefined, 'me')).toBeNull();
  });
});
