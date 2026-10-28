import type { ShiftStatus, TaskStatus, TaskType, TicketStatus } from '@point/shared';
import { invalidTransition } from './errors.js';

/**
 * `shifts.status` (11 §6.5): scheduled → open → closed. One open shift per dispatch pool
 * (`uq_shifts_open_per_pool` → SHIFT_ALREADY_OPEN). Closing is blocked only by drivers of the shift who hold a
 * vehicle or a key or have an open task; every other open duty session is ended (`end_reason = shift_closed`).
 */
export interface ShiftStateRow {
  id: string;
  status: ShiftStatus;
  version: number;
}

export function assertShiftOpenable(s: ShiftStateRow, command: string): void {
  if (s.status !== 'scheduled') {
    throw invalidTransition({
      entityType: 'shift',
      entityId: s.id,
      currentStatus: s.status,
      currentVersion: s.version,
      command,
      allowedFrom: ['scheduled'],
    });
  }
}

export function assertShiftClosable(s: ShiftStateRow, command: string): void {
  if (s.status !== 'open') {
    throw invalidTransition({
      entityType: 'shift',
      entityId: s.id,
      currentStatus: s.status,
      currentVersion: s.version,
      command,
      allowedFrom: ['open'],
    });
  }
}

/** An open duty session of the shift with its holder (a driver, or a supervisor with `can_drive`). */
export interface ShiftDutyRow {
  duty_session_id: string;
  user_id: string;
  full_name: string;
  employee_code: string;
}

/** A ticket whose vehicle or key is held by a driver of the shift. */
export interface CustodyRow {
  holder_id: string;
  subject: 'vehicle' | 'key';
  ticket_id: string;
  display_number: number;
}

/** An open task (not completed/canceled) assigned to a driver of the shift. */
export interface OpenTaskRow {
  assignee_id: string;
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  ticket_id: string;
  display_number: number;
  ticket_status: TicketStatus;
}

/** `items` entry — the structure of DUTY_END_BLOCKED_CUSTODY (08 §4.5), plus `task_id` for task items. */
export interface BlockingItem {
  type: 'vehicle' | 'key' | 'task' | 'next_task' | 'draft';
  ticket_id: string;
  display_number: number;
  task_id?: string;
}

export interface BlockingDriver {
  driver: { id: string; full_name: string; employee_code: string };
  items: BlockingItem[];
}

const ITEM_ORDER: Record<BlockingItem['type'], number> = {
  vehicle: 0,
  key: 1,
  draft: 2,
  task: 3,
  next_task: 4,
};

function taskItem(t: OpenTaskRow): BlockingItem {
  const type: BlockingItem['type'] =
    t.status === 'assigned_waiting'
      ? 'next_task'
      : t.type === 'park' && t.ticket_status === 'received'
        ? 'draft'
        : 'task';
  return { type, ticket_id: t.ticket_id, display_number: t.display_number, task_id: t.task_id };
}

/**
 * Splits the open duty sessions of a shift into the drivers that block the close (`details.blocking_drivers`,
 * 08 §4.12) and the sessions that are ended automatically.
 */
export function partitionShiftDuties(
  sessions: readonly ShiftDutyRow[],
  custody: readonly CustodyRow[],
  tasks: readonly OpenTaskRow[],
): { blocking: BlockingDriver[]; toEnd: ShiftDutyRow[] } {
  const items = new Map<string, BlockingItem[]>();
  const push = (userId: string, item: BlockingItem) => {
    const list = items.get(userId) ?? [];
    list.push(item);
    items.set(userId, list);
  };
  for (const c of custody) {
    push(c.holder_id, { type: c.subject, ticket_id: c.ticket_id, display_number: c.display_number });
  }
  for (const t of tasks) push(t.assignee_id, taskItem(t));

  const blocking: BlockingDriver[] = [];
  const toEnd: ShiftDutyRow[] = [];
  for (const s of sessions) {
    const list = items.get(s.user_id);
    if (list && list.length > 0) {
      list.sort((a, b) => ITEM_ORDER[a.type] - ITEM_ORDER[b.type] || a.display_number - b.display_number);
      blocking.push({
        driver: { id: s.user_id, full_name: s.full_name, employee_code: s.employee_code },
        items: list,
      });
    } else {
      toEnd.push(s);
    }
  }
  blocking.sort((a, b) => a.driver.employee_code.localeCompare(b.driver.employee_code));
  toEnd.sort((a, b) => (a.duty_session_id < b.duty_session_id ? -1 : 1));
  return { blocking, toEnd };
}
