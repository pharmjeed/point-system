import type { DriverHome, DriverState, OfferCard, TaskCard, TicketSummary } from '@/api/types';

/**
 * The driver's snapshot (`GET /v1/me/home`) kept current by realtime events (07 §4.3, 11 §9; PNT-065), as pure
 * functions over the React Query cache entry:
 *
 * - **versions**: a task card, a ticket or an offer round only moves forward. An event or a snapshot carrying a
 *   version lower than the one already applied is ignored (07 §4.5); a task that left the driver (completed,
 *   canceled, withdrawn) at version v never comes back from an older snapshot.
 * - **in-flight snapshots**: a snapshot answers for the moment it was *requested*. What an event applied after
 *   that moment wins over the snapshot (the task promoted while the request was travelling stays promoted);
 *   what was applied before it is the snapshot's to decide (the server is the source of truth).
 * - **the head card**: only the oldest request the driver may act on is shown (02 D-04); offers learned from
 *   events are candidates for it until a newer snapshot decides; a closed round (claimed, expired, revoked) is
 *   never shown again.
 */
export interface Seen {
  version: number;
  /** The task left this driver (completed, canceled, withdrawn, reassigned away). */
  gone: boolean;
  /** Client time (ms) when an event applied it; 0 for snapshot data. */
  at: number;
}

export interface LiveRegistry {
  tasks: Map<string, Seen>;
  tickets: Map<string, Seen>;
  /** Offer rounds that closed: never shown again. */
  closedOffers: Set<string>;
  /** Offer cards learned from `task.offered` / `task.broadcast`, with their arrival time. */
  offers: Map<string, { card: OfferCard; at: number }>;
  /** Client time of the last `driver.state_changed` for this driver. */
  driverStateAt: number;
}

export function createRegistry(): LiveRegistry {
  return {
    tasks: new Map(),
    tickets: new Map(),
    closedOffers: new Set(),
    offers: new Map(),
    driverStateAt: 0,
  };
}

const LIVE_TASK = new Set(['accepted', 'in_progress', 'assigned_waiting']);
const MAX_CLOSED = 200;

/** True when `version` is older than (or equal to, for events) what the registry already holds. */
export function isOlder(seen: Seen | undefined, version: number, orEqual = false): boolean {
  if (!seen) return false;
  return orEqual ? version <= seen.version : version < seen.version;
}

