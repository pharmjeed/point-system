import { Injectable } from '@nestjs/common';
import type { DriverState } from '@point/shared';
import { autoResolveAlerts } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import {
  lockCycles,
  lockOffers,
  lockOpenDutyByUsers,
  lockPools,
  lockTasks,
  lockTickets,
} from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError, InvariantViolation } from '../core/errors/app-error.js';
import { metrics } from '../core/metrics/metrics.js';
import {
  currentDriverState,
  dispatchSettings,
  driverStateOf,
  emitAvailability,
  emitTaskEvent,
  findOlderActionable,
  revokeDriverSingleOffers,
  runDispatchPass,
  scheduleNextTaskWaitCheck,
  type DutyRow,
  type OfferRow,
  type TaskRow,
} from '../modules/dispatch/index.js';
import {
  emitForTicket,
  loadTaskView,
  loadTicketSummary,
  ticketRef,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { auditCommand, eventActor } from './shared.js';

const OPERATION = 'POST /v1/task-offers/{offerId}/accept';
const CLAIMED: ReadonlySet<string> = new Set(['accepted', 'assigned_waiting', 'in_progress', 'completed']);

/**
 * AcceptOffer (PNT-032; 10 §5): locks L1 pool → L4 task → L5 ticket → L6 cycle → L7 round → L8 the
 * acceptor's duty, then the binding check order of 10 §5.2 (steps 8–14). First confirmed accept wins; the
 * winner's other devices get 200 with the current result; a loser gets TASK_ALREADY_CLAIMED and its
 * recipient row is marked `rejected_late` after the rollback to the savepoint.
 */
@Injectable()
export class AcceptOfferUseCase {
  async execute(tx: Tx, actor: ActorContext, offerId: string, requestId: string) {
    try {
      return await this.run(tx, actor, offerId, requestId);
    } catch (e) {
      // point_dispatch_accept_rejections_total{code} (10 §12.2)
      if (e instanceof AppError) metrics.dispatchAcceptRejections.inc({ code: e.code });
      throw e;
    }
  }

  private async run(tx: Tx, actor: ActorContext, offerId: string, requestId: string) {
    // 1. the offer within the caller's venues, without a lock
    const pre = await tx.maybeOne<{ task_id: string; dispatch_pool_id: string; venue_id: string }>(
      `SELECT o.task_id, o.dispatch_pool_id, p.venue_id FROM task_offers o JOIN dispatch_pools p ON p.id = o.dispatch_pool_id
        WHERE o.id = $1 AND o.org_id = $2`,
      [offerId, actor.orgId],
    );
    if (!pre || !actor.venueIds.has(pre.venue_id)) throw new AppError('OFFER_NOT_FOUND');

    await lockPools(tx, [pre.dispatch_pool_id]); // 2. L1
    const [task] = (await lockTasks(tx, [pre.task_id])) as TaskRow[]; // 3. L4
    const [ticket] = (await lockTickets(tx, [task!.ticket_id])) as TicketRow[]; // 4. L5
    if (task!.cycle_id) await lockCycles(tx, [task!.cycle_id]); // 5. L6
    const [offer] = (await lockOffers(tx, [offerId])) as OfferRow[]; // 6. L7
    const [duty] = await lockOpenDutyByUsers<DutyRow>(tx, [actor.userId]); // 7. L8

    // 8. duty and assignment (re-read under the locks, 09 §8.4)
    if (!duty || duty.dispatch_pool_id !== offer!.dispatch_pool_id) throw new AppError('DUTY_REQUIRED');
    if (duty.status === 'on_break') throw new AppError('DRIVER_ON_BREAK');
    const eligible =
      actor.role === 'driver'
        ? await tx.maybeOne(
            `SELECT 1 FROM driver_assignments WHERE driver_id = $1 AND status = 'active' AND venue_id = $2`,
            [actor.userId, pre.venue_id],
          )
        : await tx.maybeOne(
            `SELECT 1 FROM users u WHERE u.id = $1 AND u.can_drive AND u.status = 'active'
                AND EXISTS (SELECT 1 FROM role_scopes s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                              AND (s.scope_type = 'org' OR s.venue_id = $2))`,
            [actor.userId, pre.venue_id],
          );
    if (!eligible) throw new AppError('ASSIGNMENT_REQUIRED');

    // 9. recipient
    const recipient = await tx.maybeOne<{ eligible_as: string }>(
      `SELECT eligible_as FROM offer_recipients WHERE offer_id = $1 AND user_id = $2`,
      [offerId, actor.userId],
    );
    if (!recipient) throw new AppError('NOT_OFFER_RECIPIENT');

    // 10. already claimed: the winner's other device sees its result; anybody else lost the race
    if (CLAIMED.has(task!.status)) {
      if (task!.assignee_id === actor.userId) {
        const result = task!.status === 'assigned_waiting' ? 'assigned_waiting' : 'accepted';
        await auditCommand(tx, actor, {
          action: 'offer.accept',
          operation: OPERATION,
          entityType: 'task',
          entityId: task!.id,
          venueId: task!.venue_id,
          requestId,
          metadata: { offer_id: offerId, result, already_assigned: true },
        });
        return this.view(tx, actor, result, task!.id, ticket!.id);
      }
      throw new AppError(
        'TASK_ALREADY_CLAIMED',
        { task_id: task!.id },
        {
          afterRollback: async (t2) => {
            await t2.query(
              `UPDATE offer_recipients SET response = 'rejected_late', responded_at = $3
                WHERE offer_id = $1 AND user_id = $2 AND response IS NULL`,
              [offerId, actor.userId, t2.now],
            );
          },
        },
      );
    }
    // 11. withdrawn / canceled
    if (task!.status === 'canceled' || offer!.status === 'revoked')
      throw new AppError('OFFER_REVOKED', { offer_id: offerId, close_reason: offer!.close_reason });
    // 12. expired (time compared even before the timer ran, EC-06)
    const cfg = await dispatchSettings(tx, pre.venue_id);
    const pastGrace =
      offer!.mode === 'single' &&
      offer!.expires_at != null &&
      tx.now.getTime() >= new Date(offer!.expires_at).getTime() + cfg.acceptGraceMs;
    if (offer!.status === 'expired' || (offer!.status === 'active' && pastGrace))
      throw new AppError('OFFER_EXPIRED', { offer_id: offerId });
    if (offer!.status !== 'active')
      // an accepted round whose task went back to the queue: the card is history
      throw new AppError('OFFER_REVOKED', { offer_id: offerId, close_reason: offer!.close_reason });

    // 13. capacity
    const s = await driverStateOf(tx, actor.userId);
    if (!s) throw new AppError('DUTY_REQUIRED');
    if (s.driver_state === 'busy_with_next')
      throw new AppError('NEXT_TASK_ALREADY_RESERVED', { next_task_id: s.next_task_id });
    if (offer!.mode === 'single' && s.driver_state !== 'available')
      throw new AppError('DRIVER_NOT_AVAILABLE', {
        active_task_id: s.active_task_id,
        next_task_id: s.next_task_id,
      });
    const outcome: 'accepted' | 'assigned_waiting' =
      s.driver_state === 'available' ? 'accepted' : 'assigned_waiting';

    // 14. priority guard (10 §5.4): an older live round of this pool on which the actor is a recipient
    const older = await findOlderActionable(tx, {
      poolId: pre.dispatch_pool_id,
      userId: actor.userId,
      taskId: task!.id,
      priorityAt: task!.priority_at,
      seq: task!.seq,
      now: tx.now,
      graceMs: cfg.acceptGraceMs,
    });
    if (older) throw new AppError('OLDER_REQUEST_PENDING', older);

    // 15. apply (10 §5.3)
    const accepted = await tx.one<OfferRow>(
      `UPDATE task_offers SET status = 'accepted', closed_at = $2, close_reason = 'accepted', accepted_by = $3, version = version + 1
        WHERE id = $1 AND status = 'active' RETURNING *`,
      [offerId, tx.now, actor.userId],
    );
    await tx.query(
      `UPDATE offer_recipients SET response = 'accepted', responded_at = $3 WHERE offer_id = $1 AND user_id = $2`,
      [offerId, actor.userId, tx.now],
    );
    const claimed = await tx.maybeOne<TaskRow>(
      `UPDATE tasks SET status = $2, assignee_id = $3, claimed_at = $4,
              accepted_at = CASE WHEN $2 = 'accepted' THEN $4::timestamptz END,
              assigned_waiting_at = CASE WHEN $2 = 'assigned_waiting' THEN $4::timestamptz END,
              version = version + 1
        WHERE id = $1 AND status IN ('offered','broadcast') AND version = $5 RETURNING *`,
      [task!.id, outcome, actor.userId, tx.now, task!.version],
    );
    if (!claimed) throw new InvariantViolation(`task ${task!.id} changed under the pool lock`);
    if (task!.cycle_id)
      await tx.query(
        `UPDATE retrieval_cycles SET accepted_by = $2,
                assigned_at = CASE WHEN $3 = 'accepted' THEN $4::timestamptz ELSE assigned_at END,
                assigned_waiting_at = CASE WHEN $3 = 'assigned_waiting' THEN $4::timestamptz ELSE assigned_waiting_at END
          WHERE id = $1`,
        [task!.cycle_id, actor.userId, outcome, tx.now],
      );
    const tk = await tx.one<TicketRow>(
      `UPDATE tickets SET status = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING *`,
      [ticket!.id, outcome === 'accepted' ? 'assigned' : 'assigned_waiting', ticket!.version],
    );
    if (outcome === 'accepted')
      await tx.query(`UPDATE duty_sessions SET available_since = NULL, version = version + 1 WHERE id = $1`, [
        duty.id,
      ]);

    // his other live single offer (a newer task) goes back to the queue before the pass (I-D, 10 §5.3)
    const ea = eventActor(actor);
    const revoked = await revokeDriverSingleOffers(tx, actor.userId, 'recipient_unavailable', ea);

    const others = await tx.rows<{ user_id: string }>(
      `SELECT user_id FROM offer_recipients WHERE offer_id = $1 AND user_id <> $2 ORDER BY user_id`,
      [offerId, actor.userId],
    );
    await emitTaskEvent(
      tx,
      claimed,
      'task.claimed',
      ea,
      {
        task_id: claimed.id,
        ticket_id: claimed.ticket_id,
        offer_id: offerId,
        mode: accepted.mode,
        claimed_by: actor.userId,
        result: outcome,
        claimed_at: tx.now.toISOString(),
        other_recipient_ids: others.map((o) => o.user_id),
      },
      tk,
    );
    await emitForTicket(tx, tk, {
      type: outcome === 'accepted' ? 'ticket.assigned' : 'ticket.assigned_waiting',
      actor: ea,
      payload: {
        ticket: ticketRef(tk),
        cycle_id: claimed.cycle_id,
        task_id: claimed.id,
        assignee_id: actor.userId,
        via: accepted.mode,
      },
    });
    await emitAvailability(tx, actor.userId, ea);
    await autoResolveAlerts(tx, {
      orgId: actor.orgId,
      venueId: pre.venue_id,
      dedupeKeys: [`request_unaccepted:${claimed.id}`],
      note: 'claimed',
    });
    // W-03 is planned by the NotificationPlanner from ticket.assigned_waiting (once per cycle); the reservation
    // is watched by job.next_task_wait_check (10 §5.3)
    if (outcome === 'assigned_waiting') await scheduleNextTaskWaitCheck(tx, claimed, cfg);
    metrics.dispatchOffers.inc({ mode: accepted.mode, outcome: 'accepted' });
    if (claimed.queued_at)
      metrics.dispatchTimeToClaim.observe(
        Math.max(0, (tx.now.getTime() - new Date(claimed.queued_at).getTime()) / 1000),
      );

    // 16. the pass completes the newer requests
    await runDispatchPass(tx, pre.dispatch_pool_id, 'offer_accepted');
    await auditCommand(tx, actor, {
      action: 'offer.accept',
      operation: OPERATION,
      entityType: 'task',
      entityId: claimed.id,
      venueId: pre.venue_id,
      requestId,
      before: { task_status: task!.status, ticket_status: ticket!.status },
      after: { task_status: claimed.status, ticket_status: tk.status },
      metadata: {
        offer_id: offerId,
        mode: accepted.mode,
        result: outcome,
        oldest_actionable_task_id: claimed.id,
        revoked_offer_ids: revoked.map((r) => r.offerId),
      },
    });
    return this.view(tx, actor, outcome, claimed.id, tk.id);
  }

  private async view(
    tx: Tx,
    actor: ActorContext,
    result: 'accepted' | 'assigned_waiting',
    taskId: string,
    ticketId: string,
  ): Promise<{ result: string; task: unknown; ticket: unknown; driver_state: DriverState }> {
    return {
      result,
      task: await loadTaskView(tx, taskId),
      ticket: await loadTicketSummary(tx, ticketId),
      driver_state: await currentDriverState(tx, actor.userId),
    };
  }
}
