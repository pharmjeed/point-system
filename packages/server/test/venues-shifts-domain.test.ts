import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors/app-error.js';
import {
  assertShiftClosable,
  assertShiftOpenable,
  partitionShiftDuties,
} from '../src/modules/venues-events/domain/shift-lifecycle.js';

// PNT-020 — pure rules of the shift lifecycle: state guards and the close partition.

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};

describe('shift lifecycle (11 §6.5)', () => {
  it('open from scheduled only; close from open only', () => {
    expect(code(() => assertShiftOpenable({ id: 's', status: 'scheduled', version: 1 }, 'x'))).toBeNull();
    expect(code(() => assertShiftOpenable({ id: 's', status: 'open', version: 1 }, 'x'))).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(code(() => assertShiftOpenable({ id: 's', status: 'closed', version: 1 }, 'x'))).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(code(() => assertShiftClosable({ id: 's', status: 'open', version: 1 }, 'x'))).toBeNull();
    expect(code(() => assertShiftClosable({ id: 's', status: 'scheduled', version: 1 }, 'x'))).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('drivers with custody or an open task block; the others are ended (sorted by duty session id)', () => {
    const sessions = [
      { duty_session_id: 'd3', user_id: 'u3', full_name: 'C', employee_code: 'D-0003' },
      { duty_session_id: 'd1', user_id: 'u1', full_name: 'A', employee_code: 'D-0001' },
      { duty_session_id: 'd2', user_id: 'u2', full_name: 'B', employee_code: 'D-0002' },
      { duty_session_id: 'd0', user_id: 'u0', full_name: 'Z', employee_code: 'D-0009' },
    ];
    const { blocking, toEnd } = partitionShiftDuties(
      sessions,
      [
        { holder_id: 'u2', subject: 'key', ticket_id: 't7', display_number: 7 },
        { holder_id: 'u2', subject: 'vehicle', ticket_id: 't9', display_number: 9 },
      ],
      [
        {
          assignee_id: 'u1',
          task_id: 'k1',
          type: 'retrieve',
          status: 'assigned_waiting',
          ticket_id: 't1',
          display_number: 1,
          ticket_status: 'assigned_waiting',
        },
        {
          assignee_id: 'u1',
          task_id: 'k2',
          type: 'park',
          status: 'in_progress',
          ticket_id: 't2',
          display_number: 2,
          ticket_status: 'received',
        },
        {
          assignee_id: 'u2',
          task_id: 'k3',
          type: 'retrieve',
          status: 'accepted',
          ticket_id: 't3',
          display_number: 3,
          ticket_status: 'assigned',
        },
      ],
    );
    expect(toEnd.map((s) => s.duty_session_id)).toEqual(['d0', 'd3']);
    expect(blocking).toEqual([
      {
        driver: { id: 'u1', full_name: 'A', employee_code: 'D-0001' },
        items: [
          { type: 'draft', ticket_id: 't2', display_number: 2, task_id: 'k2' },
          { type: 'next_task', ticket_id: 't1', display_number: 1, task_id: 'k1' },
        ],
      },
      {
        driver: { id: 'u2', full_name: 'B', employee_code: 'D-0002' },
        items: [
          { type: 'vehicle', ticket_id: 't9', display_number: 9 },
          { type: 'key', ticket_id: 't7', display_number: 7 },
          { type: 'task', ticket_id: 't3', display_number: 3, task_id: 'k3' },
        ],
      },
    ]);
    expect(partitionShiftDuties([], [], [])).toEqual({ blocking: [], toEnd: [] });
  });
});
