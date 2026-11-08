import type { DriverState } from '@point/shared';
import { currentDriverState, type SettleOutcome } from '../modules/dispatch/index.js';
import {
  loadTaskCard,
  type TaskCard,
  type TicketQueryable,
  type TicketViewer,
} from '../modules/tickets-custody/index.js';

/** TaskCard (07; D-04 / D-10) — owned by tickets-custody, shared with the realtime `task.updated` messages. */
export { loadTaskCard };

export async function loadTaskCardOrThrow(
  q: TicketQueryable,
  taskId: string,
  viewer: TicketViewer,
  now: Date,
): Promise<TaskCard> {
  const card = await loadTaskCard(q, taskId, viewer, now);
  if (!card) throw new Error(`task ${taskId} vanished`);
  return card;
}

/** DriverStateResult (07) after a command released the driver. */
export async function driverStateResult(
  q: TicketQueryable,
  userId: string,
  settled: SettleOutcome | null,
  viewer: TicketViewer,
  now: Date,
): Promise<{ driver_state: DriverState; promoted_next_task: TaskCard | null }> {
  return {
    driver_state: await currentDriverState(q, userId),
    promoted_next_task:
      settled?.outcome === 'promoted' ? await loadTaskCard(q, settled.task.id, viewer, now) : null,
  };
}
