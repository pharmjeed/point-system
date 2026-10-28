import { describe, expect, it } from 'vitest';
import { adminSectionsFor, can, ticketActions } from '@/features/supervisor/permissions';
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
    expect(ticketActions(admin, t)).toEqual(['revealPhone', 'openIncident']);
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

describe('S-13 sections per role (02 §2.2)', () => {
  it('owner: all; admin: no org settings; supervisor: none', () => {
    expect(adminSectionsFor(owner)).toEqual(['channel', 'templates', 'outbox', 'audit', 'retention', 'org']);
    expect(adminSectionsFor(admin)).toEqual(['channel', 'templates', 'outbox', 'audit', 'retention']);
    expect(adminSectionsFor(supervisor)).toEqual([]);
  });

  it('can() reads /v1/me.permissions only', () => {
    expect(can(owner, 'org.settings_manage')).toBe(true);
    expect(can(admin, 'org.settings_manage')).toBe(false);
    expect(can(supervisor, 'alert.manage')).toBe(true);
  });
});
