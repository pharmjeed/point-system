import { describe, expect, it } from 'vitest';
import {
  checklistFrom,
  fromBlockItems,
  riyadhLocalToUtcIso,
  utcIsoToRiyadhLocal,
  type ChecklistTicket,
} from '@/features/supervisor/transferModel';
import { ago, board, driverLive, queueItem, taskCard, ticketSummary } from './fixtures';

/** a checklist ticket of the single-event fixtures (no event name) */
const t = (n: number, id: string | null = `t-${n}`): ChecklistTicket => ({
  display_number: n,
  ticket_id: id,
  event_name: null,
});

describe('S-07 transfer checklist (DEC-32)', () => {
  const me = { id: 'd-1', full_name: 'خالد' };
  it('lists what blocks an immediate transfer and what returns to the queue', () => {
    const b = board({
      active_tasks: [
        taskCard({ id: 'k-1', status: 'in_progress', assignee: me }, { display_number: 41, id: 't-41' }),
        taskCard({ id: 'k-2', status: 'accepted', assignee: me }, { display_number: 42, id: 't-42' }),
        taskCard(
          { id: 'k-3', status: 'in_progress', assignee: { id: 'd-2', full_name: 'سعد' } },
          { display_number: 43, id: 't-43' },
        ),
      ],
      next_tasks: [
        taskCard({ id: 'k-4', status: 'assigned_waiting', assignee: me }, { display_number: 44, id: 't-44' }),
      ],
      custody_issues: [
        {
          ticket: ticketSummary({ display_number: 45, id: 't-45' }),
          subject: 'key',
          holder: { type: 'driver', id: 'd-1' },
          since: ago(900),
        },
      ],
    });
    // each ticket carries its id for «فتح» on its row (02 S-06, S-07)
    expect(checklistFrom('d-1', driverLive('d-1', { driver_state: 'busy_with_next' }), [b])).toEqual({
      vehicles: [t(41)],
      keys: [t(41), t(45)],
      movement: [t(41)],
      acceptedBeforeKey: [t(42)],
      nextTask: [t(44)],
      singleOffers: 0,
      blocked: true,
    });
    const free = checklistFrom('d-9', driverLive('d-9'), [b]);
    expect(free.blocked).toBe(false);
    const parking = checklistFrom('d-9', driverLive('d-9', { driver_state: 'intake_parking' }), [b]);
    expect(parking.blocked).toBe(true);
    expect(parking.movement).toEqual([t(0, null)]); // seen through the state alone: no number, no «فتح»
  });

  it('a key picked up for an accepted retrieval is custody; before pickup it only returns to the queue', () => {
    const b = board({
      active_tasks: [
        taskCard(
          { id: 'k-1', status: 'accepted', key_picked_up_at: ago(10), assignee: me },
          { display_number: 41, id: 't-41' },
        ),
      ],
    });
    expect(checklistFrom('d-1', driverLive('d-1'), [b])).toMatchObject({
      keys: [t(41)],
      acceptedBeforeKey: [],
      blocked: true,
    });
  });

  it('an accepted park or repark is an active park/repark: it blocks, it does not go back to the queue', () => {
    const b = board({
      active_tasks: [
        taskCard(
          { id: 'k-1', type: 'repark', status: 'accepted', assignee: me },
          { display_number: 41, id: 't-41' },
        ),
      ],
    });
    expect(checklistFrom('d-1', driverLive('d-1'), [b])).toMatchObject({
      movement: [t(41)],
      acceptedBeforeKey: [],
      blocked: true,
    });
  });

  it('two live events with the same display number keep two rows, each opening its own ticket', () => {
    // UNIQUE (event_id, display_number): #7 of «حفل أ» and #7 of «حفل ب» are different tickets
    const a = board({
      event: { ...board().event, id: 'e-a', name_ar: 'حفل أ' },
      active_tasks: [
        taskCard({ id: 'k-1', status: 'in_progress', assignee: me }, { display_number: 7, id: 't-a7' }),
      ],
    });
    const b = board({
      event: { ...board().event, id: 'e-b', name_ar: 'حفل ب' },
      next_tasks: [
        taskCard({ id: 'k-2', status: 'assigned_waiting', assignee: me }, { display_number: 7, id: 't-b7' }),
      ],
      custody_issues: [
        {
          ticket: ticketSummary({ display_number: 7, id: 't-b7-key' }),
          subject: 'key',
          holder: { type: 'driver', id: 'd-1' },
          since: ago(60),
        },
      ],
    });
    const c = checklistFrom('d-1', driverLive('d-1'), [a, b]);
    expect(c.keys).toEqual([
      { display_number: 7, ticket_id: 't-a7', event_name: 'حفل أ' },
      { display_number: 7, ticket_id: 't-b7-key', event_name: 'حفل ب' },
    ]);
    expect(c.vehicles).toEqual([{ display_number: 7, ticket_id: 't-a7', event_name: 'حفل أ' }]);
    expect(c.nextTask).toEqual([{ display_number: 7, ticket_id: 't-b7', event_name: 'حفل ب' }]);
  });

  it('counts the live single offers to this driver (02 S-07 «عروض فردية حية: 1 │ ستُسحب»)', () => {
    const offer = (recipient: string, mode: 'single' | 'broadcast' = 'single') => ({
      offer_id: `o-${recipient}-${mode}`,
      mode,
      recipient: mode === 'single' ? { id: recipient, full_name: recipient } : null,
    });
    const b = board({
      queue: [
        queueItem({ task_id: 'k-1', status: 'offered', offer: offer('d-1') }),
        queueItem({ task_id: 'k-2', status: 'offered', offer: offer('d-2') }),
        queueItem({ task_id: 'k-3', status: 'broadcast', offer: offer('d-1', 'broadcast') }),
        queueItem({ task_id: 'k-4', status: 'queued' }),
      ],
    });
    expect(checklistFrom('d-1', driverLive('d-1'), [b]).singleOffers).toBe(1);
    expect(checklistFrom('d-3', driverLive('d-3'), [b]).singleOffers).toBe(0);
  });

  it('the server items of TRANSFER_BLOCKED_CUSTODY replace the local view, by ticket', () => {
    const local = checklistFrom('d-1', driverLive('d-1'), [board()]);
    expect(
      fromBlockItems(
        [
          { type: 'vehicle', display_number: 47, ticket_id: 't-47' },
          { type: 'key', display_number: 47, ticket_id: 't-47' },
          { type: 'task', display_number: 48, ticket_id: 't-48', task_id: 'k-48' },
        ],
        local,
      ),
    ).toMatchObject({
      vehicles: [t(47)],
      keys: [t(47)],
      movement: [t(48)],
      blocked: true,
    });
  });

  it('a server item keeps the event name the snapshot knew for the same ticket', () => {
    const a = board({
      event: { ...board().event, id: 'e-a', name_ar: 'حفل أ' },
      active_tasks: [
        taskCard({ id: 'k-1', status: 'in_progress', assignee: me }, { display_number: 7, id: 't-a7' }),
      ],
    });
    const b = board({ event: { ...board().event, id: 'e-b', name_ar: 'حفل ب' } });
    const local = checklistFrom('d-1', driverLive('d-1'), [a, b]);
    const items = [
      { type: 'key', display_number: 7, ticket_id: 't-a7' },
      { type: 'key', display_number: 7, ticket_id: 't-x7' },
    ];
    expect(fromBlockItems(items, local).keys).toEqual([
      { display_number: 7, ticket_id: 't-a7', event_name: 'حفل أ' },
      { display_number: 7, ticket_id: 't-x7', event_name: null },
    ]);
  });

  it('reads a scheduled time as Riyadh wall-clock time (UTC+3, no DST)', () => {
    expect(riyadhLocalToUtcIso('2026-10-29T19:30')).toBe('2026-10-29T16:30:00.000Z');
    expect(riyadhLocalToUtcIso('2026-10-30T01:15')).toBe('2026-10-29T22:15:00.000Z');
    expect(riyadhLocalToUtcIso('2026-10-29')).toBeNull();
    expect(riyadhLocalToUtcIso('')).toBeNull();
    expect(utcIsoToRiyadhLocal('2026-10-29T22:15:00.000Z')).toBe('2026-10-30T01:15');
  });
});
