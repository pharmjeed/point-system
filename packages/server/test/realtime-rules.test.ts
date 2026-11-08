import { describe, expect, it } from 'vitest';
import type { PlannerEvent } from '../src/modules/notifications/domain/customer-rules.js';
import { ticketUpdateRequests } from '../src/modules/notifications/domain/realtime-rules.js';

const T = '0190d2a4-0000-7000-8000-00000000000a';
const A = '0190d2a4-0000-7000-8000-0000000000a1';
const B = '0190d2a4-0000-7000-8000-0000000000b2';
const M = '0190d2a4-0000-7000-8000-0000000000e1';
const ticket = { ticket_id: T, display_number: 125, ticket_version: 3 };

const ev = (
  type: string,
  payload: Record<string, unknown>,
  aggregate?: PlannerEvent['aggregate'],
): PlannerEvent => ({
  id: 'e',
  type,
  org_id: 'o',
  venue_id: 'v',
  payload,
  ...(aggregate ? { aggregate } : {}),
});

// 14 §3 «السائق» / «المشرف» ticket.updated cells (07 §4.3) as a pure mapping.
describe('ticket.updated requests', () => {
  it('every ticket.* event, with the creator for the intake/link events', () => {
    expect(ticketUpdateRequests(ev('ticket.created', { ticket, created_by: A, park_task_id: B }))).toEqual([
      {
        ticketId: T,
        cause: 'ticket.created',
        extraUserIds: [],
        creator: true,
        supervisorsOnly: false,
        message: null,
      },
    ]);
    expect(ticketUpdateRequests(ev('ticket.parked', { ticket }))).toMatchObject([{ creator: false }]);
    for (const type of [
      'ticket.intake_submitted',
      'ticket.wa_link_changed',
      'ticket.customer_phone_changed',
      'ticket.inspection_completed',
      'ticket.voided',
    ])
      expect(ticketUpdateRequests(ev(type, { ticket }))).toMatchObject([{ cause: type, creator: true }]);
    // the aggregate names the ticket when the payload has no TicketRef
    expect(
      ticketUpdateRequests(ev('ticket.manually_reconciled', {}, { type: 'ticket', id: T, version: 5 })),
    ).toMatchObject([{ ticketId: T }]);
  });

  it('the parking driver of an early request and the holder of a repark are concerned', () => {
    expect(
      ticketUpdateRequests(
        ev('ticket.retrieval_requested_early', {
          ticket,
          parking_task_assignee_id: A,
          request_source: 'whatsapp',
        }),
      ),
    ).toMatchObject([{ extraUserIds: [A] }]);
    expect(
      ticketUpdateRequests(ev('ticket.reparking', { ticket, assignee_id: B, cause: 'customer_absent' })),
    ).toMatchObject([{ extraUserIds: [B] }]);
  });

  it('custody: the previous and the new driver holder (14 §3.4); payments: the collector', () => {
    expect(
      ticketUpdateRequests(
        ev('custody.changed', {
          ticket_id: T,
          subject: 'key',
          from: { type: 'key_slot', id: M },
          to: { type: 'driver', id: A },
        }),
      ),
    ).toMatchObject([{ cause: 'custody.changed', extraUserIds: [A] }]);
    expect(
      ticketUpdateRequests(
        ev('custody.changed', {
          ticket_id: T,
          from: { type: 'driver', id: A },
          to: { type: 'driver', id: B },
        }),
      ),
    ).toMatchObject([{ extraUserIds: [A, B] }]);
    expect(ticketUpdateRequests(ev('payment.recorded', { ticket_id: T, collected_by: A }))).toMatchObject([
      { extraUserIds: [A] },
    ]);
    for (const type of [
      'handover.code_issued',
      'handover.code_locked',
      'handover.completed',
      'payment.waived',
    ])
      expect(ticketUpdateRequests(ev(type, { ticket_id: T }))).toMatchObject([{ cause: type }]);
  });

  it('incidents linked to a ticket: supervisors only; unlinked: none', () => {
    expect(ticketUpdateRequests(ev('incident.opened', { incident_id: M, ticket_id: T }))).toMatchObject([
      { supervisorsOnly: true, cause: 'incident.opened' },
    ]);
    expect(ticketUpdateRequests(ev('incident.updated', { incident_id: M, ticket_id: null }))).toEqual([]);
  });

  it('WhatsApp delivery states carry the message; W-01 concerns the creator', () => {
    expect(
      ticketUpdateRequests(
        ev('wa.message_status_changed', {
          whatsapp_message_id: M,
          ticket_id: T,
          purpose: 'W-01',
          status: 'failed',
          status_rank: 1,
          error_code: '131026',
        }),
      ),
    ).toEqual([
      {
        ticketId: T,
        cause: 'wa.message_status_changed',
        extraUserIds: [],
        creator: true,
        supervisorsOnly: false,
        message: { id: M, purpose: 'W-01', status: 'failed', status_rank: 1 },
      },
    ]);
    expect(
      ticketUpdateRequests(
        ev('wa.message_status_changed', { whatsapp_message_id: M, ticket_id: null, status: 'read' }),
      ),
    ).toEqual([]);
  });

  it('dispatch, driver and alert events are not this planner’s', () => {
    for (const type of [
      'task.claimed',
      'task.updated',
      'offer.expired',
      'driver.duty_started',
      'alert.raised',
    ])
      expect(ticketUpdateRequests(ev(type, { ticket_id: T, ticket }))).toEqual([]);
  });
});
