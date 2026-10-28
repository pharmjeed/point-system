import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockEvents } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { AppError } from '../../../core/errors/app-error.js';
import { cashDifferenceDescription } from '../domain/payment-rules.js';
import { openPaymentDiscrepancyIncident } from './incidents.js';
import { assertEventAcceptsMoney, loadEventRow } from './payments.js';
import { findEventInScope, isUuid, notFound, recheckStaffScope } from './scope.js';
import { cashHandoverView, loadUserRefs, type CashHandoverRow } from './views.js';

const OPERATION = 'POST /v1/cash-handovers';

export interface CashHandoverBody {
  event_id: string;
  driver_id: string;
  amount_halalas: number;
  note?: string | null;
}

/**
 * `POST /v1/cash-handovers` (PNT-082, 13 §10): the receiving supervisor (or an administrator, canon §10) records
 * the cash a driver counts out for an event. The expected amount is the driver's `recorded` cash collections of the
 * event not yet handed over, locked FOR NO KEY UPDATE (L9) under the event row FOR SHARE (L2): a collection
 * committed before the lock read is linked, one committed after stays with the driver for the next handover
 * (PAY-TC-17), and two handovers for the same driver never link a payment twice. The difference
 * (`amount − expected`, a generated column) is stored; a non-zero one opens a `payment_discrepancy` incident.
 * The row is final: corrections go through an incident and a later handover.
 */
@Injectable()
export class CashHandoversService {
  async confirm(tx: Tx, actor: ActorContext, body: CashHandoverBody, requestId: string) {
    const head = await findEventInScope(tx, actor, body.event_id);
    if (!isUuid(body.driver_id)) throw notFound('driver');
    const driver = await tx.maybeOne<{ id: string; org_id: string; role: string }>(
      `SELECT id, org_id, role FROM users WHERE id = $1`,
      [body.driver_id],
    );
    if (!driver || driver.org_id !== actor.orgId) throw notFound('driver');
    // 09 §10 rule 3: nobody confirms receiving his own cash (ck_cash_handover_distinct_people is the backstop)
    if (driver.id === actor.userId)
      throw new AppError('PERMISSION_DENIED', {
        permission: 'cash.handover_confirm',
        reason: 'self_handover',
      });

    await lockEvents(tx, [head.id], 'FOR SHARE'); // L2
    await recheckStaffScope(tx, actor, head.venue_id, { resource: 'event' });
    const ev = await loadEventRow(tx, head.id);
    assertEventAcceptsMoney(ev);
    if (ev.status === 'draft')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'event',
        entity_id: ev.id,
        current_status: ev.status,
        current_version: ev.version,
        command: OPERATION,
        allowed_from: ['open', 'closing'],
      });

    const open = await tx.rows<{ id: string; amount_halalas: number }>(
      `SELECT id, amount_halalas FROM payments
        WHERE event_id = $1 AND collected_by = $2 AND method = 'cash' AND status = 'recorded'
          AND cash_handover_id IS NULL
        ORDER BY id FOR NO KEY UPDATE`,
      [ev.id, driver.id],
    ); // L9
    const expected = open.reduce((s, p) => s + Number(p.amount_halalas), 0);
    if (expected === 0 && body.amount_halalas === 0)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'amount_halalas', issue: 'nothing_to_hand_over' }],
      });

    const h = await tx.one<CashHandoverRow>(
      `INSERT INTO cash_handovers (id, org_id, venue_id, event_id, driver_id, received_by, amount_halalas,
                                   expected_halalas, note, handed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        newId(),
        ev.org_id,
        ev.venue_id,
        ev.id,
        driver.id,
        actor.userId,
        body.amount_halalas,
        expected,
        body.note?.trim() || null,
        tx.now,
      ],
    );
    const paymentIds = open.map((p) => p.id);
    if (paymentIds.length > 0)
      await tx.query(`UPDATE payments SET cash_handover_id = $1 WHERE id = ANY($2::uuid[])`, [
        h.id,
        paymentIds,
      ]);

    const difference = Number(h.difference_halalas);
    const incidentId =
      difference !== 0
        ? await openPaymentDiscrepancyIncident(tx, {
            orgId: ev.org_id,
            venueId: ev.venue_id,
            eventId: ev.id,
            dispatchPoolId: ev.dispatch_pool_id,
            ticketId: null,
            description: cashDifferenceDescription(expected, body.amount_halalas),
            openedBy: actor.userId,
          })
        : null;

    await emitEvent(tx, {
      type: 'cash.handover_recorded',
      orgId: ev.org_id,
      venueId: ev.venue_id,
      dispatchPoolId: ev.dispatch_pool_id,
      eventId: ev.id,
      aggregate: { type: 'cash_handover', id: h.id, version: null },
      actor: { type: 'user', id: actor.userId },
      payload: {
        cash_handover_id: h.id,
        event_id: ev.id,
        driver_id: driver.id,
        received_by: actor.userId,
        amount_halalas: Number(h.amount_halalas),
        expected_halalas: expected,
        difference_halalas: difference,
        linked_payments_count: paymentIds.length,
        incident_id: incidentId,
      },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'cash.handover_confirm',
      entityType: 'cash_handover',
      entityId: h.id,
      venueId: ev.venue_id,
      requestId,
      after: { driver_id: driver.id, amount_halalas: Number(h.amount_halalas), expected_halalas: expected },
      metadata: {
        operation: OPERATION,
        event_id: ev.id,
        difference_halalas: difference,
        payment_count: paymentIds.length,
        incident_id: incidentId,
      },
    });
    const users = await loadUserRefs(tx, [h.driver_id, h.received_by]);
    return cashHandoverView(h, users, { payment_ids: paymentIds, incident_id: incidentId });
  }
}
