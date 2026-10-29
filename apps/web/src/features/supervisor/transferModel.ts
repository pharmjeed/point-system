import type { CustodyBlockItem, DriverLive, OperationsBoard, TaskCard } from '@/api/types';

/**
 * S-07 custody checklist (02 S-07, DEC-32) from the snapshot: what blocks an immediate transfer (vehicle or key
 * held, a movement `in_progress`, an active park/repark) and what goes back to the old venue's queue (the
 * reserved next task, a retrieval accepted before the key pickup). The server stays the judge: a refusal's
 * `details.items` (TRANSFER_BLOCKED_CUSTODY) replaces this view (`fromBlockItems`).
 */
export interface TransferChecklist {
  vehicles: number[];
  keys: number[];
  movement: number[];
  acceptedBeforeKey: number[];
  nextTask: number[];
  /** display number → ticket id, for «فتح» on each row (02 S-06, S-07: transfer it officially first). */
  ticketIds: Record<number, string>;
  /** Any ✗ (blocks an immediate transfer). */
  blocked: boolean;
}

export function checklistFrom(
  driverId: string,
  live: DriverLive | null | undefined,
  boards: readonly Pick<OperationsBoard, 'active_tasks' | 'next_tasks' | 'custody_issues'>[],
): TransferChecklist {
  const mine = (c: TaskCard) => c.task.assignee?.id === driverId;
  const active = boards.flatMap((b) => b.active_tasks).filter(mine);
  const next = boards.flatMap((b) => b.next_tasks).filter(mine);
  const vehicles = new Set<number>();
  const keys = new Set<number>();
  const movement = new Set<number>();
  const acceptedBeforeKey = new Set<number>();
  const ticketIds: Record<number, string> = {};
  for (const c of [...active, ...next]) ticketIds[c.ticket.display_number] = c.ticket.id;
  for (const c of active) {
    const n = c.ticket.display_number;
    if (c.task.status === 'in_progress') {
      movement.add(n);
      vehicles.add(n);
      keys.add(n);
    } else if (c.task.status === 'accepted' && c.task.type !== 'retrieve') {
      // an accepted park/repark is an active park/repark (DEC-32), as the server counts it
      movement.add(n);
    } else if (c.task.status === 'accepted') {
      if (c.task.key_picked_up_at) keys.add(n);
      else acceptedBeforeKey.add(n);
    }
  }
  for (const b of boards)
    for (const issue of b.custody_issues)
      if (issue.holder.type === 'driver' && issue.holder.id === driverId) {
        (issue.subject === 'vehicle' ? vehicles : keys).add(issue.ticket.display_number);
        ticketIds[issue.ticket.display_number] = issue.ticket.id;
      }
  // a park/repark of an event the boards do not cover still shows as a movement through driver_state
  if (live?.driver_state === 'intake_parking' && !movement.size) movement.add(0);
  const out = {
    vehicles: [...vehicles],
    keys: [...keys],
    movement: [...movement],
    acceptedBeforeKey: [...acceptedBeforeKey],
    nextTask: next.map((c) => c.ticket.display_number),
    ticketIds,
  };
  return { ...out, blocked: !!(out.vehicles.length || out.keys.length || out.movement.length) };
}

/**
 * The checklist from the server's `details.items` (08 §4.11): TRANSFER_BLOCKED_CUSTODY (S-07), and the same
 * list of DUTY_END_BLOCKED_CUSTODY / CUSTODY_OPEN (S-06, 02 S-06).
 */
export function fromBlockItems(
  items: readonly CustodyBlockItem[],
  previous: TransferChecklist,
): TransferChecklist {
  const n = (i: CustodyBlockItem) => i.display_number ?? 0;
  const vehicles = items.filter((i) => i.type === 'vehicle').map(n);
  const keys = items.filter((i) => i.type === 'key').map(n);
  const movement = items.filter((i) => i.type === 'task' || i.type === 'draft').map(n);
  const ticketIds = { ...previous.ticketIds };
  for (const i of items) if (i.ticket_id && i.display_number) ticketIds[i.display_number] = i.ticket_id;
  return { ...previous, vehicles, keys, movement, ticketIds, blocked: true };
}

/**
 * A wall-clock time typed for Riyadh («7:30 م», `<input type="datetime-local">` value `YYYY-MM-DDTHH:mm`) →
 * UTC ISO. Asia/Riyadh is UTC+03:00 all year (no DST), independent of the device's zone.
 */
export function riyadhLocalToUtcIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const t = Date.parse(`${local}:00+03:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** UTC ISO → the `datetime-local` value in Riyadh time. */
export function utcIsoToRiyadhLocal(iso: string): string {
  const d = new Date(Date.parse(iso) + 3 * 3600_000);
  return d.toISOString().slice(0, 16);
}
