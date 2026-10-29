import { describe, expect, it } from 'vitest';
import { WS_SERVER_EVENTS } from '@shared/canon/events';
import { parseHeartbeatAck, parseServerEvent } from '@/realtime/protocol';
import { IDS, offerCard, taskCard } from './fixtures';

const frame = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  id: globalThis.crypto.randomUUID(),
  type,
  occurred_at: '2026-10-29T18:00:00.000Z',
  org_id: IDS.org,
  venue_id: IDS.venue,
  dispatch_pool_id: null,
  event_id: IDS.event,
  aggregate: null,
  actor: { type: 'user', id: IDS.other },
  payload,
  ...extra,
});

const summary = {
  id: IDS.ticketA,
  display_number: 125,
  event_id: IDS.event,
  venue_id: IDS.venue,
  status: 'ready',
  channel: 'paper',
  plate: { country: 'SA', digits: '1234', letters_ar: 'ب ح د', letters_en: 'B J D', display: '1234 ب ح د' },
  wa_link_status: 'none',
  payment_status: 'not_required',
  version: 7,
};

describe('socket frames are parsed with the canon schemas (07 §4.2, PNT-065)', () => {
  it('covers every server event of canon §7.3', () => {
    for (const type of WS_SERVER_EVENTS) {
      const result = parseServerEvent(type, { id: 'x' });
      expect(result.ok, type).toBe(false);
      if (!result.ok) expect(result.reason, type).toBe('invalid');
    }
  });

  it('accepts the published shapes', () => {
    const cases: Array<[string, unknown, Record<string, unknown>?]> = [
      [
        'ticket.updated',
        { ...summary, cause: 'ticket.ready' },
        { aggregate: { type: 'ticket', id: IDS.ticketA, version: 7 } },
      ],
      [
        'task.offered',
        { cause: 'task.offered', ...offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:59:00.000Z') },
      ],
      [
        'task.claimed',
        {
          cause: 'task.claimed',
          task_id: IDS.taskA,
          offer_ids: [IDS.offerA],
          result: 'accepted',
          claimed_by: null,
        },
      ],
      ['task.updated', { cause: 'task.promoted', ...taskCard(IDS.taskA, 'accepted', 4) }],
      [
        'task.updated',
        {
          cause: 'task.withdrawn',
          id: IDS.taskA,
          ticket_id: IDS.ticketA,
          type: 'retrieve',
          status: 'queued',
          version: 5,
        },
      ],
      [
        'offer.closed',
        { cause: 'offer.expired', offer_id: IDS.offerA, task_id: IDS.taskA, close_reason: 'expired' },
      ],
      [
        'channel.status',
        { cause: 'wa.channel_health_changed', whatsapp: 'down', changed_at: '2026-10-29T18:00:00.000Z' },
      ],
      ['sync.required', { reason: 'shift_status_changed', scope: 'home', cause: 'shift.closed' }],
      ['session.revoked', { reason: 'transfer' }],
      [
        'driver.state_changed',
        { cause: 'driver.break_started', driver: { id: IDS.me, full_name: 'س' }, driver_state: 'on_break' },
      ],
    ];
    for (const [type, payload, extra] of cases) {
      const result = parseServerEvent(type, frame(type, payload, extra));
      expect(result.ok, type).toBe(true);
    }
  });

  it('refuses a TicketSummary carrying a field outside 09 §5.1 (a phone, a key slot)', () => {
    for (const leak of [{ customer_phone: '+966500000001' }, { current_key_slot: { label: '12' } }]) {
      const result = parseServerEvent(
        'ticket.updated',
        frame('ticket.updated', { ...summary, cause: 'ticket.ready', ...leak }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('an unknown event name is not an error to resync for', () => {
    expect(parseServerEvent('task.teleported', frame('task.teleported', {}))).toMatchObject({
      ok: false,
      reason: 'unknown_event',
    });
  });

  it('reads the heartbeat ack `{data: …}` and refuses error acks', () => {
    expect(
      parseHeartbeatAck({
        data: { server_time: '2026-10-29T18:00:00.000Z', connection_state: 'online', sync_required: false },
      }),
    ).toEqual({ server_time: '2026-10-29T18:00:00.000Z', connection_state: 'online', sync_required: false });
    expect(parseHeartbeatAck({ error: { code: 'INTERNAL_ERROR' } })).toBeNull();
  });
});
