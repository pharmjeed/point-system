import { describe, expect, it } from 'vitest';
import {
  adminSectionsFor,
  can,
  custodyTransferHolders,
  reconcileTargets,
  relinkMethods,
  ticketActions,
} from '@/features/supervisor/permissions';
import { ago, meWith, task, ticketDetail } from './fixtures';

/** 02 S-03 action table × canon §10 permissions (09 §3): hidden buttons are UX only, the server re-checks. */
const supervisor = meWith('supervisor');
const admin = meWith('admin');
const owner = meWith('owner');

const cycle = {
  id: 'cy-1',
  ticket_id: 't-1',
  cycle_no: 1,
  requested_at: ago(120),
  request_source: 'whatsapp' as const,
  requested_early: false,
};

describe('S-03 action panel (ticketActions)', () => {
  it('offers the «ready» actions to a supervisor', () => {
    const t = ticketDetail({
      status: 'ready',
      wa_link_status: 'linked',
      active_cycle: cycle,
      open_task: task({
        status: 'in_progress',
        started_at: ago(60),
        assignee: { id: 'd-1', full_name: 'خالد' },
      }),
      payment_status: 'due',
    });
    expect(ticketActions(supervisor, t)).toEqual([
      'cancelRetrieval',
      'repark',
      'handoverException',
      'resendCode',
      'custodyTransfer',
      'revealPhone',
      'changePhone',
      'manualReconcile',
      'waiver',
      'openIncident',
    ]);
  });

  it('no resend when the customer is not linked on WhatsApp; no repark before ready', () => {
    const t = ticketDetail({ status: 'ready', wa_link_status: 'failed', active_cycle: cycle });
    expect(ticketActions(supervisor, t)).not.toContain('resendCode');
    const retrieving = ticketDetail({ status: 'retrieving', active_cycle: cycle });
    expect(ticketActions(supervisor, retrieving)).not.toContain('repark');
    expect(ticketActions(supervisor, retrieving)).toContain('cancelRetrieval');
  });

  it('reassign only before the movement starts; release custody once the key was picked up', () => {
    const offered = ticketDetail({
      status: 'requested',
      active_cycle: cycle,
      open_task: task({ status: 'offered' }),
    });
    expect(ticketActions(supervisor, offered)).toContain('reassign');
    const keyPicked = ticketDetail({
      status: 'assigned',
      active_cycle: cycle,
      open_task: task({ status: 'accepted', accepted_at: ago(40), key_picked_up_at: ago(20) }),
    });
    expect(ticketActions(supervisor, keyPicked)).toEqual(
      expect.arrayContaining(['reassign', 'releaseCustody']),
    );
    const moving = ticketDetail({
      status: 'retrieving',
      active_cycle: cycle,
      open_task: task({ status: 'in_progress', started_at: ago(10) }),
    });
    expect(ticketActions(supervisor, moving)).not.toContain('reassign');
    expect(ticketActions(supervisor, moving)).not.toContain('releaseCustody');
  });

  it('void in received/parking only; on-behalf request for a parked ticket without a cycle', () => {
    expect(ticketActions(supervisor, ticketDetail({ status: 'parking' }))).toContain('voidTicket');
    expect(ticketActions(supervisor, ticketDetail({ status: 'parked' }))).not.toContain('voidTicket');
    expect(ticketActions(supervisor, ticketDetail({ status: 'parked' }))).toContain('onBehalf');
    expect(ticketActions(supervisor, ticketDetail({ status: 'parked', active_cycle: cycle }))).not.toContain(
      'onBehalf',
    );
  });

  it('inspection exception for an incomplete inspection; reverse for a recorded payment', () => {
    expect(ticketActions(supervisor, ticketDetail({ inspection_status: 'incomplete' }))).toContain(
      'inspectionException',
    );
    const paid = ticketDetail({
      status: 'delivered',
      payment_status: 'collected',
      payment: {
        id: 'p-1',
        ticket_id: 't-1',
        event_id: 'e-1',
        method: 'cash',
        amount_halalas: 2500,
        currency: 'SAR',
        collected_by: { id: 'd-1', full_name: 'خالد' },
        collected_at: ago(30),
        status: 'recorded',
      },
    });
    expect(ticketActions(supervisor, paid)).toContain('reverse');
    expect(ticketActions(admin, paid)).toContain('reverse');
    expect(ticketActions(owner, paid)).not.toContain('reverse');
  });

  it('the admin and the owner see only their own rows of the matrix', () => {
    const t = ticketDetail({
      status: 'ready',
      wa_link_status: 'linked',
      active_cycle: cycle,
      open_task: task({ status: 'offered' }),
      payment_status: 'due',
    });
    // canon §10: the administration also changes the phone and reconciles after an outage (no wa.link)
    expect(ticketActions(admin, t)).toEqual([
      'revealPhone',
      'changePhone',
      'manualReconcile',
      'openIncident',
    ]);
    expect(ticketActions(owner, t)).toEqual(['revealPhone']);
    expect(ticketActions({ ...supervisor, permissions: ['auth.self'] }, t)).toEqual([]);
  });

  it('record payment only for the supervisor who is the assignee (D* while driving)', () => {
    const t = ticketDetail({
      status: 'ready',
      payment_status: 'due',
      active_cycle: cycle,
      open_task: task({
        status: 'in_progress',
        started_at: ago(5),
        assignee: { id: 'u-supervisor', full_name: 'أنا' },
      }),
    });
    expect(ticketActions(supervisor, t)).not.toContain('recordPayment');
    expect(ticketActions(meWith('supervisor', ['payment.record']), t)).toContain('recordPayment');
    const other = {
      ...t,
      open_task: task({ status: 'in_progress', assignee: { id: 'd-9', full_name: 'آخر' } }),
    };
    expect(ticketActions(meWith('supervisor', ['payment.record']), other)).not.toContain('recordPayment');
  });

  it('no reveal without a masked phone (paper ticket)', () => {
    expect(ticketActions(supervisor, ticketDetail({ channel: 'paper', customer: null }))).not.toContain(
      'revealPhone',
    );
  });
});

