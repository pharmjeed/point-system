import { randomUUID } from 'node:crypto';
import {
  DOMAIN_EVENT_TYPES,
  analyticsName,
  findPiiValues,
  serverAnalyticsSchema,
  type DomainEventType,
} from '@point/shared';
import { SEED_IDS } from '@point/db/seed';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/core/metrics/metrics.js';
import { OutboxDispatcher, type EventProjector } from '../src/core/outbox/dispatcher.js';
import { emitEvent } from '../src/core/outbox/outbox-writer.js';
import { createAnalyticsProjector } from '../src/modules/audit-monitoring/application/analytics-projector.js';
import { ORG, POOL_R, RMS, U, insertDuty, insertTicket, seededDb } from './audit-monitoring-fixtures.js';
import { silentLogger, type TestContext } from './helpers.js';

const AT = '2026-10-27T15:45:00.000Z';

/**
 * PNT-090: the AnalyticsProjector writes one analytics_events row per domain event (15 §6, §13.1), named by
 * 15 §4, with properties inside the §7 allow-list (no phone, plate, code or key position — AC1), computed from
 * the stored stamps; idempotent per event id and exactly once across a crash before COMMIT (15 §15.4).
 */
describe('AnalyticsProjector', () => {
  let t: TestContext;
  let dispatcher: OutboxDispatcher;
  const r: Record<string, string> = {};

  const rows = async () =>
    (
      await t.db.query<{
        name: string;
        source: string;
        occurred_at: Date;
        org_id: string;
        venue_id: string | null;
        event_id: string | null;
        dispatch_pool_id: string | null;
        actor_role: string;
        actor_id: string | null;
        ticket_id: string | null;
        task_id: string | null;
        cycle_id: string | null;
        app_version: string;
        properties: Record<string, unknown>;
      }>(`SELECT * FROM analytics_events ORDER BY id`)
    ).rows;

  /** A representative payload per type (11 §8), referencing the fixture rows. */
  const payloadFor = (type: DomainEventType): Record<string, unknown> => {
    const ticket = { ticket_id: r.ticket, display_number: 125, ticket_version: 7 };
    const P: Partial<Record<DomainEventType, Record<string, unknown>>> = {
      'ticket.created': { ticket, created_by: U.DRV3, park_task_id: r.parkTask },
      'ticket.intake_submitted': {
        ticket,
        channel: 'whatsapp',
        inspection_status: 'incomplete',
        payment_status: 'due',
        wa_link_status: 'pending_send',
      },
      'ticket.parked': {
        ticket,
        task_id: r.parkTask,
        task_type: 'park',
        parking_spot_id: SEED_IDS.spots['A-01'],
        has_spot_note: false,
        key_slot_id: SEED_IDS.keySlots.RMS['1'],
        parked_by: U.DRV3,
      },
      'ticket.retrieval_requested': {
        ticket,
        cycle_id: r.cycle,
        cycle_no: 1,
        task_id: r.task,
        requested_at: '2026-10-27T15:30:00.000Z',
        request_source: 'staff',
        requested_early: false,
      },
      'ticket.retrieval_requested_early': {
        ticket,
        pending_retrieval_at: AT,
        request_source: 'whatsapp',
        requested_by_customer_id: SEED_IDS.customers.CUS1,
        parking_task_assignee_id: U.DRV3,
      },
      'ticket.assigned': { ticket, cycle_id: r.cycle, task_id: r.task, assignee_id: U.DRV3, via: 'single' },
      'ticket.assigned_waiting': {
        ticket,
        cycle_id: r.cycle,
        task_id: r.task,
        assignee_id: U.DRV3,
        via: 'broadcast',
      },
      'ticket.retrieving': { ticket, cycle_id: r.cycle, task_id: r.task, retrieved_by: U.DRV3 },
      'ticket.ready': {
        ticket,
        cycle_id: r.cycle,
        task_id: r.task,
        expected_method: 'code',
        claim_code_id: null,
      },
      'ticket.delivered': {
        ticket,
        cycle_id: r.cycle,
        delivered_by: U.DRV3,
        method: 'code',
        payment_status: 'collected',
      },
      'ticket.reparking': {
        ticket,
        closed_cycle_id: r.cycle,
        repark_task_id: r.parkTask,
        assignee_id: U.DRV3,
        cause: 'customer_absent',
        reason: 'the customer 0551234567 did not come',
      },
      'ticket.retrieval_canceled': {
        ticket,
        cycle_id: r.cycle,
        previous_status: 'assigned',
        canceled_by: U['SUP-R'],
        reason: 'call +966551234567',
      },
      'ticket.voided': { ticket, voided_by: U['SUP-R'], reason: 'plate 1234 ب ح د', via: 'void' },
      'ticket.customer_phone_changed': { ticket, changed_by: U.DRV3, reason: 'typo', link_version: 2 },
      'ticket.wa_link_changed': {
        ticket,
        from: 'pending_send',
        to: 'linked',
        method: 'provider_accepted',
        link_version: 2,
        notification_id: null,
      },
      'ticket.inspection_completed': { ticket, media_id: randomUUID() },
      'ticket.inspection_exception_approved': { ticket, approved_by: U['SUP-R'], reason: 'rain' },
      'ticket.manually_reconciled': {
        ticket,
        previous_status: 'retrieving',
        target_status: 'delivered',
        reconciled_by: U['SUP-R'],
        reason: 'paper log',
        paper_log_ref: 'B-12',
      },
      'task.created': {
        task_id: r.task,
        ticket_id: r.ticket,
        type: 'retrieve',
        status: 'queued',
        cycle_id: r.cycle,
        assignee_id: null,
        priority_at: '2026-10-27T15:30:00.000Z',
      },
      'task.offered': {
        task_id: r.task,
        ticket_id: r.ticket,
        offer_id: r.offer,
        round_no: 1,
        recipient_id: U.DRV3,
        expires_at: AT,
        reminder_at: AT,
      },
      'task.broadcast_opened': {
        task_id: r.task,
        ticket_id: r.ticket,
        offer_id: r.offer,
        round_no: 2,
        recipients: [
          { user_id: U.DRV3, eligible_as: 'accept' },
          { user_id: U.DRV4, eligible_as: 'reserve_next' },
          { user_id: U.DRV5, eligible_as: 'view_only' },
        ],
        reminder_at: AT,
      },
      'task.broadcast_extended': {
        task_id: r.task,
        offer_id: r.offer,
        added: [{ user_id: U.DRV6, eligible_as: 'accept' }],
      },
      'task.claimed': {
        task_id: r.task,
        ticket_id: r.ticket,
        offer_id: r.offer,
        mode: 'single',
        claimed_by: U.DRV3,
        result: 'accepted',
        claimed_at: '2026-10-27T15:31:00.000Z',
        other_recipient_ids: [],
      },
      'task.promoted': {
        task_id: r.task,
        ticket_id: r.ticket,
        assignee_id: U.DRV3,
        after_task_id: r.parkTask,
      },
      'task.key_picked_up': { task_id: r.task, ticket_id: r.ticket, assignee_id: U.DRV3, key_slot_id: null },
      'task.started': {
        task_id: r.task,
        ticket_id: r.ticket,
        type: 'retrieve',
        assignee_id: U.DRV3,
        started_at: '2026-10-27T15:35:00.000Z',
      },
      'task.completed': {
        task_id: r.task,
        ticket_id: r.ticket,
        type: 'retrieve',
        assignee_id: U.DRV3,
        completed_at: AT,
      },
      'task.canceled': {
        task_id: r.task,
        ticket_id: r.ticket,
        type: 'retrieve',
        previous_status: 'offered',
        assignee_id: null,
        cancel_reason: 'supervisor_cancel',
        canceled_by: U['SUP-R'],
      },
      'task.withdrawn': {
        task_id: r.task,
        ticket_id: r.ticket,
        from_assignee_id: U.DRV3,
        previous_status: 'accepted',
        reason: 'transfer',
        trigger: 'transfer',
      },
      'task.reassigned': {
        task_id: r.task,
        ticket_id: r.ticket,
        from_assignee_id: U.DRV3,
        to_assignee_id: U.DRV4,
        result_status: 'accepted',
        reason: 'closer',
        priority_override: false,
        trigger: 'reassign',
      },
      'task.escalated': {
        task_id: r.task,
        ticket_id: r.ticket,
        queued_at: '2026-10-27T15:30:00.000Z',
        waited_s: 60,
        on_duty_count: 3,
      },
      'offer.reminded': { offer_id: r.offer, task_id: r.task, mode: 'single', recipient_ids: [U.DRV3] },
      'offer.expired': { offer_id: r.offer, task_id: r.task, recipient_id: U.DRV3 },
      'offer.revoked': {
        offer_id: r.offer,
        task_id: r.task,
        mode: 'single',
        close_reason: 'recipient_unavailable',
        recipient_ids: [U.DRV3],
      },
      'driver.duty_started': {
        user_id: U.DRV3,
        duty_session_id: r.duty,
        shift_id: SEED_IDS.shifts['SHF-R'],
        dispatch_pool_id: POOL_R,
      },
      'driver.break_started': { user_id: U.DRV3, duty_session_id: r.duty },
      'driver.break_ended': { user_id: U.DRV3, duty_session_id: r.duty },
      'driver.duty_ended': { user_id: U.DRV3, duty_session_id: r.duty, end_reason: 'self', ended_by: U.DRV3 },
      'driver.availability_changed': {
        user_id: U.DRV3,
        duty_session_id: r.duty,
        driver_state: 'available',
        available_since: AT,
        active_task_id: null,
        next_task_id: null,
      },
      'driver.connection_changed': {
        user_id: U.DRV3,
        duty_session_id: r.duty,
        from: 'offline',
        to: 'online',
      },
      'driver.transfer_requested': {
        transfer_id: randomUUID(),
        driver_id: U.DRV3,
        from_venue_id: RMS,
        to_venue_id: SEED_IDS.venues.LYL,
        scheduled_at: '2026-10-27T16:45:00.000Z',
        requested_by: U.ADM1,
      },
      'driver.transfer_blocked': {
        transfer_id: randomUUID(),
        driver_id: U.DRV3,
        items: [
          { type: 'key', ticket_id: r.ticket },
          { type: 'task', ticket_id: r.ticket, task_id: r.task },
        ],
      },
      'driver.transferred': {
        transfer_id: randomUUID(),
        driver_id: U.DRV3,
        from_venue_id: RMS,
        to_venue_id: SEED_IDS.venues.LYL,
        ended_assignment_id: null,
        new_assignment_id: randomUUID(),
        returned_task_ids: [],
      },
      'driver.disabled': { user_id: U.DRV3, disabled_by: U.ADM1, reason: 'left', returned_task_ids: [] },
      'driver.enabled': { user_id: U.DRV3, enabled_by: U.ADM1 },
      'custody.changed': {
        ticket_id: r.ticket,
        custody_event_id: randomUUID(),
        subject: 'key',
        from: { type: 'key_slot', id: SEED_IDS.keySlots.RMS['1'] },
        to: { type: 'driver', id: U.DRV3 },
        reason: 'key_pickup',
        task_id: r.task,
      },
      'handover.code_issued': {
        ticket_id: r.ticket,
        cycle_id: r.cycle,
        claim_code_id: randomUUID(),
        expires_at: AT,
        resend_no: 1,
      },
      'handover.code_attempt_failed': {
        ticket_id: r.ticket,
        claim_code_id: randomUUID(),
        attempts: 2,
        attempts_left: 3,
      },
      'handover.code_locked': { ticket_id: r.ticket, claim_code_id: randomUUID() },
      'handover.completed': {
        ticket_id: r.ticket,
        cycle_id: r.cycle,
        method: 'code',
        delivered_by: U.DRV3,
        approved_by: null,
      },
      'handover.exception_approved': {
        ticket_id: r.ticket,
        cycle_id: r.cycle,
        approved_by: U['SUP-R'],
        reason: 'id checked',
        incident_id: randomUUID(),
      },
      'payment.recorded': {
        payment_id: r.payment,
        ticket_id: r.ticket,
        method: 'cash',
        amount_halalas: 2000,
        collected_by: U.DRV3,
      },
      'payment.reversed': {
        payment_id: r.payment,
        ticket_id: r.ticket,
        reversed_by: U['SUP-R'],
        reason: 'wrong',
        ticket_delivered: true,
        incident_id: null,
      },
      'payment.waived': { ticket_id: r.ticket, waived_by: U['SUP-R'], reason: 'vip' },
      'cash.handover_recorded': { cash_handover_id: r.cashHandover },
      // V2-022 (DEC-522): the visit paid in the app, and its full refund before the handover
      'payment.online_paid': { ticket_id: r.ticket, online_payment_id: randomUUID(), amount_halalas: 2000 },
      'payment.online_refunded': {
        ticket_id: r.ticket,
        online_payment_id: randomUUID(),
        amount_halalas: 2000,
      },
      'alert.raised': {
        alert_id: r.alert,
        type: 'request_unaccepted',
        severity: 'critical',
        dedupe_key: 'request_unaccepted:x',
        ticket_id: r.ticket,
        task_id: r.task,
        user_id: null,
      },
      'alert.acknowledged': {
        alert_id: r.alert,
        type: 'request_unaccepted',
        status: 'acknowledged',
        by: U['SUP-R'],
        auto: false,
      },
      'alert.resolved': {
        alert_id: r.alert,
        type: 'request_unaccepted',
        status: 'resolved',
        by: null,
        auto: true,
      },
      'incident.opened': {
        incident_id: r.incident,
        type: 'vehicle_damage',
        status: 'open',
        severity: 'high',
        ticket_id: r.ticket,
      },
      'incident.updated': {
        incident_id: r.incident,
        type: 'vehicle_damage',
        status: 'in_review',
        severity: 'high',
        ticket_id: r.ticket,
      },
      'incident.resolved': {
        incident_id: r.incident,
        type: 'vehicle_damage',
        status: 'resolved',
        severity: 'high',
        ticket_id: r.ticket,
      },
      'event.opened': { event_id: SEED_IDS.events['EVT-R2'], status: 'open', by: U['SUP-R'] },
      'event.closing_started': { event_id: SEED_IDS.events['EVT-R2'], status: 'closing', by: U['SUP-R'] },
      'event.closed': { event_id: SEED_IDS.events['EVT-R2'], status: 'closed', by: U['SUP-R'] },
      'shift.opened': {
        shift_id: SEED_IDS.shifts['SHF-R'],
        dispatch_pool_id: POOL_R,
        status: 'open',
        by: U['SUP-R'],
      },
      'shift.closed': {
        shift_id: SEED_IDS.shifts['SHF-R'],
        dispatch_pool_id: POOL_R,
        status: 'closed',
        by: U['SUP-R'],
      },
      'wa.inbound_received': {
        whatsapp_message_id: r.message,
        kind: 'inbound_button',
        customer_id: SEED_IDS.customers.CUS1,
        ticket_id: r.ticket,
      },
      'wa.button_pressed': {
        whatsapp_message_id: r.message,
        ticket_id: r.ticket,
        customer_id: SEED_IDS.customers.CUS1,
        outcome: 'rejected',
        reject_reason: 'sender_mismatch',
      },
      'wa.message_status_changed': {
        whatsapp_message_id: r.message,
        notification_id: null,
        ticket_id: r.ticket,
        purpose: 'W-05',
        status: 'failed',
        status_rank: 1,
        error_code: '131026',
      },
      'wa.channel_health_changed': { channel_id: SEED_IDS.whatsappChannel, from: 'healthy', to: 'degraded' },
      'wa.customer_opted_out': { customer_id: SEED_IDS.customers.CUS1, affected_ticket_ids: [r.ticket] },
    };
    return P[type]!;
  };

  const actorFor = (type: string) =>
    type.startsWith('wa.')
      ? { type: 'customer' as const, id: null }
      : type.startsWith('alert.') || type === 'task.escalated' || type.startsWith('offer.expired')
        ? { type: 'system' as const, id: null }
        : { type: 'user' as const, id: U.DRV3 };

  const aggregateFor = (type: string) => {
    if (type.startsWith('ticket.')) return { type: 'ticket', id: r.ticket!, version: 7 };
    if (type.startsWith('task.') || type.startsWith('offer.'))
      return { type: 'task', id: r.task!, version: 3 };
    if (type.startsWith('driver.')) return { type: 'duty_session', id: r.duty!, version: 2 };
    if (type.startsWith('payment.')) return { type: 'payment', id: r.payment!, version: null };
    if (type.startsWith('alert.')) return { type: 'alert', id: r.alert!, version: null };
    if (type.startsWith('incident.')) return { type: 'incident', id: r.incident!, version: 2 };
    if (type.startsWith('event.')) return { type: 'event', id: SEED_IDS.events['EVT-R2'], version: 2 };
    if (type.startsWith('shift.')) return { type: 'shift', id: SEED_IDS.shifts['SHF-R'], version: 2 };
    return { type: 'whatsapp_message', id: r.message!, version: null };
  };

  const emit = (type: DomainEventType, payload = payloadFor(type)) =>
    t.db.transaction((tx) =>
      emitEvent(tx, {
        type,
        orgId: ORG,
        venueId: RMS,
        dispatchPoolId: POOL_R,
        eventId: SEED_IDS.events['EVT-R2'],
        aggregate: aggregateFor(type),
        actor: actorFor(type),
        payload,
      }),
    );

  beforeAll(async () => {
    t = await seededDb();
    t.clock.set(AT);
    const event = SEED_IDS.events['EVT-R2']; // per_vehicle, 2000
    r.ticket = await insertTicket(t.db, {
      eventId: event,
      status: 'ready',
      createdAt: '2026-10-27T15:00:00Z',
      submittedAt: '2026-10-27T15:02:00Z',
      feeHalalas: 2000,
      paymentStatus: 'collected',
      waLinkStatus: 'linked',
    });
    r.cycle = randomUUID();
    await t.db.query(
      `INSERT INTO retrieval_cycles (id, org_id, venue_id, ticket_id, cycle_no, requested_at, request_source, requested_by_user_id,
                                     request_reason, assigned_at, accepted_by, started_at, ready_at, handover_method)
       VALUES ($1, $2, $3, $4, 1, '2026-10-27T15:30:00Z', 'staff', $5, 'test', '2026-10-27T15:31:00Z', $6,
               '2026-10-27T15:35:00Z', '2026-10-27T15:40:00Z', 'code')`,
      [r.cycle, ORG, RMS, r.ticket, U['SUP-R'], U.DRV3],
    );
    r.parkTask = randomUUID();
    await t.db.query(
      `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status, priority_at, assignee_id,
                          started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'park', 'completed', '2026-10-27T15:02:00Z', $7, '2026-10-27T15:02:00Z',
               '2026-10-27T15:06:00Z', '2026-10-27T15:02:00Z')`,
      [r.parkTask, ORG, RMS, POOL_R, event, r.ticket, U.DRV3],
    );
    r.task = randomUUID();
    await t.db.query(
      `INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at,
                          assignee_id, queued_at, first_offered_at, claimed_at, accepted_at, key_picked_up_at, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'retrieve', 'in_progress', '2026-10-27T15:30:00Z', $8, '2026-10-27T15:30:00Z',
               '2026-10-27T15:30:30Z', '2026-10-27T15:31:00Z', '2026-10-27T15:31:00Z', '2026-10-27T15:33:00Z',
               '2026-10-27T15:35:00Z', '2026-10-27T15:30:00Z')`,
      [r.task, ORG, RMS, POOL_R, event, r.ticket, r.cycle, U.DRV3],
    );
    r.duty = await insertDuty(t.db, { userId: U.DRV3, startedAt: '2026-10-27T14:00:00Z' });
    r.offer = randomUUID();
    await t.db.query(
      `INSERT INTO task_offers (id, org_id, task_id, dispatch_pool_id, mode, round_no, status, created_at, expires_at, closed_at,
                                close_reason, accepted_by)
       VALUES ($1, $2, $3, $4, 'single', 1, 'accepted', '2026-10-27T15:30:30Z', '2026-10-27T15:31:00Z', '2026-10-27T15:31:00Z',
               'accepted', $5)`,
      [r.offer, ORG, r.task, POOL_R, U.DRV3],
    );
    r.payment = randomUUID();
    await t.db.query(
      `INSERT INTO payments (id, org_id, venue_id, event_id, ticket_id, cycle_id, method, amount_halalas, collected_by, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'cash', 2000, $7, '2026-10-27T15:44:00Z')`,
      [r.payment, ORG, RMS, event, r.ticket, r.cycle, U.DRV3],
    );
    r.cashHandover = randomUUID();
    await t.db.query(
      `INSERT INTO cash_handovers (id, org_id, venue_id, event_id, driver_id, received_by, amount_halalas, expected_halalas)
       VALUES ($1, $2, $3, $4, $5, $6, 1500, 2000)`,
      [r.cashHandover, ORG, RMS, event, U.DRV3, U['SUP-R']],
    );
    await t.db.query(`UPDATE payments SET cash_handover_id = $1 WHERE id = $2`, [r.cashHandover, r.payment]);
    r.alert = randomUUID();
    await t.db.query(
      `INSERT INTO alerts (id, org_id, venue_id, type, severity, dedupe_key, raised_at)
       VALUES ($1, $2, $3, 'request_unaccepted', 'critical', 'request_unaccepted:x', '2026-10-27T15:40:00Z')`,
      [r.alert, ORG, RMS],
    );
    r.incident = randomUUID();
    await t.db.query(
      `INSERT INTO incidents (id, org_id, venue_id, event_id, ticket_id, type, severity, description, opened_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'vehicle_damage', 'high', 'scratch', $6, '2026-10-27T15:15:00Z')`,
      [r.incident, ORG, RMS, event, r.ticket, U['SUP-R']],
    );
    r.message = randomUUID();
    await t.db.query(
      `INSERT INTO whatsapp_messages (id, org_id, channel_id, direction, kind, purpose, status, ticket_id, queued_at, created_at)
       VALUES ($1, $2, $3, 'outbound', 'template', 'W-05', 'failed', $4, '2026-10-27T15:40:00Z', '2026-10-27T15:40:00Z')`,
      [r.message, ORG, SEED_IDS.whatsappChannel, r.ticket],
    );
    await t.db.query(
      `INSERT INTO devices (org_id, user_id, platform, display_mode, notification_permission, audio_test_result, last_seen_at)
       VALUES ($1, $2, 'android', 'standalone', 'granted', 'heard', '2026-10-27T13:59:00Z')`,
      [ORG, U.DRV3],
    );
    dispatcher = new OutboxDispatcher(t.db, t.clock, silentLogger).registerProjector(
      createAnalyticsProjector({ appVersion: '1.2.3', logger: silentLogger }),
    );
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    t.clock.set(AT);
    await t.db.query(`DELETE FROM analytics_events`);
    await t.db.query(`DELETE FROM outbox_events`);
  });

  it('writes exactly one allow-listed row per domain event of canon §7.1, named by 15 §4 (AC1)', async () => {
    const envelopes = new Map<string, DomainEventType>();
    for (const type of DOMAIN_EVENT_TYPES) envelopes.set((await emit(type)).id, type);
    await dispatcher.drain();
    const written = await rows();
    expect(written).toHaveLength(DOMAIN_EVENT_TYPES.length);
    expect(new Set(written.map((w) => w.name))).toEqual(new Set(DOMAIN_EVENT_TYPES.map(analyticsName)));
    for (const w of written) {
      const type = envelopes.get(String(w.properties.source_event_id))!;
      expect(w.name).toBe(analyticsName(type));
      expect(w.source).toBe('server');
      expect(new Date(w.occurred_at).toISOString()).toBe(AT);
      expect(w).toMatchObject({ org_id: ORG, venue_id: RMS, dispatch_pool_id: POOL_R, app_version: '1.2.3' });
      expect(w.event_id).toBe(SEED_IDS.events['EVT-R2']);
      const { source_event_id: _id, ...props } = w.properties;
      expect(serverAnalyticsSchema(type).safeParse(props).success, type).toBe(true);
      // 15 §15 item 3: no phone, no six-digit code, no Arabic text, no plate, no key position, no free text
      expect(findPiiValues(props), type).toEqual([]);
      const text = JSON.stringify(props);
      for (const leak of [
        '0551234567',
        '+966551234567',
        '1234',
        'ب ح د',
        'paper log',
        'B-12',
        'typo',
        'rain',
      ])
        expect(text, `${type} leaks ${leak}`).not.toContain(leak);
      for (const key of ['reason', 'customer_id', 'parking_spot_id', 'key_slot_id', 'code', 'phone'])
        expect(props, `${type} has ${key}`).not.toHaveProperty(key);
      expect(['driver', 'customer', 'system']).toContain(w.actor_role);
      expect(w.actor_id).toBe(w.actor_role === 'driver' ? U.DRV3 : null);
    }
    const st = await t.db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'done'`);
    expect(st.rows[0].n).toBe(DOMAIN_EVENT_TYPES.length);
  });

  it('derives the durations from the stored stamps (15 §13.3) and maps the payloads', async () => {
    for (const type of [
      'ticket.delivered',
      'ticket.intake_submitted',
      'ticket.parked',
      'ticket.assigned',
      'ticket.retrieving',
      'ticket.ready',
      'task.claimed',
      'task.broadcast_opened',
      'task.completed',
      'task.escalated',
      'driver.duty_started',
      'driver.connection_changed',
      'driver.transfer_blocked',
      'payment.reversed',
      'cash.handover_recorded',
      'alert.acknowledged',
      'incident.resolved',
      'wa.button_pressed',
      'wa.message_status_changed',
      'event.opened',
    ] as DomainEventType[])
      await emit(type);
    await dispatcher.drain();
    const by = new Map((await rows()).map((w) => [w.name, w]));
    const props = (name: string) => by.get(name)!.properties;
    expect(props('ticket_delivered')).toMatchObject({
      ready_to_delivered_s: 300, // ready 15:40 → 15:45
      request_to_delivered_s: 900, // requested 15:30
      verification_method: 'code',
      payment_status: 'collected',
      cycle_no: 1,
      ticket_lifetime_s: 2700, // created 15:00
    });
    expect(by.get('ticket_delivered')).toMatchObject({ ticket_id: r.ticket, cycle_id: r.cycle });
    expect(props('ticket_intake_submitted')).toMatchObject({
      channel: 'whatsapp',
      inspection_status: 'incomplete',
      wa_link_method: 'direct',
      has_customer_phone: true,
      intake_duration_s: 120,
      photos_count: 0,
    });
    expect(props('ticket_parked')).toMatchObject({
      spot_mode: 'spot',
      key_slot_used: true,
      is_repark: false,
    });
    expect(props('ticket_assigned')).toMatchObject({ wait_s: 900, offer_mode: 'single', offer_round_no: 1 });
    expect(props('ticket_retrieving')).toMatchObject({ start_after_claim_s: 840, from_next_task: false });
    expect(props('ticket_ready')).toMatchObject({ request_to_ready_s: 900, retrieval_duration_s: 600 });
    expect(props('task_claimed')).toMatchObject({
      mode: 'single',
      round_no: 1,
      result: 'accepted',
      claim_latency_s: 60, // queued 15:30 → claimed 15:31
      offer_latency_s: 30, // offer 15:30:30
    });
    expect(props('task_broadcast_opened')).toMatchObject({
      round_no: 2,
      recipient_count: 3,
      eligible_accept_count: 1,
      eligible_reserve_count: 1,
      view_only_count: 1,
    });
    expect(props('task_completed')).toMatchObject({ type: 'retrieve', duration_s: 840 }); // accepted 15:31
    expect(props('task_escalated')).toMatchObject({
      after_s: 60,
      on_duty_drivers: 3,
      mode_at_escalation: 'none',
    });
    expect(by.get('task_escalated')!.actor_role).toBe('system');
    expect(props('driver_duty_started')).toMatchObject({
      audio_test_result: 'heard',
      notification_permission: 'granted',
      display_mode: 'standalone',
      platform: 'android',
    });
    expect(props('driver_connection_changed')).toMatchObject({
      from: 'offline',
      to: 'online',
      had_custody: false,
      had_active_task: true,
    });
    expect(props('driver_transfer_blocked')).toMatchObject({ blocker_types: ['active_task', 'key'] });
    expect(props('payment_reversed')).toMatchObject({
      method: 'cash',
      amount_halalas: 2000,
      with_replacement: false,
      after_cash_handover: true,
    });
    expect(props('cash_handover_recorded')).toMatchObject({
      amount_halalas: 1500,
      expected_halalas: 2000,
      difference_halalas: -500,
      linked_payments_count: 1,
    });
    expect(props('alert_acknowledged')).toMatchObject({ type: 'request_unaccepted', ack_after_s: 300 });
    expect(props('incident_resolved')).toMatchObject({ type: 'vehicle_damage', open_duration_s: 1800 });
    expect(props('wa_button_pressed')).toMatchObject({ result: 'rejected_sender' });
    expect(by.get('wa_button_pressed')!.actor_role).toBe('customer');
    expect(props('wa_message_status_changed')).toMatchObject({
      purpose: 'W-05',
      status: 'failed',
      error_code: '131026', // a provider code is not mistaken for a handover code
      since_queued_ms: 300_000,
    });
    expect(props('event_opened')).toMatchObject({ pricing_mode: 'per_vehicle' });
  });

  it('is idempotent per event id: a re-queued event does not write a second row', async () => {
    await emit('ticket.delivered');
    await emit('alert.raised');
    await dispatcher.drain();
    expect(await rows()).toHaveLength(2);
    await t.db.query(
      `UPDATE outbox_events SET status = 'pending', attempts = 0, available_at = $1, processed_at = NULL`,
      [AT],
    );
    await dispatcher.drain();
    expect(await rows()).toHaveLength(2);
  });

  it('exactly once across a crash before COMMIT (15 §15.4): rolled back with the event, written on the retry', async () => {
    let crash = true;
    const crashing: EventProjector = {
      name: 'crash-once',
      accepts: () => true,
      async project() {
        if (crash) {
          crash = false;
          throw new Error('worker killed before COMMIT');
        }
      },
    };
    const d = new OutboxDispatcher(t.db, t.clock, silentLogger)
      .registerProjector(createAnalyticsProjector({ logger: silentLogger }))
      .registerProjector(crashing);
    await emit('ticket.parked');
    await d.drain();
    expect(await rows()).toHaveLength(0);
    const row = (await t.db.query(`SELECT status, attempts FROM outbox_events`)).rows[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    t.clock.advanceSeconds(10);
    await d.drain();
    expect(await rows()).toHaveLength(1);
  });

  it('a value outside its list is stored as null; a malformed envelope is dropped, counted, and the row done', async () => {
    const before = (await metrics.analyticsRejected.get()).values.reduce((s, v) => s + v.value, 0);
    // mapped through its closed list by the projection itself: a phone never reaches the row
    await emit('ticket.wa_link_changed', {
      ticket: { ticket_id: r.ticket, display_number: 125, ticket_version: 8 },
      from: '+966551234567',
      to: 'linked',
      method: 'qr',
    });
    // copied as is by the projection, refused by the allow-list: stored as null and counted
    await emit('alert.raised', { alert_id: r.alert, type: 'made_up_type', severity: 'critical' });
    await t.db.query(
      `INSERT INTO outbox_events (org_id, type, payload, available_at) VALUES ($1, 'ticket.created', '{"type":"ticket.created"}', $2)`,
      [ORG, AT],
    );
    await dispatcher.drain();
    const by = new Map((await rows()).map((w) => [w.name, w]));
    expect(by.size).toBe(2);
    expect(by.get('ticket_wa_link_changed')!.properties).toMatchObject({
      from_status: null,
      to_status: 'linked',
      method: 'qr',
    });
    expect(JSON.stringify(by.get('ticket_wa_link_changed')!.properties)).not.toContain('966551234567');
    expect(by.get('alert_raised')!.properties).toMatchObject({ type: null, severity: 'critical' });
    const statuses = (await t.db.query(`SELECT status FROM outbox_events ORDER BY seq`)).rows.map(
      (x) => x.status,
    );
    expect(statuses).toEqual(['done', 'done', 'done']);
    const after = (await metrics.analyticsRejected.get()).values.reduce((s, v) => s + v.value, 0);
    expect(after - before).toBe(2); // the refused value + the malformed envelope
  });

  it('ignores outbox rows that are not canon §7.1 domain events', async () => {
    const projector = createAnalyticsProjector({ logger: silentLogger });
    expect(projector.accepts('ticket.photo_uploaded')).toBe(false);
    expect(projector.accepts('job.dispatch_pass')).toBe(false);
    expect(projector.accepts('ticket.parked')).toBe(true);
  });
});
