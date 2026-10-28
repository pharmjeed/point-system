import { raiseAlert } from '../../../core/alerts/alerts.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { claimCodeExpireHandler } from '../application/claim-codes.js';
import { venueSettingsFor } from '../../venues-events/index.js';
import type { TicketRow } from '../infra/rows.js';

function requireTx<T>(tx: T | undefined): T {
  if (!tx) throw new Error('tickets-custody jobs run in mode tx');
  return tx;
}

/**
 * Scheduled by `POST /v1/tasks/{taskId}/ready` (TT-17, 10 §8.2): `job.ready_uncollected_check` at
 * `ready_at + ready.uncollected_alert_min`, dedupe `ready_uncollected:<cycle_id>`, the `ready_at` mark in the payload.
 */
export async function scheduleReadyUncollectedCheck(
  tx: Tx,
  ticket: Pick<TicketRow, 'id' | 'org_id' | 'venue_id' | 'version'>,
  cycleId: string,
  readyAt: Date,
): Promise<void> {
  const s = await venueSettingsFor(tx, ticket.venue_id);
  await schedule(
    tx,
    'job.ready_uncollected_check',
    new Date(readyAt.getTime() + s.ready.uncollected_alert_min * 60_000),
    {
      orgId: ticket.org_id,
      venueId: ticket.venue_id,
      dedupeKey: `ready_uncollected:${cycleId}`,
      aggregate: { type: 'ticket', id: ticket.id, version: ticket.version },
      payload: { ticket_id: ticket.id, cycle_id: cycleId, ready_at: readyAt.toISOString() },
    },
  );
}

/**
 * `job.ready_uncollected_check` (10 §8.2, PNT-061): scheduled at `ready` for `ready_at + ready.uncollected_alert_min`.
 * Still applies only while the ticket is `ready` with the same active cycle and the same `ready_at` (episode
 * mark in the payload); then `ready_not_collected` (warning) is raised for the supervisors — the supervisor
 * decides on a repark (§9.4). L5 is taken so a concurrent handover or repark serializes with the check.
 */
export const readyUncollectedHandler: JobHandler = {
  type: 'job.ready_uncollected_check',
  mode: 'tx',
  async handle({ row, tx: maybeTx }) {
    const tx = requireTx(maybeTx);
    const ticketId = row.payload?.ticket_id as string | undefined;
    const cycleId = row.payload?.cycle_id as string | undefined;
    const readyAt = row.payload?.ready_at as string | undefined;
    if (!ticketId || !cycleId || !readyAt) return;
    const [t] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    if (!t || t.status !== 'ready' || t.active_cycle_id !== cycleId) return; // delivered, reparked, canceled
    const c = await tx.maybeOne<{ ready_at: Date | null; retrieved_by: string | null }>(
      `SELECT ready_at, retrieved_by FROM retrieval_cycles WHERE id = $1`,
      [cycleId],
    );
    if (!c?.ready_at || new Date(c.ready_at).toISOString() !== new Date(readyAt).toISOString()) return;
    const task = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM tasks WHERE cycle_id = $1 AND type = 'retrieve' AND status = 'in_progress'`,
      [cycleId],
    );
    await raiseAlert(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      type: 'ready_not_collected',
      dedupeKey: `ready_not_collected:${cycleId}`,
      poolId: t.dispatch_pool_id,
      eventId: t.event_id,
      ticketId: t.id,
      taskId: task?.id ?? null,
      userId: c.retrieved_by,
      details: {
        display_number: t.display_number,
        cycle_id: cycleId,
        ready_at: new Date(c.ready_at).toISOString(),
        waited_s: Math.max(0, Math.round((tx.now.getTime() - new Date(c.ready_at).getTime()) / 1000)),
      },
    });
  },
};

/**
 * Worker handlers of tickets-custody (04 §4.2): `job.ready_uncollected_check` (S4) and `job.claim_code_expire`
 * (PNT-047).
 */
export function ticketsCustodyJobs(): JobHandler[] {
  return [readyUncollectedHandler, claimCodeExpireHandler];
}
