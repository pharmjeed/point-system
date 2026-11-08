import { describe, expect, it } from 'vitest';
import {
  customerMessageIntents,
  type PlannerEvent,
} from '../src/modules/notifications/domain/customer-rules.js';

const T = '0190d2a4-0000-7000-8000-00000000000a';
const C = '0190d2a4-0000-7000-8000-00000000000c';
const K = '0190d2a4-0000-7000-8000-00000000000d';
const TASK = '0190d2a4-0000-7000-8000-00000000000e';
const IN = '0190d2a4-0000-7000-8000-00000000000f';
const CUS = '0190d2a4-0000-7000-8000-000000000010';
const ticket = { ticket_id: T, display_number: 125, ticket_version: 3 };

const ev = (type: string, payload: Record<string, unknown>): PlannerEvent => ({
  id: 'ev1',
  type,
  org_id: 'org',
  venue_id: 'venue',
  payload,
});
const one = (type: string, payload: Record<string, unknown>) => {
  const r = customerMessageIntents(ev(type, payload));
  expect(r).toHaveLength(1);
  return r[0]!;
};

/** PNT-046: the customer column of 14 §3.1 as a pure mapping (12 §5.2 keys). */
describe('NotificationPlanner — WhatsApp customer messages (pure mapping)', () => {
  it('ticket.retrieval_requested → W-02 once per cycle, not after an early request', () => {
    expect(
      one('ticket.retrieval_requested', {
        ticket,
        cycle_id: C,
        cycle_no: 1,
        task_id: TASK,
        requested_early: false,
      }),
    ).toEqual({
      purpose: 'W-02',
      ticketId: T,
      customerId: null,
      dedupeKey: `wa:W-02:${C}`,
      taskId: null,
      refs: { cycle_id: C },
      condition: 'ticket_whatsapp',
    });
    expect(
      customerMessageIntents(
        ev('ticket.retrieval_requested', { ticket, cycle_id: C, requested_early: true }),
      ),
    ).toEqual([]);
  });

  it('ticket.retrieval_requested_early → W-02 keyed by the request instant', () => {
    expect(
      one('ticket.retrieval_requested_early', {
        ticket,
        pending_retrieval_at: '2026-10-27T16:00:05.900Z',
        request_source: 'whatsapp',
      }),
    ).toMatchObject({ purpose: 'W-02', dedupeKey: `wa:W-02:early:${T}:1793116805`, refs: { early: true } });
  });

  it('ticket.assigned_waiting → W-03 with its task; ticket.retrieving → W-04', () => {
    expect(
      one('ticket.assigned_waiting', { ticket, cycle_id: C, task_id: TASK, assignee_id: 'u' }),
    ).toMatchObject({
      purpose: 'W-03',
      dedupeKey: `wa:W-03:${C}`,
      taskId: TASK,
      refs: { cycle_id: C },
    });
    expect(one('ticket.retrieving', { ticket, cycle_id: C, task_id: TASK, retrieved_by: 'u' })).toMatchObject(
      {
        purpose: 'W-04',
        dedupeKey: `wa:W-04:${C}`,
      },
    );
  });

  it('handover.code_issued → W-05 per code (each resend is a new message); the payload has the id only', () => {
    const i = one('handover.code_issued', { ticket_id: T, cycle_id: C, claim_code_id: K, resend_no: 0 });
    expect(i).toMatchObject({
      purpose: 'W-05',
      ticketId: T,
      dedupeKey: `wa:W-05:${K}`,
      refs: { claim_code_id: K, cycle_id: C },
    });
    expect(JSON.stringify(i)).not.toMatch(/"code"|ciphertext/);
  });

  it('ticket.delivered → W-06; ticket.retrieval_canceled → W-07 when the customer was told', () => {
    expect(one('ticket.delivered', { ticket, cycle_id: C, delivered_by: 'u', method: 'code' })).toMatchObject(
      {
        purpose: 'W-06',
        dedupeKey: `wa:W-06:${T}:${C}`,
      },
    );
    expect(
      one('ticket.retrieval_canceled', { ticket, cycle_id: C, previous_status: 'retrieving' }),
    ).toMatchObject({
      purpose: 'W-07',
      dedupeKey: `wa:W-07:${C}`,
      condition: 'cycle_informed',
    });
  });

  it('ticket.reparking → W-08 for customer_absent only; supervisor_cancel sends nothing (DEC-42)', () => {
    expect(
      one('ticket.reparking', {
        ticket,
        closed_cycle_id: C,
        repark_task_id: TASK,
        cause: 'customer_absent',
        reason: 'x',
      }),
    ).toMatchObject({ purpose: 'W-08', dedupeKey: `wa:W-08:${C}`, refs: { cycle_id: C } });
    expect(
      customerMessageIntents(
        ev('ticket.reparking', {
          ticket,
          closed_cycle_id: C,
          repark_task_id: TASK,
          cause: 'supervisor_cancel',
          reason: 'x',
        }),
      ),
    ).toEqual([]);
  });

  it('W-01 from intake (pending_send) and from link changes (direct re-send, QR confirmation), never from provider outcomes', () => {
    expect(
      one('ticket.intake_submitted', { ticket, channel: 'whatsapp', wa_link_status: 'pending_send' }),
    ).toMatchObject({
      purpose: 'W-01',
      dedupeKey: null,
      condition: 'w01',
    });
    expect(
      customerMessageIntents(
        ev('ticket.intake_submitted', { ticket, channel: 'paper', wa_link_status: 'none' }),
      ),
    ).toEqual([]);
    expect(
      one('ticket.wa_link_changed', {
        ticket,
        from: 'failed',
        to: 'pending_send',
        method: 'direct',
        link_version: 3,
      }),
    ).toMatchObject({ purpose: 'W-01', dedupeKey: `wa:W-01:${T}:lv3`, refs: { link_version: 3 } });
    expect(
      one('ticket.wa_link_changed', {
        ticket,
        from: 'pending_confirmation',
        to: 'linked',
        method: 'qr',
        link_version: 2,
      }),
    ).toMatchObject({ dedupeKey: `wa:W-01:${T}:lv2` });
    for (const method of ['provider_accepted', 'button_resume'])
      expect(
        customerMessageIntents(
          ev('ticket.wa_link_changed', {
            ticket,
            from: 'pending_send',
            to: 'linked',
            method,
            link_version: 1,
          }),
        ),
      ).toEqual([]);
    expect(
      customerMessageIntents(
        ev('ticket.wa_link_changed', {
          ticket,
          from: 'linked',
          to: 'opted_out',
          method: 'opt_out',
          link_version: 1,
        }),
      ),
    ).toEqual([]);
  });

  it('wa.button_pressed: status → W-09; inactive button → W-09 inactive; unknown/other sender → W-10 without ticket', () => {
    const press = (outcome: string, extra: Record<string, unknown> = {}) =>
      customerMessageIntents(
        ev('wa.button_pressed', {
          whatsapp_message_id: IN,
          ticket_id: T,
          customer_id: CUS,
          outcome,
          ...extra,
        }),
      );
    expect(press('status_reply')).toEqual([
      {
        purpose: 'W-09',
        ticketId: T,
        customerId: CUS,
        dedupeKey: `wa:W-09:${IN}`,
        taskId: null,
        refs: { variant: 'status', inbound_message_id: IN },
        condition: 'status_reply_throttle',
      },
    ]);
    for (const reason of ['expired', 'revoked', 'stale_link_version'])
      expect(press('rejected', { reject_reason: reason })[0]).toMatchObject({
        purpose: 'W-09',
        refs: { variant: 'inactive' },
      });
    for (const reason of ['unknown_token', 'sender_mismatch'])
      expect(press('rejected', { reject_reason: reason, ticket_id: null })[0]).toMatchObject({
        purpose: 'W-10',
        ticketId: null,
        customerId: CUS,
        dedupeKey: `wa:W-10:${IN}`,
        condition: 'guidance_throttle',
      });
    expect(press('request_created')).toEqual([]);
    expect(press('early_request')).toEqual([]);
  });

  it('wa.inbound_received: free text → W-10, link code → W-11; stop word and buttons answered elsewhere', () => {
    const inbound = (p: Record<string, unknown>) =>
      customerMessageIntents(
        ev('wa.inbound_received', { whatsapp_message_id: IN, customer_id: CUS, ticket_id: null, ...p }),
      );
    expect(inbound({ kind: 'inbound_text', matched: 'none' })[0]).toMatchObject({
      purpose: 'W-10',
      ticketId: null,
    });
    expect(inbound({ kind: 'inbound_other', message_type: 'image', matched: 'none' })[0]).toMatchObject({
      purpose: 'W-10',
    });
    expect(inbound({ kind: 'inbound_other', message_type: 'reaction', matched: 'none' })).toEqual([]); // 12 §6.7
    expect(inbound({ kind: 'inbound_text', matched: 'link_code', link_result: 'invalid' })[0]).toMatchObject({
      purpose: 'W-11',
      ticketId: null,
      refs: { variant: 'invalid', inbound_message_id: IN },
    });
    expect(
      inbound({ kind: 'inbound_text', matched: 'link_code', link_result: 'received', ticket_id: T })[0],
    ).toMatchObject({
      purpose: 'W-11',
      ticketId: T,
      refs: { variant: 'received' },
    });
    expect(inbound({ kind: 'inbound_text', matched: 'opt_out' })).toEqual([]);
    expect(inbound({ kind: 'inbound_button', matched: 'none' })).toEqual([]);
  });

  it('wa.customer_opted_out → W-12 once per opt-out', () => {
    expect(
      one('wa.customer_opted_out', {
        customer_id: CUS,
        affected_ticket_ids: [T],
        opted_out_at: '2026-10-27T16:00:00.000Z',
        inbound_message_id: IN,
      }),
    ).toEqual({
      purpose: 'W-12',
      ticketId: null,
      customerId: CUS,
      dedupeKey: `wa:W-12:${CUS}:1793116800`,
      taskId: null,
      refs: { inbound_message_id: IN },
      condition: 'none',
    });
  });

  it('events without a customer message plan nothing', () => {
    for (const type of [
      'ticket.created',
      'ticket.parked',
      'ticket.assigned',
      'ticket.ready',
      'ticket.voided',
      'ticket.manually_reconciled',
      'ticket.inspection_completed',
      'task.offered',
      'alert.raised',
    ])
      expect(customerMessageIntents(ev(type, { ticket, cycle_id: C }))).toEqual([]);
  });
});
