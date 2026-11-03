import { raiseAlert } from '../../../core/alerts/alerts.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { lockCycles, lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { STALE_TIMER, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { venueSettings } from '../../../core/settings/settings-service.js';
import type { CycleRow, TicketRow } from '../infra/rows.js';

export const READY_UNCOLLECTED_JOB = 'job.ready_uncollected_check';

const dueAt = (readyAt: Date, minutes: number) => new Date(readyAt.getTime() + minutes * 60_000);

/**
 * TT-17 timer (10 §12, 11 §9): `job.ready_uncollected_check` at `ready_at + ready.uncollected_alert_min`,
 * payload `{ ticket_id, cycle_id, ready_at }`, dedupe `ready_uncollected:{cycle_id}`. Called by the `ready`
 * command inside its transaction.
 */
export async function scheduleReadyUncollectedCheck(
  tx: Tx,
  ticket: Pick<TicketRow, 'id' | 'org_id' | 'venue_id'>,
  cycleId: string,
  readyAt: Date,
): Promise<void> {
  const s = await venueSettings(tx, ticket.venue_id);
  await schedule(tx, READY_UNCOLLECTED_JOB, dueAt(readyAt, s.ready.uncollected_alert_min), {
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    dedupeKey: `ready_uncollected:${cycleId}`,
    aggregate: { type: 'retrieval_cycle', id: cycleId },
    payload: { ticket_id: ticket.id, cycle_id: cycleId, ready_at: readyAt.toISOString() },
  });
}

/**
 * The timer fires: the ticket is still `ready` on the same cycle with the same readiness mark (11 §9 guard),
 * so the supervisor is told the vehicle was not collected — `ready_not_collected:{cycle_id}` (14 §8, warning);
 * the supervisor decides whether to wait or repark (10 §9.4). A stale timer is a no-op; one that fires early
 * comes back at the real deadline. Locks L5 → L6.
 */
export const readyUncollectedHandler: JobHandler = {
  type: READY_UNCOLLECTED_JOB,
  mode: 'tx',
  async handle({ row, tx }) {
    if (!tx) throw new Error(`${READY_UNCOLLECTED_JOB} runs in mode tx`);
    const p = (row.payload ?? {}) as { ticket_id?: string; cycle_id?: string; ready_at?: string };
    if (!p.ticket_id || !p.cycle_id) return;
    const pre = await tx.maybeOne<{ status: string; active_cycle_id: string | null }>(
      `SELECT status, active_cycle_id FROM tickets WHERE id = $1`,
      [p.ticket_id],
    );
    if (!pre || pre.status !== 'ready' || pre.active_cycle_id !== p.cycle_id) return STALE_TIMER; // delivered, reparked, canceled
    const [t] = (await lockTickets(tx, [p.ticket_id])) as TicketRow[]; // L5
    const [c] = (await lockCycles(tx, [p.cycle_id])) as CycleRow[]; // L6
    if (!t || !c || t.status !== 'ready' || t.active_cycle_id !== c.id || c.closed_at || !c.ready_at)
      return STALE_TIMER;
    const readyAt = new Date(c.ready_at);
    if (p.ready_at && readyAt.getTime() !== new Date(p.ready_at).getTime()) return STALE_TIMER; // another readiness mark
    const s = await venueSettings(tx, t.venue_id);
    const due = dueAt(readyAt, s.ready.uncollected_alert_min);
    if (due.getTime() > tx.now.getTime()) {
      // fired early (clock skew, or the threshold was raised since): come back at the real deadline
      await schedule(tx, READY_UNCOLLECTED_JOB, due, {
        orgId: t.org_id,
        venueId: t.venue_id,
        dedupeKey: `ready_uncollected:${c.id}`,
        aggregate: { type: 'retrieval_cycle', id: c.id },
        payload: { ticket_id: t.id, cycle_id: c.id, ready_at: readyAt.toISOString() },
      });
      return;
    }
    const task = await tx.maybeOne<{ id: string; assignee_id: string | null }>(
      `SELECT id, assignee_id FROM tasks WHERE cycle_id = $1 AND type = 'retrieve' AND status = 'in_progress'`,
      [c.id],
    );
    const { alert, created } = await raiseAlert(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      type: 'ready_not_collected',
      dedupeKey: `ready_not_collected:${c.id}`,
      poolId: t.dispatch_pool_id,
      eventId: t.event_id,
      ticketId: t.id,
      taskId: task?.id ?? null,
      userId: task?.assignee_id ?? null,
      details: {
        display_number: t.display_number,
        cycle_id: c.id,
        ready_at: readyAt.toISOString(),
        waited_min: Math.floor((tx.now.getTime() - readyAt.getTime()) / 60_000),
        threshold_min: s.ready.uncollected_alert_min,
      },
    });
    await audit(tx, {
      orgId: t.org_id,
      actor: { type: 'system', id: null },
      action: READY_UNCOLLECTED_JOB,
      entityType: 'retrieval_cycle',
      entityId: c.id,
      venueId: t.venue_id,
      metadata: { ticket_id: t.id, alert_id: alert.id, alert_created: created },
    });
  },
};
