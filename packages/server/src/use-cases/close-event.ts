import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { audit } from '../core/audit/audit-writer.js';
import type { Database } from '../core/db/database.js';
import { lockEvents } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { emitEvent } from '../core/outbox/outbox-writer.js';
import { DATABASE } from '../http/tokens.js';
import {
  MONEY_EVENT_SELECT,
  closeSummary,
  computeReconciliation,
  findEventInScope,
  recheckStaffScope,
  type MoneyEventRow,
} from '../modules/payments-reports/index.js';
import {
  EVENT_COLUMNS,
  assertClosable,
  toVenueEvent,
  type VenueEventRow,
} from '../modules/venues-events/index.js';

const OPERATION = 'POST /v1/events/{eventId}/close';

export interface CloseEventBody {
  expected_version?: number;
  note?: string | null;
}

/**
 * CloseEvent (PNT-087; 04 §4.4 — venues-events + tickets-custody + payments-reports + incidents, L2 only; 11 §6.4,
 * 13 §12). L2 event FOR NO KEY UPDATE: every money command holds the same row FOR SHARE, so collections,
 * waivers, reversals and cash handovers wait for the close (and fail with EVENT_ALREADY_CLOSED after it). The
 * reconciliation is then read inside the transaction; any non-empty blocker list is EVENT_CLOSE_BLOCKED with
 * `details.blockers` exactly as `GET /v1/events/{eventId}/reconciliation` returns them. Warnings (open incidents,
 * failed messages, cash differences) never block and are frozen in `close_summary` with the finance summary.
 */
@Injectable()
export class CloseEventUseCase {
  async execute(tx: Tx, actor: ActorContext, eventId: string, body: CloseEventBody, requestId: string) {
    const head = await findEventInScope(tx, actor, eventId);
    await lockEvents(tx, [head.id]); // L2
    await recheckStaffScope(tx, actor, head.venue_id, { resource: 'event' });
    const ev = await tx.one<MoneyEventRow>(`${MONEY_EVENT_SELECT} WHERE e.id = $1`, [head.id]);
    if (body.expected_version !== undefined && body.expected_version !== ev.version)
      throw new AppError('VERSION_CONFLICT', { entity: 'event', id: ev.id, current_version: ev.version });
    assertClosable(ev, OPERATION);

    const { reconciliation, settlement } = await computeReconciliation(tx, ev, tx.now);
    if (!reconciliation.can_close)
      throw new AppError('EVENT_CLOSE_BLOCKED', { blockers: reconciliation.blockers });

    const note = body.note?.trim() || null;
    const summary = closeSummary(reconciliation, settlement, {
      closedAt: tx.now,
      closedBy: actor.userId,
      note,
    });
    const row = await tx.one<VenueEventRow>(
      `UPDATE events e SET status = 'closed', closed_at = $3, closed_by = $4, close_summary = $5, version = version + 1
        WHERE e.id = $1 AND e.version = $2 RETURNING ${EVENT_COLUMNS}`,
      [ev.id, ev.version, tx.now, actor.userId, JSON.stringify(summary)],
    );
    await emitEvent(tx, {
      type: 'event.closed',
      orgId: row.org_id,
      venueId: row.venue_id,
      dispatchPoolId: row.dispatch_pool_id,
      eventId: row.id,
      aggregate: { type: 'event', id: row.id, version: row.version },
      actor: { type: 'user', id: actor.userId },
      payload: { event_id: row.id, status: 'closed', by: actor.userId },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'event.manage',
      entityType: 'event',
      entityId: row.id,
      venueId: row.venue_id,
      requestId,
      reason: note,
      before: { status: 'closing' },
      after: { status: 'closed' },
      metadata: {
        command: OPERATION,
        tickets_total: settlement.tickets.total,
        collected_halalas: settlement.amounts.collected_halalas,
        open_incidents: reconciliation.warnings.open_incidents.length,
        failed_messages: reconciliation.warnings.failed_messages.length,
        cash_discrepancies: reconciliation.warnings.cash_discrepancies.length,
      },
    });
    return toVenueEvent(row);
  }
}

/**
 * `GET /v1/events/{eventId}/reconciliation` (S-10): the blockers and warnings read in one REPEATABLE READ,
 * READ ONLY snapshot, so the lists and the amounts agree even while drivers keep working.
 */
@Injectable()
export class EventCloseQueries {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async reconciliation(actor: ActorContext, eventId: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const ev = await findEventInScope(tx, actor, eventId);
      return (await computeReconciliation(tx, ev, tx.now)).reconciliation;
    });
  }
}