describe('S-03 recovery actions (GAP-2: 02 S-03 table × canon §10)', () => {
  it('«تغيير الجوال»: an open WhatsApp ticket after the intake, for the supervisor and the administration', () => {
    const parked = ticketDetail({ status: 'parked' });
    expect(ticketActions(supervisor, parked)).toContain('changePhone');
    expect(ticketActions(admin, parked)).toContain('changePhone');
    expect(ticketActions(owner, parked)).not.toContain('changePhone');
    // a draft's number is edited by PATCH /intake, a paper ticket has no conversation (DEC-211); closed: nothing
    expect(ticketActions(supervisor, ticketDetail({ status: 'received' }))).not.toContain('changePhone');
    expect(ticketActions(supervisor, ticketDetail({ channel: 'paper' }))).not.toContain('changePhone');
    expect(ticketActions(supervisor, ticketDetail({ status: 'delivered' }))).not.toContain('changePhone');
  });

  it('«إعادة الربط بواتساب»: the supervisor only (wa.link), none/failed, an opt-out by QR, a pending match', () => {
    const failed = ticketDetail({ status: 'parked', wa_link_status: 'failed' });
    expect(ticketActions(supervisor, failed)).toContain('relinkWhatsApp');
    expect(ticketActions(admin, failed)).not.toContain('relinkWhatsApp');
    expect(relinkMethods(failed)).toEqual({ direct: true, qr: true, confirm: false });
    // after the parking only the direct send is left (QR is for received/parking/parked, DEC-196)
    expect(relinkMethods(ticketDetail({ status: 'requested', wa_link_status: 'none' }))).toEqual({
      direct: true,
      qr: false,
      confirm: false,
    });
    // a draft links directly at submit-intake: QR only (DEC-193)
    expect(relinkMethods(ticketDetail({ status: 'received', wa_link_status: 'none' }))).toEqual({
      direct: false,
      qr: true,
      confirm: false,
    });
    // an opt-out comes back only on the customer's own initiative (12 §7.6)
    const optedOut = ticketDetail({
      status: 'parked',
      wa_link_status: 'opted_out',
      customer: { phone_masked: '05•••••123', opted_out: true },
    });
    expect(relinkMethods(optedOut)).toEqual({ direct: false, qr: true, confirm: false });
    expect(ticketActions(supervisor, optedOut)).toContain('relinkWhatsApp');
    const optedOutRequested = { ...optedOut, status: 'requested' as const };
    expect(ticketActions(supervisor, optedOutRequested)).not.toContain('relinkWhatsApp');
    // no number on the ticket: no direct send
    expect(
      relinkMethods(ticketDetail({ status: 'parked', wa_link_status: 'none', customer: null })).direct,
    ).toBe(false);
    // a QR message waits for «هل هو جوال العميل الذي أمامك؟» (DEC-198)
    const pending = ticketDetail({
      status: 'parked',
      wa_link_status: 'pending_confirmation',
      wa_link_pending: { link_code_id: 'lc-1', inbound_phone_masked: '05•••••777', received_at: ago(5) },
    });
    expect(relinkMethods(pending)).toEqual({ direct: false, qr: false, confirm: true });
    expect(ticketActions(supervisor, pending)).toContain('relinkWhatsApp');
    expect(ticketActions(supervisor, ticketDetail({ wa_link_status: 'linked' }))).not.toContain(
      'relinkWhatsApp',
    );
    expect(
      ticketActions(supervisor, ticketDetail({ channel: 'paper', wa_link_status: 'none' })),
    ).not.toContain('relinkWhatsApp');
  });

  it('«مطابقة يدوية بعد انقطاع»: any open ticket, supervisor and administration; the targets the server allows', () => {
    expect(ticketActions(supervisor, ticketDetail({ status: 'ready' }))).toContain('manualReconcile');
    expect(ticketActions(admin, ticketDetail({ status: 'parking' }))).toContain('manualReconcile');
    expect(ticketActions(owner, ticketDetail({ status: 'parked' }))).not.toContain('manualReconcile');
    expect(ticketActions(supervisor, ticketDetail({ status: 'delivered' }))).not.toContain('manualReconcile');
    expect(reconcileTargets(ticketDetail({ status: 'parked' }))).toEqual(['parked', 'delivered', 'voided']);
    // a paper ticket without its stub number only to voided (`paper_serial_missing`, DEC-253)
    expect(reconcileTargets(ticketDetail({ channel: 'paper', paper_serial: null }))).toEqual(['voided']);
    expect(reconcileTargets(ticketDetail({ channel: 'paper', paper_serial: '004521' }))).toEqual([
      'parked',
      'delivered',
      'voided',
    ]);
    // a recorded payment forbids voided (13 §8.6, `payment_recorded`)
    expect(reconcileTargets(ticketDetail({ status: 'ready', payment_status: 'collected' }))).toEqual([
      'parked',
      'delivered',
    ]);
    expect(reconcileTargets(ticketDetail({ status: 'voided' }))).toEqual([]);
  });
});

