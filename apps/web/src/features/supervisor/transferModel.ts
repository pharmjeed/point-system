import type { CustodyBlockItem, DriverLive, OperationsBoard, TaskCard } from '@/api/types';

/**
 * One ticket on a checklist row: «#125» with «فتح» to transfer it officially first (02 S-06, S-07). A row is
 * keyed by the ticket, never by its number: display numbers are unique within an event only
 * (`UNIQUE (event_id, display_number)`) and the snapshot merges the boards of every live event of the venue.
 */
export interface ChecklistTicket {
  /** 0 for a park/repark seen through `driver_state` alone (no ticket known) */
  display_number: number;
  ticket_id: string | null;
  /** the event's name when the boards cover more than one live event, so two #7 can be told apart */
  event_name: string | null;
}

/**
 * S-07 custody checklist (02 S-07, DEC-32) from the snapshot: what blocks an immediate transfer (vehicle or key
 * held, a movement `in_progress`, an active park/repark) and what goes back to the old venue's queue (the
 * reserved next task, a retrieval accepted before the key pickup, the live single offers that are withdrawn).
 * The server stays the judge: a refusal's `details.items` (TRANSFER_BLOCKED_CUSTODY) replaces this view
 * (`fromBlockItems`).
 */
export interface TransferChecklist {
  vehicles: ChecklistTicket[];
  keys: ChecklistTicket[];
  movement: ChecklistTicket[];
  acceptedBeforeKey: ChecklistTicket[];
  nextTask: ChecklistTicket[];
  /** live single offers to this driver (02 S-07 «عروض فردية حية: 1 │ ستُسحب») */
  singleOffers: number;
  /** Any ✗ (blocks an immediate transfer). */
  blocked: boolean;
}

/** A row's tickets, one per ticket (the first sighting keeps its place). */
class Row {
  private readonly items = new Map<string, ChecklistTicket>();
  add(t: ChecklistTicket): void {
    const key = t.ticket_id ?? `#${t.display_number}`;
    if (!this.items.has(key)) this.items.set(key, t);
  }
  get list(): ChecklistTicket[] {
    return [...this.items.values()];
  }
}

export function checklistFrom(
  driverId: string,
  live: DriverLive | null | undefined,
  boards: readonly Pick<
    OperationsBoard,
    'event' | 'queue' | 'active_tasks' | 'next_tasks' | 'custody_issues'
  >[],
): TransferChecklist {
  const several = new Set(boards.map((b) => b.event.id)).size > 1;
  const mine = (c: TaskCard) => c.task.assignee?.id === driverId;
  const vehicles = new Row();
  const keys = new Row();
  const movement = new Row();
  const acceptedBeforeKey = new Row();
  const nextTask = new Row();
  let singleOffers = 0;
  for (const b of boards) {
    const at = (ticket: { id: string; display_number: number }): ChecklistTicket => ({
      display_number: ticket.display_number,
      ticket_id: ticket.id,
      event_name: several ? b.event.name_ar : null,
    });
    for (const c of b.active_tasks.filter(mine)) {
      const t = at(c.ticket);
      if (c.task.status === 'in_progress') {
        movement.add(t);
        vehicles.add(t);
        keys.add(t);
      } else if (c.task.status === 'accepted' && c.task.type !== 'retrieve') {
        // an accepted park/repark is an active park/repark (DEC-32), as the server counts it
        movement.add(t);
      } else if (c.task.status === 'accepted') {
        if (c.task.key_picked_up_at) keys.add(t);
        else acceptedBeforeKey.add(t);
      }
    }
    for (const c of b.next_tasks.filter(mine)) nextTask.add(at(c.ticket));
    for (const issue of b.custody_issues)
      if (issue.holder.type === 'driver' && issue.holder.id === driverId)
        (issue.subject === 'vehicle' ? vehicles : keys).add(at(issue.ticket));
    singleOffers += b.queue.filter(
      (q) => q.status === 'offered' && q.offer?.mode === 'single' && q.offer.recipient?.id === driverId,
    ).length;
  }
  // a park/repark of an event the boards do not cover still shows as a movement through driver_state
  if (live?.driver_state === 'intake_parking' && !movement.list.length)
    movement.add({ display_number: 0, ticket_id: null, event_name: null });
  const out = {
    vehicles: vehicles.list,
    keys: keys.list,
    movement: movement.list,
    acceptedBeforeKey: acceptedBeforeKey.list,
    nextTask: nextTask.list,
    singleOffers,
  };
  return { ...out, blocked: !!(out.vehicles.length || out.keys.length || out.movement.length) };
}

/**
 * The checklist from the server's `details.items` (08 §4.11): TRANSFER_BLOCKED_CUSTODY (S-07), and the same
 * list of DUTY_END_BLOCKED_CUSTODY / CUSTODY_OPEN (S-06, 02 S-06). An item keeps the event name the snapshot
 * knew for the same ticket.
 */
export function fromBlockItems(
  items: readonly CustodyBlockItem[],
  previous: TransferChecklist,
): TransferChecklist {
  const known = [
    ...previous.vehicles,
    ...previous.keys,
    ...previous.movement,
    ...previous.acceptedBeforeKey,
    ...previous.nextTask,
  ];
  const row = (types: readonly string[]) => {
    const out = new Row();
    for (const i of items)
      if (types.includes(i.type))
        out.add({
          display_number: i.display_number ?? 0,
          ticket_id: i.ticket_id ?? null,
          event_name: known.find((k) => k.ticket_id && k.ticket_id === i.ticket_id)?.event_name ?? null,
        });
    return out.list;
  };
  return {
    ...previous,
    vehicles: row(['vehicle']),
    keys: row(['key']),
    movement: row(['task', 'draft']),
    blocked: true,
  };
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