function remember(map: Map<string, Seen>, id: string, entry: Seen): void {
  map.set(id, entry);
  if (map.size > 500) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

function closeOffer(reg: LiveRegistry, offerId: string): void {
  reg.closedOffers.add(offerId);
  reg.offers.delete(offerId);
  if (reg.closedOffers.size > MAX_CLOSED) {
    const first = reg.closedOffers.values().next().value;
    if (first !== undefined) reg.closedOffers.delete(first);
  }
}

const byRequest = (a: OfferCard, b: OfferCard) =>
  a.requested_at.localeCompare(b.requested_at) || a.offer_id.localeCompare(b.offer_id);

/** The oldest of the given cards that is still open. */
function oldestOpen(reg: LiveRegistry, cards: Array<OfferCard | null | undefined>): OfferCard | null {
  const open = cards.filter((c): c is OfferCard => !!c && !reg.closedOffers.has(c.offer_id));
  open.sort(byRequest);
  return open[0] ?? null;
}

/** Places the live cards: `accepted`/`in_progress` is the current task, `assigned_waiting` the next one. */
function slot(cards: TaskCard[]): Pick<DriverHome, 'current_task' | 'next_task'> {
  const live = cards.filter((c) => LIVE_TASK.has(c.task.status));
  const current = live
    .filter((c) => c.task.status !== 'assigned_waiting')
    .sort((a, b) => b.task.version - a.task.version)[0];
  const next = live
    .filter((c) => c.task.status === 'assigned_waiting')
    .sort((a, b) => b.task.version - a.task.version)[0];
  return { current_task: current ?? null, next_task: next ?? null };
}

function cardsOf(home: DriverHome | undefined): TaskCard[] {
  return [home?.current_task, home?.next_task].filter((c): c is TaskCard => !!c);
}

/**
 * Merges a fresh snapshot into the cached one. `requestedAt` is the client time the snapshot was requested:
 * event data applied after it wins, older event data yields to the snapshot.
 */
export function mergeSnapshot(
  previous: DriverHome | undefined,
  snapshot: DriverHome,
  reg: LiveRegistry,
  requestedAt: number,
): DriverHome {
  // tasks: one card per task id, the higher version wins; event-gone tasks stay gone unless the snapshot is newer
  const byId = new Map<string, TaskCard>();
  for (const card of cardsOf(snapshot)) {
    const seen = reg.tasks.get(card.task.id);
    if (seen && seen.at > requestedAt && isOlder(seen, card.task.version, seen.gone)) continue;
    byId.set(card.task.id, card);
  }
  for (const card of cardsOf(previous)) {
    const seen = reg.tasks.get(card.task.id);
    // keep a card only when an event applied it after the snapshot was requested (the snapshot is older)
    if (!seen || seen.gone || seen.at <= requestedAt) continue;
    const other = byId.get(card.task.id);
    if (!other || other.task.version < card.task.version) byId.set(card.task.id, card);
  }
  for (const card of byId.values()) {
    const seen = reg.tasks.get(card.task.id);
    if (!seen || card.task.version >= seen.version)
      remember(reg.tasks, card.task.id, { version: card.task.version, gone: false, at: seen?.at ?? 0 });
  }

  // the head card: the snapshot's (unless closed since) or an older one learned from events after the request
  for (const [offerId, entry] of reg.offers) if (entry.at <= requestedAt) reg.offers.delete(offerId);
  const offer = oldestOpen(reg, [snapshot.offer, ...[...reg.offers.values()].map((e) => e.card)]);

  const driverState: DriverState =
    reg.driverStateAt > requestedAt && previous ? previous.driver_state : snapshot.driver_state;

  return { ...snapshot, ...slot([...byId.values()]), offer, driver_state: driverState };
}

/** `task.offered` / `task.broadcast`: a candidate for the head card (shown when it is the oldest). */
export function applyOffer(home: DriverHome, card: OfferCard, reg: LiveRegistry, now: number): DriverHome {
  if (reg.closedOffers.has(card.offer_id)) return home;
  reg.offers.set(card.offer_id, { card, at: now });
  const current = home.offer && home.offer.offer_id === card.offer_id ? card : home.offer;
  const head = oldestOpen(reg, [current, card]);
  return head === home.offer ? home : { ...home, offer: head };
}

/**
 * `task.claimed` / `offer.closed`, or a press answered TASK_ALREADY_CLAIMED / OFFER_EXPIRED…: the rounds close;
 * when the head card was one of them the next known candidate (if any) takes its place until the resync.
 */
export function applyOfferClosed(
  home: DriverHome,
  offerIds: readonly string[],
  taskId: string | null,
  reg: LiveRegistry,
): DriverHome {
  for (const id of offerIds) closeOffer(reg, id);
  if (taskId) for (const [id, e] of reg.offers) if (e.card.task_id === taskId) closeOffer(reg, id);
  const head = home.offer;
  if (!head) return home;
  const closed = reg.closedOffers.has(head.offer_id) || (!!taskId && head.task_id === taskId);
  if (!closed) return home;
  closeOffer(reg, head.offer_id);
  return {
    ...home,
    offer: oldestOpen(
      reg,
      [...reg.offers.values()].map((e) => e.card),
    ),
  };
}

/** `task.updated` with a TaskCard for this driver: newer versions only; the card goes to its slot. */
export function applyTaskCard(
  home: DriverHome,
  card: TaskCard,
  reg: LiveRegistry,
  now: number,
): { home: DriverHome; applied: boolean } {
  // 07 §4.5: an update whose version is not newer than the one applied is ignored
  if (isOlder(reg.tasks.get(card.task.id), card.task.version, true)) return { home, applied: false };
  const gone = !LIVE_TASK.has(card.task.status);
  remember(reg.tasks, card.task.id, { version: card.task.version, gone, at: now });
  const others = cardsOf(home).filter((c) => c.task.id !== card.task.id);
  const placed = slot(gone ? others : [...others, card]);
  // a claimed task closes its offer rounds (this driver's own accept)
  const withoutOffer =
    home.offer && home.offer.task_id === card.task.id
      ? applyOfferClosed(home, [home.offer.offer_id], card.task.id, reg)
      : home;
  return { home: { ...withoutOffer, ...placed }, applied: true };
}

/** `task.updated` with a `Task` (withdrawn or reassigned away): the task leaves this driver. */
export function applyTaskGone(
  home: DriverHome,
  taskId: string,
  version: number,
  reg: LiveRegistry,
  now: number,
): { home: DriverHome; removed: TaskCard | null } {
  const seen = reg.tasks.get(taskId);
  if (isOlder(seen, version)) return { home, removed: null };
  remember(reg.tasks, taskId, { version, gone: true, at: now });
  const removed = cardsOf(home).find((c) => c.task.id === taskId) ?? null;
  if (!removed) return { home, removed: null };
  return {
    home: { ...home, ...slot(cardsOf(home).filter((c) => c.task.id !== taskId)) },
    removed,
  };
}

/** `ticket.updated`: refreshes the ticket part of the cards that show it (newer versions only). */
export function applyTicketSummary(
  home: DriverHome,
  summary: Pick<TicketSummary, 'id' | 'version' | 'status' | 'plate' | 'vehicle'>,
  reg: LiveRegistry,
  now: number,
): DriverHome {
  const seen = reg.tickets.get(summary.id);
  if (isOlder(seen, summary.version, true)) return home;
  remember(reg.tickets, summary.id, { version: summary.version, gone: false, at: now });
  const patch = (card: TaskCard | null | undefined): TaskCard | null | undefined => {
    if (!card || card.ticket.id !== summary.id || card.ticket.version >= summary.version) return card;
    return {
      ...card,
      ticket: {
        ...card.ticket,
        status: summary.status,
        version: summary.version,
        plate: summary.plate ?? card.ticket.plate,
        vehicle: { ...card.ticket.vehicle, ...summary.vehicle },
      },
    };
  };
  const current = patch(home.current_task);
  const next = patch(home.next_task);
  if (current === home.current_task && next === home.next_task) return home;
  return { ...home, current_task: current ?? null, next_task: next ?? null };
}

/** `driver.state_changed` for this driver (descriptive, not versioned: the later event wins). */
export function applyDriverState(
  home: DriverHome,
  state: DriverState,
  reg: LiveRegistry,
  now: number,
): DriverHome {
  reg.driverStateAt = now;
  return home.driver_state === state ? home : { ...home, driver_state: state };
}

/** Whether a TaskCard payload (has `task` and `ticket`) or a Task view. */
export function isTaskCard(payload: unknown): payload is TaskCard {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'task' in payload &&
    'ticket' in payload &&
    typeof (payload as { task?: unknown }).task === 'object'
  );
}