describe('S-03 custody transfer holders (DEC-250, DEC-328)', () => {
  it('a parked vehicle goes only to a free spot; a moving one and a key also to a driver or the supervisor', () => {
    expect(custodyTransferHolders('vehicle', { status: 'parked' })).toEqual(['spot']);
    expect(custodyTransferHolders('vehicle', { status: 'retrieving' })).toEqual([
      'driver',
      'supervisor',
      'spot',
    ]);
    expect(custodyTransferHolders('vehicle', { status: 'parking' })).toEqual([
      'driver',
      'supervisor',
      'spot',
    ]);
    expect(custodyTransferHolders('key', { status: 'parked' })).toEqual(['driver', 'supervisor', 'key_slot']);
  });
});

describe('S-13 sections per role (02 §2.2)', () => {
  it('owner: all; admin: no org settings; supervisor: none', () => {
    expect(adminSectionsFor(owner)).toEqual([
      'staff',
      'channel',
      'templates',
      'outbox',
      'audit',
      'retention',
      'org',
    ]);
    expect(adminSectionsFor(admin)).toEqual([
      'staff',
      'channel',
      'templates',
      'outbox',
      'audit',
      'retention',
    ]);
    expect(adminSectionsFor(supervisor)).toEqual([]);
  });

  it('can() reads /v1/me.permissions only', () => {
    expect(can(owner, 'org.settings_manage')).toBe(true);
    expect(can(admin, 'org.settings_manage')).toBe(false);
    expect(can(supervisor, 'alert.manage')).toBe(true);
  });
});
