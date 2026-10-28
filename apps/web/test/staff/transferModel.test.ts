import { describe, expect, it } from 'vitest';
import {
  checklistFrom,
  fromBlockItems,
  riyadhLocalToUtcIso,
  utcIsoToRiyadhLocal,
} from '@/features/supervisor/transferModel';
import { ago, board, driverLive, taskCard, ticketSummary } from './fixtures';

describe('S-07 transfer checklist (DEC-32)', () => {
  const me = { id: 'd-1', full_name: 'خالد' };
  it('lists what blocks an immediate transfer and what returns to the queue', () => {
    const b = board({
      active_tasks: [
        taskCard({ id: 'k-1', status: 'in_progress', assignee: me }, { display_number: 41 }),
        taskCard({ id: 'k-2', status: 'accepted', assignee: me }, { display_number: 42 }),
        taskCard(
          { id: 'k-3', status: 'in_progress', assignee: { id: 'd-2', full_name: 'سعد' } },
          { display_number: 43 },
        ),
      ],
      next_tasks: [taskCard({ id: 'k-4', status: 'assigned_waiting', assignee: me }, { display_number: 44 })],
      custody_issues: [
        {
          ticket: ticketSummary({ display_number: 45 }),
          subject: 'key',
          holder: { type: 'driver', id: 'd-1' },
          since: ago(900),
        },
      ],
    });
    expect(checklistFrom('d-1', driverLive('d-1', { driver_state: 'busy_with_next' }), [b])).toEqual({
      vehicles: [41],
      keys: [41, 45],
      movement: [41],
      acceptedBeforeKey: [42],
      nextTask: [44],
      blocked: true,
    });
    const free = checklistFrom('d-9', driverLive('d-9'), [b]);
    expect(free.blocked).toBe(false);
    expect(checklistFrom('d-9', driverLive('d-9', { driver_state: 'intake_parking' }), [b]).blocked).toBe(
      true,
    );
  });

  it('a key picked up for an accepted retrieval is custody; before pickup it only returns to the queue', () => {
    const b = board({
      active_tasks: [
        taskCard(
          { id: 'k-1', status: 'accepted', key_picked_up_at: ago(10), assignee: me },
          { display_number: 41 },
        ),
      ],
    });
    expect(checklistFrom('d-1', driverLive('d-1'), [b])).toMatchObject({
      keys: [41],
      acceptedBeforeKey: [],
      blocked: true,
    });
  });

  it('the server items of TRANSFER_BLOCKED_CUSTODY replace the local view', () => {
    const local = checklistFrom('d-1', driverLive('d-1'), [board()]);
    expect(
      fromBlockItems(
        [
          { type: 'vehicle', display_number: 47 },
          { type: 'key', display_number: 47 },
          { type: 'task', display_number: 48 },
        ],
        local,
      ),
    ).toMatchObject({ vehicles: [47], keys: [47], movement: [48], blocked: true });
  });

  it('reads a scheduled time as Riyadh wall-clock time (UTC+3, no DST)', () => {
    expect(riyadhLocalToUtcIso('2026-10-29T19:30')).toBe('2026-10-29T16:30:00.000Z');
    expect(riyadhLocalToUtcIso('2026-10-30T01:15')).toBe('2026-10-29T22:15:00.000Z');
    expect(riyadhLocalToUtcIso('2026-10-29')).toBeNull();
    expect(riyadhLocalToUtcIso('')).toBeNull();
    expect(utcIsoToRiyadhLocal('2026-10-29T22:15:00.000Z')).toBe('2026-10-30T01:15');
  });
});
