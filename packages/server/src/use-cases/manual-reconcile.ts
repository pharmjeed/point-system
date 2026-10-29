import { Injectable } from '@nestjs/common';
import { autoResolveAlerts } from '../core/alerts/alerts.js';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { audit } from '../core/audit/audit-writer.js';
import { newId } from '../core/crypto/ids.js';
import { lockCycles, lockEvents, lockOffers, lockPools, lockTasks, lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  emitAvailability,
  emitTaskEvent,
  revokeRound,
  runDispatchPass,
  settleDriverAfterTask,
  type SettleOutcome,
  type TaskRow,
} from '../modules/dispatch/index.js';
import { scopeStillGranted } from '../modules/incidents/index.js';
import { alreadyRecorded, normalizePosReference } from '../modules/payments-reports/index.js';
import {
  checkVersion,
  emitForTicket,
  invalidTransition,
  isClosedTicket,
  loadTicketDetail,
  moveCustody,
  OPEN_TICKET_STATUSES,
  revokeLiveLinkCodes,
  ticketRef,
  type CycleRow,
  type Holder,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { revokeActionTokens } from '../modules/whatsapp/index.js';
import { auditCommand, eventActor } from './shared.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/manual-reconcile';

export type ReconcileTarget = 'parked' | 'delivered' | 'voided';

export interface ManualReconcileBody {
  target_status: ReconcileTarget;
  reason: string;
  evidence: { paper_log_ref: string; note?: string };
  parking_spot_id?: string | null;
  spot_note?: string | null;
  key_slot_id?: string | null;
  incident_id?: string | null;
  payment?: {
    method: 'cash' | 'pos';
    amount_halalas: number;
    pos_reference?: string | null;
    collected_by: string;
  } | null;
  expected_version?: number;
}

const fields = (field: string, issue: string) =>
  new AppError('VALIDATION_FAILED', { fields: [{ field, issue }] });

/** 13 §5.6: strip spaces and hyphens, uppercase, `^[A-Z0-9]{1,24}$`, never 13+ consecutive digits. */
/**
 * The documented POS reference of a reconciled payment: the payments module's normalization (13 §5.2: Arabic-Indic
 * digits, spaces and dashes) and its shape rules, reported on `payment.pos_reference`.
 */
function reconcilePosReference(raw: string | null | undefined): string | null {
  const v = normalizePosReference(raw);
  if (!v) return null;
  if (/[0-9]{13,}/.test(v)) throw fields('payment.pos_reference', 'looks_like_card_number');
  if (!/^[A-Z0-9]{1,24}$/.test(v)) throw fields('payment.pos_reference', 'invalid_format');
  return v;
}

/**
 * `POST /v1/tickets/{ticketId}/manual-reconcile` (PNT-085; 11 TT-22, 13 §8.5, 04 outage runbook, 09 §11). After a
 * full outage the supervisor (or admin) sets the true final state from the numbered paper log: open tasks
 * `canceled` (`manual_reconcile`) with their live rounds revoked (`task_canceled`), the open cycle closed
 * (`delivered` with `handover_method = manual_reconcile`, or `canceled`), live claim codes revoked with their
 * encrypted copy purged, allocations and custody set for the target (`custody_events` reason `manual_reconcile`;
 * `unknown` when the holder is not known), the drivers of the canceled movements settled, then a pass.
 *
 * Nothing deferred is replayed and no customer message goes out for an intermediate state: the only ticket event is
 * `ticket.manually_reconciled` (no `ticket.parked` / `ticket.delivered` / `ticket.voided`, so no WhatsApp or Push
 * consumer reacts), the early request kept while parking is dropped, and the ticket's pending WhatsApp
 * notifications are skipped as `superseded`. Payment is never invented (13 §8.5): a `due` ticket reconciled to
 * `delivered` needs the documented collection (`payment` with its collector) or a prior waiver, else
 * PAYMENT_PENDING; a voided ticket cannot carry a recorded payment (13 §8.6).
 *
 * Locks: L1 pool → L2 event (FOR SHARE) → L4 task → L5 ticket → L6 cycle → L7 rounds → (L8 under L1) → L9.
 */
@Injectable()
export class ManualReconcileUseCase {
  async execute(tx: Tx, actor: ActorContext, ticketId: string, body: ManualReconcileBody, requestId: string) {
    const target = body.target_status;
    const pre = await tx.maybeOne<{
      org_id: string;
      venue_id: string;
      dispatch_pool_id: string;
      event_id: string;
      active_cycle_id: string | null;
    }>(`SELECT org_id, venue_id, dispatch_pool_id, event_id, active_cycle_id FROM tickets WHERE id = $1`, [
      ticketId,
    ]);
    if (!pre || pre.org_id !== actor.orgId || !actor.venueIds.has(pre.venue_id))
      throw new AppError('TICKET_NOT_FOUND');
    const preTask = await tx.maybeOne<{ id: string; cycle_id: string | null }>(
      `SELECT id, cycle_id FROM tasks WHERE ticket_id = $1 AND status NOT IN ('completed','canceled')`,
      [ticketId],
    );

    await lockPools(tx, [pre.dispatch_pool_id]); // L1
    const [event] = await lockEvents(tx, [pre.event_id], 'FOR SHARE'); // L2: serializes with the event close
    const [task] = preTask ? ((await lockTasks(tx, [preTask.id])) as TaskRow[]) : [null]; // L4
    const [locked] = (await lockTickets(tx, [ticketId])) as TicketRow[]; // L5
    const t = locked!;
    const cycleId = t.active_cycle_id ?? task?.cycle_id ?? null;
    const [cycle] = cycleId ? ((await lockCycles(tx, [cycleId])) as CycleRow[]) : [null]; // L6
    const rounds = task
      ? await tx.rows<{ id: string }>(
          `SELECT id FROM task_offers WHERE task_id = $1 AND status = 'active' ORDER BY id`,
          [task.id],
        )
      : [];
    if (rounds.length)
      await lockOffers(
        tx,
        rounds.map((r) => r.id),
      ); // L7
    if (!(await scopeStillGranted(tx, actor, t.venue_id))) throw new AppError('TICKET_NOT_FOUND');

    checkVersion('ticket', t, body.expected_version);
    if (isClosedTicket(t.status))
      throw invalidTransition('ticket', t, OPERATION, OPEN_TICKET_STATUSES, 'ticket_closed');
    // under L1 the ticket's open task cannot change; a mismatch means the pre-read raced a commit
    const openNow = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM tasks WHERE ticket_id = $1 AND status NOT IN ('completed','canceled')`,
      [t.id],
    );
    if ((openNow?.id ?? null) !== (task?.id ?? null))
      throw new AppError('VERSION_CONFLICT', { entity: 'ticket', id: t.id, current_version: t.version });

    // ------------------------------------------------------------------ validation (no write before this point)
    const spotId = body.parking_spot_id ?? null;
    const spotNote = body.spot_note?.trim() || null;
    const slotId = body.key_slot_id ?? null;
    if (target !== 'parked') {
      if (spotId) throw fields('parking_spot_id', 'not_allowed_for_target');
      if (spotNote) throw fields('spot_note', 'not_allowed_for_target');
      if (slotId) throw fields('key_slot_id', 'not_allowed_for_target');
    }
    if (target !== 'voided' && t.channel === 'paper' && !t.paper_serial)
      throw fields('target_status', 'paper_serial_missing');
    if (spotId) await this.assertSpot(tx, t, spotId);
    if (slotId) await this.assertSlot(tx, t, slotId);
    if (body.incident_id) {
      const i = await tx.maybeOne<{ venue_id: string; ticket_id: string | null }>(
        `SELECT venue_id, ticket_id FROM incidents WHERE id = $1 AND org_id = $2`,
        [body.incident_id, actor.orgId],
      );
      if (!i || !actor.venueIds.has(i.venue_id))
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'incident' });
      if (i.venue_id !== t.venue_id || (i.ticket_id && i.ticket_id !== t.id))
        throw fields('incident_id', 'ticket_mismatch');
    }
    const recorded = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM payments WHERE ticket_id = $1 AND status = 'recorded'`,
      [t.id],
    );
    if (target === 'voided' && recorded)
      throw invalidTransition('ticket', t, OPERATION, OPEN_TICKET_STATUSES, 'payment_recorded');
    let payment: {
      method: 'cash' | 'pos';
      amount: number;
      posRef: string | null;
      collectedBy: string;
    } | null = null;
    if (body.payment) {
      if (target !== 'delivered') throw fields('payment', 'not_applicable');
      // 13 §16: the details of the recorded payment ({payment_id, method, collected_by}), as every other route
      if (t.payment_status === 'collected' || recorded) throw await alreadyRecorded(tx, t.id);
      if (t.payment_status !== 'due') throw fields('payment', 'not_applicable');
      const methods = (event as { allowed_payment_methods: string[] }).allowed_payment_methods;
      if (!methods.includes(body.payment.method))
        throw new AppError('PAYMENT_METHOD_NOT_ALLOWED', { allowed_methods: methods });
      if (body.payment.amount_halalas !== Number(t.fee_halalas))
        throw new AppError('PAYMENT_AMOUNT_MISMATCH', {
          expected_halalas: Number(t.fee_halalas),
          received_halalas: body.payment.amount_halalas,
        });
      if (body.payment.method === 'cash' && body.payment.pos_reference)
        throw fields('payment.pos_reference', 'not_applicable');
      const posRef = reconcilePosReference(body.payment.pos_reference);
      const collector = await tx.maybeOne(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2`, [
        body.payment.collected_by,
        actor.orgId,
      ]);
      if (!collector) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'user' });
      payment = {
        method: body.payment.method,
        amount: body.payment.amount_halalas,
        posRef,
        collectedBy: body.payment.collected_by,
      };
    } else if (target === 'delivered' && t.payment_status === 'due') {
      // 13 §8.5: the collection recorded in the paper log, or a waiver first — never invented
      throw new AppError('PAYMENT_PENDING', {
        amount_halalas: Number(t.fee_halalas),
        allowed_methods: (event as { allowed_payment_methods: string[] }).allowed_payment_methods,
      });
    }

    const ea = eventActor(actor);
    const reason = body.reason.trim();
    const paperRef = body.evidence.paper_log_ref.trim();

    // ------------------------------------------------------------------ the open task and its rounds
    let canceled: TaskRow | null = null;
    if (task) {
      for (const r of rounds) await revokeRound(tx, r.id, t.venue_id, 'task_canceled', ea);
      canceled = await tx.one<TaskRow>(
        `UPDATE tasks SET status = 'canceled', canceled_at = $2, canceled_by = $3, cancel_reason = 'manual_reconcile',
                version = version + 1
          WHERE id = $1 RETURNING *`,
        [task.id, tx.now, actor.userId],
      );
    }

    // ------------------------------------------------------------------ the open cycle
    let closedCycle: CycleRow | null = null;
    const deliveredBy =
      target === 'delivered'
        ? ((task?.type === 'retrieve' ? task.assignee_id : null) ??
          cycle?.retrieved_by ??
          cycle?.accepted_by ??
          actor.userId)
        : null;
    if (cycle && !cycle.closed_at) {
      closedCycle =
        target === 'delivered'
          ? await tx.one<CycleRow>(
              `UPDATE retrieval_cycles SET outcome = 'delivered', delivered_at = $2, delivered_by = $3,
                      handover_method = 'manual_reconcile', closed_at = $2
                WHERE id = $1 RETURNING *`,
              [cycle.id, tx.now, deliveredBy],
            )
          : await tx.one<CycleRow>(
              `UPDATE retrieval_cycles SET outcome = 'canceled', canceled_at = $2, canceled_by = $3,
                      cancel_reason = 'manual_reconcile', closed_at = $2
                WHERE id = $1 RETURNING *`,
              [cycle.id, tx.now, actor.userId],
            );
    }
    // live handover codes of the ticket: revoked, the only encrypted copy purged (DEC-38)
    const revokedCodes = await tx.rows<{ id: string }>(
      `UPDATE claim_codes SET revoked_at = $2, revoke_reason = 'canceled', code_ciphertext = NULL
        WHERE ticket_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [t.id, tx.now],
    );

    // ------------------------------------------------------------------ allocations and holders for the target
    const keepSpot =
      !!spotId &&
      !!(await tx.maybeOne(
        `SELECT 1 FROM spot_allocations WHERE ticket_id = $1 AND parking_spot_id = $2 AND released_at IS NULL`,
        [t.id, spotId],
      ));
    const keepSlot =
      !!slotId &&
      !!(await tx.maybeOne(
        `SELECT 1 FROM key_slot_allocations WHERE ticket_id = $1 AND key_slot_id = $2 AND released_at IS NULL`,
        [t.id, slotId],
      ));
    if (!keepSpot)
      await tx.query(
        `UPDATE spot_allocations SET released_at = $2, released_by = $3, release_reason = 'manual_reconcile'
          WHERE ticket_id = $1 AND released_at IS NULL`,
        [t.id, tx.now, actor.userId],
      );
    if (!keepSlot)
      await tx.query(
        `UPDATE key_slot_allocations SET released_at = $2, released_by = $3, release_reason = 'manual_reconcile'
          WHERE ticket_id = $1 AND released_at IS NULL`,
        [t.id, tx.now, actor.userId],
      );
    if (spotId && !keepSpot)
      await tx.query(
        `INSERT INTO spot_allocations (org_id, ticket_id, parking_spot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [t.org_id, t.id, spotId, tx.now, actor.userId],
      );
    if (slotId && !keepSlot)
      await tx.query(
        `INSERT INTO key_slot_allocations (org_id, ticket_id, key_slot_id, allocated_at, allocated_by) VALUES ($1, $2, $3, $4, $5)`,
        [t.org_id, t.id, slotId, tx.now, actor.userId],
      );

    const vehicleTo: Holder =
      target !== 'parked'
        ? { type: 'customer', id: null }
        : spotId || spotNote
          ? { type: 'spot', id: spotId }
          : { type: 'unknown', id: null };
    const keyTo: Holder =
      target !== 'parked'
        ? { type: 'customer', id: null }
        : slotId
          ? { type: 'key_slot', id: slotId }
          : { type: 'unknown', id: null };
    const parkTaskAssignee = task && task.type !== 'retrieve' ? task.assignee_id : null;
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET status = $2,
              vehicle_holder_type = $3, vehicle_holder_id = $4, key_holder_type = $5, key_holder_id = $6,
              current_spot_id = $7, current_spot_note = $8, current_key_slot_id = $9,
              active_cycle_id = NULL, pending_retrieval_at = NULL, pending_retrieval_source = NULL,
              submitted_at = CASE WHEN $2 = 'parked' THEN COALESCE(submitted_at, $10) ELSE submitted_at END,
              parked_by = CASE WHEN $2 = 'parked' AND (parked_by IS NULL OR $11::uuid IS NOT NULL)
                               THEN COALESCE($11::uuid, parked_by, $12::uuid) ELSE parked_by END,
              parked_at = CASE WHEN $2 = 'parked' AND (parked_at IS NULL OR $11::uuid IS NOT NULL) THEN $10 ELSE parked_at END,
              delivered_at = CASE WHEN $2 = 'delivered' THEN $10 ELSE delivered_at END,
              delivered_by = CASE WHEN $2 = 'delivered' THEN $13::uuid ELSE delivered_by END,
              voided_at = CASE WHEN $2 = 'voided' THEN $10 ELSE voided_at END,
              voided_by = CASE WHEN $2 = 'voided' THEN $12::uuid ELSE voided_by END,
              void_reason = CASE WHEN $2 = 'voided' THEN $14 ELSE void_reason END,
              payment_status = CASE WHEN $15 THEN 'collected' ELSE payment_status END,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [
        t.id,
        target,
        vehicleTo.type,
        vehicleTo.id,
        keyTo.type,
        keyTo.id,
        target === 'parked' ? spotId : null,
        target === 'parked' ? spotNote : null,
        target === 'parked' ? slotId : null,
        tx.now,
        parkTaskAssignee,
        actor.userId,
        deliveredBy,
        reason,
        !!payment,
      ],
    );
    if (target === 'voided') {
      await revokeLiveLinkCodes(tx, t.id, 'ticket_voided');
      await revokeActionTokens(tx, t.id); // 11 §5.3: the «طلب السيارة» buttons of the ticket stop working
    }

    // ------------------------------------------------------------------ the documented collection (13 §8.5)
    let paymentId: string | null = null;
    if (payment) {
      paymentId = newId();
      await tx.query(
        `INSERT INTO payments (id, org_id, venue_id, event_id, ticket_id, cycle_id, method, amount_halalas, pos_reference,
                               collected_by, collected_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          paymentId,
          t.org_id,
          t.venue_id,
          t.event_id,
          t.id,
          closedCycle?.id ?? null,
          payment.method,
          payment.amount,
          payment.posRef,
          payment.collectedBy,
          tx.now,
        ],
      );
    }

    // ------------------------------------------------------------------ events: no state event, only the reconcile
    if (canceled) {
      await emitTaskEvent(
        tx,
        canceled,
        'task.canceled',
        ea,
        {
          task_id: canceled.id,
          ticket_id: t.id,
          type: canceled.type,
          previous_status: task!.status,
          assignee_id: canceled.assignee_id,
          cancel_reason: 'manual_reconcile',
          canceled_by: actor.userId,
        },
        updated,
      );
    }
    const vehicleFrom: Holder = { type: t.vehicle_holder_type, id: t.vehicle_holder_id };
    const keyFrom: Holder = { type: t.key_holder_type, id: t.key_holder_id };
    const custodyEvents: string[] = [];
    for (const [subject, from, to] of [
      ['vehicle', vehicleFrom, vehicleTo],
      ['key', keyFrom, keyTo],
    ] as const) {
      if (from.type === to.type && (from.id ?? null) === (to.id ?? null)) continue;
      custodyEvents.push(
        await moveCustody(tx, updated, {
          subject,
          from,
          to,
          reason: 'manual_reconcile',
          taskId: canceled?.id ?? null,
          actorId: actor.userId,
          note: paperRef,
        }),
      );
    }
    if (paymentId && payment) {
      await emitForTicket(tx, updated, {
        type: 'payment.recorded',
        actor: ea,
        payload: {
          payment_id: paymentId,
          ticket_id: t.id,
          cycle_id: closedCycle?.id ?? null, // 11 §8.7 PaymentRecorded (DEC-285): the row's cycle
          method: payment.method,
          amount_halalas: payment.amount,
          collected_by: payment.collectedBy,
          source: 'reconcile',
        },
      });
    }
    await emitForTicket(tx, updated, {
      type: 'ticket.manually_reconciled',
      actor: ea,
      payload: {
        ticket: ticketRef(updated),
        previous_status: t.status,
        target_status: target,
        reconciled_by: actor.userId,
        reason,
        paper_log_ref: paperRef,
        incident_id: body.incident_id ?? null,
        manual: true,
      },
    });

    // ------------------------------------------------------------------ nothing old goes to the customer
    const skipped = await tx.rows<{ id: string }>(
      `UPDATE notifications n SET status = 'skipped', skipped_reason = 'superseded', next_attempt_at = NULL
        WHERE n.ticket_id = $1 AND n.channel = 'whatsapp' AND n.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM notification_attempts a WHERE a.notification_id = n.id AND a.finished_at IS NULL)
        RETURNING n.id`,
      [t.id],
    );
    if (skipped.length)
      await tx.query(
        `UPDATE whatsapp_messages SET status = 'skipped'
          WHERE notification_id = ANY($1::uuid[]) AND direction = 'outbound' AND wa_message_id IS NULL AND status = 'queued'`,
        [skipped.map((s) => s.id)],
      );

    // ------------------------------------------------------------------ alerts of the ticket's former state
    const stale = await tx.rows<{ dedupe_key: string }>(
      `SELECT DISTINCT dedupe_key FROM alerts
        WHERE org_id = $1 AND venue_id = $2 AND status <> 'resolved' AND dedupe_key IS NOT NULL
          AND (ticket_id = $3 OR ($4::uuid IS NOT NULL AND task_id = $4) OR dedupe_key = ANY($5::text[]))
          AND ($6 OR type <> 'inspection_incomplete')`,
      [
        t.org_id,
        t.venue_id,
        t.id,
        canceled?.id ?? null,
        [
          ...(canceled
            ? [
                `request_unaccepted:${canceled.id}`,
                `next_task_waiting_long:${canceled.id}`,
                `idle_driver_while_next_waiting:${canceled.id}`,
                `task_stuck:${canceled.id}`,
              ]
            : []),
          ...(closedCycle
            ? [`ready_not_collected:${closedCycle.id}`, `handover_code_locked:${closedCycle.id}`]
            : []),
          `draft_abandoned:${t.id}`,
        ],
        target !== 'parked',
      ],
    );
    await autoResolveAlerts(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      dedupeKeys: stale.map((a) => a.dedupe_key),
      note: 'manual_reconcile',
    });

    // ------------------------------------------------------------------ drivers of the canceled movement
    let settled: SettleOutcome | null = null;
    if (canceled?.assignee_id && (task!.status === 'accepted' || task!.status === 'in_progress'))
      settled = await settleDriverAfterTask(tx, canceled.assignee_id, canceled.id, ea);
    // a reserved next task leaves its driver busy with his current one: only his state changes (busy_with_next → …)
    else if (canceled?.assignee_id && task!.status === 'assigned_waiting')
      await emitAvailability(tx, canceled.assignee_id, ea);
    if (canceled) await runDispatchPass(tx, t.dispatch_pool_id, 'driver_available');

    await auditCommand(tx, actor, {
      action: 'ticket.manual_reconcile',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      reason,
      before: {
        status: t.status,
        vehicle_holder_type: t.vehicle_holder_type,
        key_holder_type: t.key_holder_type,
        payment_status: t.payment_status,
      },
      after: {
        status: updated.status,
        vehicle_holder_type: updated.vehicle_holder_type,
        key_holder_type: updated.key_holder_type,
        payment_status: updated.payment_status,
      },
      metadata: {
        paper_log_ref: paperRef,
        evidence_note: body.evidence.note?.trim() || null,
        incident_id: body.incident_id ?? null,
        canceled_task_id: canceled?.id ?? null,
        closed_cycle_id: closedCycle?.id ?? null,
        handover_claims_revoked: revokedCodes.map((c) => c.id), // claim_codes ids (a key named *code* is redacted)
        custody_event_ids: custodyEvents,
        payment_id: paymentId,
        skipped_notifications: skipped.length,
        settled: settled?.outcome ?? null,
      },
    });
    if (paymentId && payment)
      await audit(tx, {
        orgId: actor.orgId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'payment.record',
        entityType: 'payment',
        entityId: paymentId,
        venueId: t.venue_id,
        requestId,
        after: { method: payment.method, amount_halalas: payment.amount, ticket_payment_status: 'collected' },
        metadata: {
          operation: OPERATION,
          ticket_id: t.id,
          collected_by: payment.collectedBy,
          source: 'reconcile',
        },
      });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }

  private async assertSpot(tx: Tx, t: TicketRow, spotId: string) {
    const s = await tx.maybeOne<{ status: string; zone_status: string }>(
      `SELECT s.status, z.status AS zone_status FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id
        WHERE s.id = $1 AND s.venue_id = $2 FOR SHARE OF s, z`,
      [spotId, t.venue_id],
    );
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'parking_spot' });
    if (s.status !== 'active' || s.zone_status !== 'active')
      throw fields('parking_spot_id', s.status !== 'active' ? 'inactive' : 'zone_inactive');
    const busy = await tx.maybeOne(
      `SELECT 1 FROM spot_allocations WHERE parking_spot_id = $1 AND released_at IS NULL AND ticket_id <> $2 LIMIT 1`,
      [spotId, t.id],
    );
    if (busy) throw new AppError('PARKING_SPOT_OCCUPIED', { parking_spot_id: spotId });
  }

  private async assertSlot(tx: Tx, t: TicketRow, slotId: string) {
    const s = await tx.maybeOne<{ status: string; board_status: string }>(
      `SELECT k.status, b.status AS board_status FROM key_slots k JOIN key_boards b ON b.id = k.key_board_id
        WHERE k.id = $1 AND k.venue_id = $2 FOR SHARE OF k, b`,
      [slotId, t.venue_id],
    );
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'key_slot' });
    if (s.status !== 'active' || s.board_status !== 'active')
      throw fields('key_slot_id', s.status !== 'active' ? 'inactive' : 'board_inactive');
    const busy = await tx.maybeOne(
      `SELECT 1 FROM key_slot_allocations WHERE key_slot_id = $1 AND released_at IS NULL AND ticket_id <> $2 LIMIT 1`,
      [slotId, t.id],
    );
    if (busy) throw new AppError('KEY_SLOT_OCCUPIED', { key_slot_id: slotId });
  }
}
