import { Inject, Injectable } from '@nestjs/common';
import type { DriverState, VenueSettings } from '@point/shared';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import { alertView, type AlertRow } from '../core/alerts/alerts.js';
import type { Database } from '../core/db/database.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { DATABASE } from '../http/tokens.js';
import { SUMMARY_SELECT, ticketSummary, type TicketSummaryRow } from '../modules/tickets-custody/index.js';
import {
  EVENT_COLUMNS,
  toVenueEvent,
  venueSettingsFor,
  type VenueEventRow,
} from '../modules/venues-events/index.js';
import { activeChannel } from '../modules/whatsapp/index.js';
import { WA_MESSAGE_COLUMNS, waMessageView, type WaMessageRow } from './supervisor-views.js';
import { loadTaskCard } from './views.js';

/** Escalation badges of S-02 (02): «متأخر» · «انتظار طويل» · «لم تُستلم». */
export type BoardBadge = 'late' | 'long_wait' | 'not_collected';

const secondsSince = (from: Date | string | null | undefined, now: Date): number | null =>
  from == null ? null : Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 1000));
const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

/** The waiting window of the failed messages shown on the board (15 §11.1: «الرسائل الفاشلة آخر 30 دقيقة»). */
export const FAILED_MESSAGES_WINDOW_MS = 30 * 60_000;
/** The accept-time KPI window (02 S-02 «متوسط القبول (آخر 30 دقيقة)», 15 KPI-01). */
export const ACCEPT_KPI_WINDOW_MS = 30 * 60_000;

