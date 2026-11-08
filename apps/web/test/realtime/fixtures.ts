import type { DriverHome, OfferCard, TaskCard } from '@/api/types';

/** Builders of the 07 shapes the live driver tests use (ids are fixed UUIDs). */
export const IDS = {
  me: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  taskA: 'aaaaaaaa-0000-4000-8000-00000000000a',
  taskB: 'bbbbbbbb-0000-4000-8000-00000000000b',
  taskC: 'cccccccc-0000-4000-8000-00000000000c',
  ticketA: 'aaaaaaaa-1111-4111-8111-00000000000a',
  ticketB: 'bbbbbbbb-1111-4111-8111-00000000000b',
  offerA: 'aaaaaaaa-2222-4222-8222-00000000000a',
  offerB: 'bbbbbbbb-2222-4222-8222-00000000000b',
  offerC: 'cccccccc-2222-4222-8222-00000000000c',
  org: '99999999-9999-4999-8999-999999999999',
  venue: '88888888-8888-4888-8888-888888888888',
  event: '77777777-7777-4777-8777-777777777777',
};

export function home(patch: Partial<DriverHome> = {}): DriverHome {
  return {
    server_time: '2026-10-29T18:00:00.000Z',
    user: { id: IDS.me, full_name: 'سائق', employee_code: 'D-1' },
    venue: { id: IDS.venue, code: 'RMS', name_ar: 'قاعة' },
    open_events: [{ id: IDS.event, name_ar: 'حفل', status: 'open' }],
    shift_open: true,
    driver_state: 'available',
    current_task: null,
    next_task: null,
    offer: null,
    checks: {},
    channel_health: 'healthy',
    ...patch,
  };
}

export function taskCard(
  taskId: string,
  status: TaskCard['task']['status'],
  version: number,
  ticketId = IDS.ticketA,
  displayNumber = 125,
): TaskCard {
  return {
    task: {
      id: taskId,
      ticket_id: ticketId,
      type: 'retrieve',
      status,
      priority_at: '2026-10-29T17:59:00.000Z',
      seq: 1,
      version,
    },
    ticket: { id: ticketId, display_number: displayNumber, status: 'assigned', version: 3 },
    requested_at: '2026-10-29T17:59:00.000Z',
  };
}

export function offerCard(
  offerId: string,
  taskId: string,
  requestedAt: string,
  patch: Partial<OfferCard> = {},
): OfferCard {
  return {
    offer_id: offerId,
    task_id: taskId,
    mode: 'single',
    eligible_as: 'accept',
    expires_at: '2026-10-29T18:00:30.000Z',
    reminder_at: '2026-10-29T18:00:15.000Z',
    server_time: '2026-10-29T18:00:00.000Z',
    ticket: { display_number: 125, event_name_ar: 'حفل' },
    requested_at: requestedAt,
    waiting_seconds: 10,
    can_accept: true,
    can_reserve_next: false,
    ...patch,
  };
}
