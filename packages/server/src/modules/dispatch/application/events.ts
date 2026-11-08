import type { Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { emitForTicket, type EventActor, type TicketCtx } from '../../tickets-custody/index.js';
import { driverStateOf, loadTicketCtx } from '../infra/dispatch-repo.js';
import type { DutyRow, OfferRow, TaskRow } from '../infra/rows.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** task.* events go to the outbox and to the ticket timeline (11 §1.6), aggregate = the task. */
export async function emitTaskEvent(
  tx: Tx,
  task: Pick<TaskRow, 'id' | 'ticket_id' | 'version'>,
  type: string,
  actor: EventActor,
  payload: Record<string, unknown>,
  ticket?: TicketCtx,
): Promise<void> {
  const t = ticket ?? (await loadTicketCtx(tx, task.ticket_id));
  await emitForTicket(tx, t, {
    type,
    actor,
    aggregate: { type: 'task', id: task.id, version: task.version },
    payload,
  });
}

/** offer.* events (aggregate = the round) — not part of the ticket timeline. */
export async function emitOfferEvent(
  tx: Tx,
  offer: Pick<OfferRow, 'id' | 'org_id' | 'dispatch_pool_id' | 'version'>,
  venueId: string,
  type: string,
  actor: EventActor,
  payload: Record<string, unknown>,
): Promise<void> {
  await emitEvent(tx, {
    type,
    orgId: offer.org_id,
    venueId,
    dispatchPoolId: offer.dispatch_pool_id,
    aggregate: { type: 'task_offer', id: offer.id, version: offer.version },
    actor,
    payload,
  });
}

/**
 * `driver.availability_changed` (11 §8.5) from the derived state after the change. For an ended duty the
 * caller passes the session row (state off_duty).
 */
export async function emitAvailability(
  tx: Tx,
  userId: string,
  actor: EventActor,
  ended?: Pick<DutyRow, 'id' | 'org_id' | 'venue_id' | 'dispatch_pool_id' | 'version'>,
): Promise<void> {
  if (ended) {
    await emitEvent(tx, {
      type: 'driver.availability_changed',
      orgId: ended.org_id,
      venueId: ended.venue_id,
      dispatchPoolId: ended.dispatch_pool_id,
      aggregate: { type: 'duty_session', id: ended.id, version: ended.version },
      actor,
      payload: {
        user_id: userId,
        duty_session_id: ended.id,
        driver_state: 'off_duty',
        available_since: null,
        active_task_id: null,
        next_task_id: null,
      },
    });
    return;
  }
  const s = await driverStateOf(tx, userId);
  if (!s) return;
  await emitEvent(tx, {
    type: 'driver.availability_changed',
    orgId: s.org_id,
    venueId: s.venue_id,
    dispatchPoolId: s.dispatch_pool_id,
    aggregate: { type: 'duty_session', id: s.duty_session_id, version: s.version },
    actor,
    payload: {
      user_id: userId,
      duty_session_id: s.duty_session_id,
      driver_state: s.driver_state,
      available_since: iso(s.available_since),
      active_task_id: s.active_task_id,
      next_task_id: s.next_task_id,
    },
  });
}