const SEVERITY_RANK = `CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;

interface QueueRow extends TicketSummaryRow {
  task_id: string;
  task_status: string;
  priority_at: Date;
  seq: number;
  queued_at: Date | null;
  escalated_at: Date | null;
  assigned_waiting_at: Date | null;
  assignee_id: string | null;
  assignee_full_name: string | null;
  assignee_employee_code: string | null;
  requested_at: Date;
  offer_id: string | null;
  offer_mode: 'single' | 'broadcast' | null;
  round_no: number | null;
  offer_expires_at: Date | null;
  recipients: number | null;
  recipient_id: string | null;
  recipient_full_name: string | null;
  recipient_employee_code: string | null;
}

const userRef = (id: string | null, name: string | null, code: string | null) =>
  id ? { id, full_name: name ?? '', ...(code ? { employee_code: code } : {}) } : null;

/**
 * `GET /v1/events/{eventId}/operations` (PNT-074; S-02, 15 §11.1): the full snapshot the supervisor board syncs
 * from (07 §4: on connect, reconnect and `sync.required`); live updates follow on `venue:{venueId}:supervisors`.
 * Read in one REPEATABLE READ snapshot so every section describes the same instant (`tx.now`).
 *
 * - `kpis`: 02 S-02 / 15 §11.1 — open requests = tickets `requested|assigned|assigned_waiting|retrieving`;
 *   oldest wait from `v_pool_queue`; accept time = KPI-01 (`claimed_at − queued_at`) over the last 30 minutes;
 *   driver counts from `v_driver_state` of the event's pool.
 * - `queue`: the requests nobody is moving yet, oldest first (`priority_at`, `seq`): the unaccepted demand of
 *   `v_pool_queue` and the reserved next tasks (`assigned_waiting`, «محجوز تالٍ»), with waiting time, the live
 *   round and the escalation badges.
 * - `active_tasks` (accepted / in_progress, every type) and `next_tasks` (assigned_waiting) as TaskCards.
 * - `alerts`: live alerts of the venue (pool-wide ones and those of this event), most severe first.
 * - `failed_messages`: outbound WhatsApp failures of the event in the last 30 minutes.
 * - `custody_issues`: S-02 «العهدة».
 */
@Injectable()
export class OperationsBoardQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  execute(actor: ActorContext, eventId: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const ev = await tx.maybeOne<VenueEventRow>(
        `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1 AND e.org_id = $2`,
        [eventId, actor.orgId],
      );
      // 08 §1.3 rule 4: an event outside the caller's venues does not exist for him
      if (!ev || !actor.venueIds.has(ev.venue_id))
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'event' });
      const settings = await venueSettingsFor(tx, ev.venue_id);
      const now = tx.now;
      const viewer = { userId: actor.userId, role: actor.role };

      const queue = await this.queue(tx, ev, settings, now);
      const active = await this.taskCards(tx, ev.id, ['accepted', 'in_progress'], viewer, settings, now);
      const next = await this.taskCards(tx, ev.id, ['assigned_waiting'], viewer, settings, now);
      const drivers = await this.drivers(tx, ev.dispatch_pool_id);
      return {
        event: toVenueEvent(ev),
        kpis: await this.kpis(tx, ev, drivers, now),
        queue,
        active_tasks: active,
        next_tasks: next,
        drivers,
        alerts: await this.alerts(tx, ev),
        failed_messages: await this.failedMessages(tx, ev.id, now),
        custody_issues: await this.custodyIssues(tx, ev.id, settings, now),
        channel_health: (await activeChannel(tx, actor.orgId))?.health_status ?? ('down' as const),
      };
    });
  }

  private async kpis(tx: Tx, ev: VenueEventRow, drivers: { driver_state: DriverState }[], now: Date) {
    const t = await tx.one<{ open_requests: number; vehicles_parked: number; ready_waiting: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('requested','assigned','assigned_waiting','retrieving'))::int AS open_requests,
              count(*) FILTER (WHERE status = 'parked')::int AS vehicles_parked,
              count(*) FILTER (WHERE status = 'ready')::int AS ready_waiting
         FROM tickets WHERE event_id = $1`,
      [ev.id],
    );
    const oldest = await tx.one<{ oldest: Date | null }>(
      `SELECT min(q.priority_at) AS oldest FROM v_pool_queue q JOIN tasks k ON k.id = q.task_id
        WHERE q.dispatch_pool_id = $1 AND k.event_id = $2`,
      [ev.dispatch_pool_id, ev.id],
    );
    const accept = await tx.one<{ avg_s: number | null }>(
      `SELECT round(avg(EXTRACT(EPOCH FROM (claimed_at - queued_at)))::numeric, 1) AS avg_s
         FROM tasks
        WHERE event_id = $1 AND type = 'retrieve' AND claimed_at IS NOT NULL AND queued_at IS NOT NULL
          AND claimed_at > $2 AND claimed_at <= $3`,
      [ev.id, new Date(now.getTime() - ACCEPT_KPI_WINDOW_MS), now],
    );
    const count = (states: DriverState[]) => drivers.filter((d) => states.includes(d.driver_state)).length;
    return {
      open_requests: t.open_requests,
      oldest_wait_seconds: secondsSince(oldest.oldest, now),
      avg_accept_seconds_30m: accept.avg_s == null ? null : Number(accept.avg_s),
      drivers_available: count(['available']),
      drivers_busy: count(['intake_parking', 'retrieving', 'busy_with_next']),
      drivers_on_break: count(['on_break']),
      drivers_on_duty: drivers.length,
      vehicles_parked: t.vehicles_parked,
      ready_waiting: t.ready_waiting,
    };
  }

  private async queue(tx: Tx, ev: VenueEventRow, settings: VenueSettings, now: Date) {
    const rows = await tx.rows<QueueRow>(
      `WITH demand AS (
         SELECT q.task_id, q.active_offer_id FROM v_pool_queue q JOIN tasks k ON k.id = q.task_id
          WHERE q.dispatch_pool_id = $1 AND k.event_id = $2
         UNION ALL
         SELECT k.id, NULL FROM tasks k
          WHERE k.event_id = $2 AND k.type = 'retrieve' AND k.status = 'assigned_waiting')
       SELECT s.*, k.id AS task_id, k.status AS task_status, k.priority_at, k.seq, k.queued_at, k.escalated_at,
              k.assigned_waiting_at, k.assignee_id, au.full_name AS assignee_full_name,
              au.employee_code AS assignee_employee_code, c.requested_at,
              o.id AS offer_id, o.mode AS offer_mode, o.round_no, o.expires_at AS offer_expires_at,
              (SELECT count(*)::int FROM offer_recipients r WHERE r.offer_id = o.id) AS recipients,
              ru.id AS recipient_id, ru.full_name AS recipient_full_name, ru.employee_code AS recipient_employee_code
         FROM demand d
         JOIN tasks k ON k.id = d.task_id
         JOIN retrieval_cycles c ON c.id = k.cycle_id
         JOIN (${SUMMARY_SELECT}) s ON s.id = k.ticket_id
         LEFT JOIN users au ON au.id = k.assignee_id
         LEFT JOIN task_offers o ON o.id = d.active_offer_id
         LEFT JOIN LATERAL (
           SELECT u.id, u.full_name, u.employee_code FROM offer_recipients r JOIN users u ON u.id = r.user_id
            WHERE r.offer_id = o.id AND o.mode = 'single' ORDER BY r.user_id LIMIT 1) ru ON true
        ORDER BY k.priority_at, k.seq`,
      [ev.dispatch_pool_id, ev.id],
    );
    const escalateMs = settings.dispatch.unaccepted_escalation_s * 1000;
    const nextWaitMs = settings.dispatch.next_task_wait_alert_s * 1000;
    return rows.map((r) => {
      const badges: BoardBadge[] = [];
      if (r.task_status === 'assigned_waiting') {
        if (r.assigned_waiting_at && now.getTime() - new Date(r.assigned_waiting_at).getTime() >= nextWaitMs)
          badges.push('long_wait');
      } else if (
        r.escalated_at ||
        (r.queued_at && now.getTime() - new Date(r.queued_at).getTime() >= escalateMs)
      ) {
        badges.push('late');
      }
      return {
        task_id: r.task_id,
        ticket: ticketSummary(r),
        status: r.task_status,
        requested_at: iso(r.requested_at)!,
        waiting_seconds: secondsSince(r.requested_at, now)!,
        offer: r.offer_id
          ? {
              offer_id: r.offer_id,
              mode: r.offer_mode!,
              round_no: r.round_no!,
              expires_at: iso(r.offer_expires_at),
              recipients: r.recipients ?? 0,
              // «معروض على {سائق}» (S-02): the recipient of a single round
              recipient: userRef(r.recipient_id, r.recipient_full_name, r.recipient_employee_code),
            }
          : null,
        escalated_at: iso(r.escalated_at),
        assignee: userRef(r.assignee_id, r.assignee_full_name, r.assignee_employee_code),
        badges,
      };
    });
  }

  private async taskCards(
    tx: Tx,
    eventId: string,
    statuses: string[],
    viewer: { userId: string; role: ActorContext['role'] },
    settings: VenueSettings,
    now: Date,
  ) {
    const rows = await tx.rows<{
      id: string;
      status: string;
      type: string;
      assigned_waiting_at: Date | null;
      ticket_status: string;
      ready_at: Date | null;
    }>(
      `SELECT k.id, k.status, k.type, k.assigned_waiting_at, t.status AS ticket_status, c.ready_at
         FROM tasks k JOIN tickets t ON t.id = k.ticket_id LEFT JOIN retrieval_cycles c ON c.id = k.cycle_id
        WHERE k.event_id = $1 AND k.status = ANY($2::text[])
        ORDER BY k.priority_at, k.seq`,
      [eventId, statuses],
    );
    const uncollectedMs = settings.ready.uncollected_alert_min * 60_000;
    const nextWaitMs = settings.dispatch.next_task_wait_alert_s * 1000;
    const cards = [];
    for (const r of rows) {
      const card = await loadTaskCard(tx, r.id, viewer, now, { maxResends: settings.handover.max_resends });
      if (!card) continue;
      const badges: BoardBadge[] = [];
      if (
        r.ticket_status === 'ready' &&
        r.ready_at &&
        now.getTime() - new Date(r.ready_at).getTime() >= uncollectedMs
      )
        badges.push('not_collected');
      if (
        r.status === 'assigned_waiting' &&
        r.assigned_waiting_at &&
        now.getTime() - new Date(r.assigned_waiting_at).getTime() >= nextWaitMs
      )
        badges.push('long_wait');
      cards.push({ ...card, badges });
    }
    return cards;
  }

  private async drivers(tx: Tx, poolId: string) {
    const rows = await tx.rows<{
      user_id: string;
      full_name: string;
      employee_code: string | null;
      driver_state: DriverState;
      connection_state: string | null;
      last_heartbeat_at: Date | null;
      available_since: Date | null;
      active_task_id: string | null;
      next_task_id: string | null;
      duty_started_at: Date | null;
    }>(
      `SELECT s.user_id, u.full_name, u.employee_code, s.driver_state, s.connection_state, s.last_heartbeat_at,
              s.available_since, s.active_task_id, s.next_task_id, d.started_at AS duty_started_at
         FROM v_driver_state s JOIN users u ON u.id = s.user_id JOIN duty_sessions d ON d.id = s.duty_session_id
        WHERE s.dispatch_pool_id = $1
        ORDER BY (s.driver_state = 'available') DESC, s.available_since ASC NULLS LAST, u.full_name, s.user_id`,
      [poolId],
    );
    return rows.map((r) => ({
      driver: userRef(r.user_id, r.full_name, r.employee_code)!,
      driver_state: r.driver_state,
      connection_state: r.connection_state,
      last_heartbeat_at: iso(r.last_heartbeat_at),
      available_since: iso(r.available_since),
      active_task_id: r.active_task_id,
      next_task_id: r.next_task_id,
      duty_started_at: iso(r.duty_started_at),
    }));
  }

  private async alerts(tx: Tx, ev: VenueEventRow) {
    const rows = await tx.rows<AlertRow>(
      `SELECT a.* FROM alerts a
        WHERE a.venue_id = $1 AND a.status <> 'resolved' AND (a.event_id IS NULL OR a.event_id = $2)
        ORDER BY ${SEVERITY_RANK}, a.raised_at DESC, a.id DESC
        LIMIT 200`,
      [ev.venue_id, ev.id],
    );
    return rows.map(alertView);
  }

  private async failedMessages(tx: Tx, eventId: string, now: Date) {
    const rows = await tx.rows<WaMessageRow>(
      `SELECT ${WA_MESSAGE_COLUMNS} FROM whatsapp_messages m
        WHERE m.direction = 'outbound' AND m.status = 'failed'
          AND (m.event_id = $1 OR m.ticket_id IN (SELECT id FROM tickets WHERE event_id = $1))
          AND COALESCE(m.failed_at, m.created_at) > $2
        ORDER BY COALESCE(m.failed_at, m.created_at) DESC, m.id DESC
        LIMIT 100`,
      [eventId, new Date(now.getTime() - FAILED_MESSAGES_WINDOW_MS)],
    );
    return rows.map((m) => waMessageView(m));
  }

  /**
   * S-02 «العهدة»: every vehicle or key of an open ticket of the event whose holder needs a supervisor's eye —
   * holder `unknown` or `supervisor` (outside the spots and slots); a driver who is off duty or not `online`;
   * a driver who holds it without an open task on the ticket; or an intake draft left in `received` beyond
   * `intake.draft_abandoned_alert_min`. `since` = the last custody event of that subject.
   */
  private async custodyIssues(tx: Tx, eventId: string, settings: VenueSettings, now: Date) {
    const draftMs = settings.intake.draft_abandoned_alert_min * 60_000;
    const rows = await tx.rows<
      TicketSummaryRow & {
        subject: 'vehicle' | 'key';
        holder_type: string;
        holder_id: string | null;
        holder_name: string | null;
        holder_connection: string | null;
        holder_has_task: boolean;
        since: Date | null;
      }
    >(
      `WITH items AS (
         SELECT t.id AS ticket_id, 'vehicle'::text AS subject, t.vehicle_holder_type AS holder_type,
                t.vehicle_holder_id AS holder_id
           FROM tickets t WHERE t.event_id = $1 AND t.status NOT IN ('delivered','voided')
         UNION ALL
         SELECT t.id, 'key', t.key_holder_type, t.key_holder_id
           FROM tickets t WHERE t.event_id = $1 AND t.status NOT IN ('delivered','voided'))
       SELECT s.*, i.subject, i.holder_type, i.holder_id, u.full_name AS holder_name,
              ds.connection_state AS holder_connection,
              EXISTS (SELECT 1 FROM tasks k WHERE k.ticket_id = i.ticket_id AND k.assignee_id = i.holder_id
                        AND k.status NOT IN ('completed','canceled')) AS holder_has_task,
              (SELECT max(ce.occurred_at) FROM custody_events ce
                WHERE ce.ticket_id = i.ticket_id AND ce.subject = i.subject) AS since
         FROM items i
         JOIN (${SUMMARY_SELECT}) s ON s.id = i.ticket_id
         LEFT JOIN users u ON i.holder_type IN ('driver','supervisor') AND u.id = i.holder_id
         LEFT JOIN duty_sessions ds ON i.holder_type = 'driver' AND ds.user_id = i.holder_id AND ds.status <> 'ended'
        WHERE i.holder_type IN ('driver','supervisor','unknown')
        ORDER BY s.display_number, i.subject DESC`,
      [eventId],
    );
    const out = [];
    for (const r of rows) {
      let issue = r.holder_type !== 'driver';
      if (!issue) {
        const draftAbandoned =
          r.status === 'received' && now.getTime() - new Date(r.created_at).getTime() >= draftMs;
        issue = r.holder_connection !== 'online' || !r.holder_has_task || draftAbandoned;
      }
      if (!issue) continue;
      out.push({
        ticket: ticketSummary(r),
        subject: r.subject,
        holder: { type: r.holder_type, id: r.holder_id, label: r.holder_name },
        since: iso(r.since ?? r.created_at)!,
      });
    }
    return out;
  }
}
