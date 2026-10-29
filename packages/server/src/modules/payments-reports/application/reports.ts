import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import { AppError } from '../../../core/errors/app-error.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import type { TicketQueryable } from '../../tickets-custody/index.js';
import { EVENT_COLUMNS, toVenueEvent, type VenueEventRow } from '../../venues-events/index.js';
import { ReportCursorCodec } from '../infra/cursor.js';
import { assertNamedVenue, findEventInScope } from './scope.js';
import { WA_MESSAGE_COLUMNS, loadUserRefs, refOf, waMessageView, type WaMessageRow } from './views.js';

/**
 * Reports (PNT-088; 07 §2.7, 15 §10 KPI definitions; 09 §3 `report.read`: owner, admin and supervisors within
 * their venues; phones never appear). An event addressed by id outside the scope is 404 RESOURCE_NOT_FOUND; a
 * `venue_id` the caller names outside the scope is SCOPE_VENUE_DENIED. Durations are seconds; the cancelled
 * retrieval cycles stay out of the delivery timings and are counted apart (15 §10, FR-RPT-01).
 */

export interface Timing {
  p50: number | null;
  p90: number | null;
  max: number | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Venues a report may read: the named one (SCOPE_VENUE_DENIED outside) or every venue of the scope. */
export function reportVenues(actor: ActorContext, venueId: string | undefined): string[] {
  if (venueId) {
    assertNamedVenue(actor, venueId);
    return [venueId];
  }
  return [...actor.venueIds];
}

export function assertRange(from: string, to: string): void {
  if (Date.parse(from) > Date.parse(to))
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'from', issue: 'after_to' }] });
}

// ------------------------------------------------------------------------------------------------
// event summary (KPI-01 … KPI-07, KPI-09, KPI-11, KPI-12, KPI-13, KPI-14)
// ------------------------------------------------------------------------------------------------

export async function eventSummaryReport(q: TicketQueryable, eventId: string) {
  const ev = (
    await q.query<VenueEventRow>(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`, [eventId])
  ).rows[0]!;
  const counts = (
    await q.query(
      `SELECT count(*)::int AS tickets_total,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status = 'voided')::int AS voided,
              count(*) FILTER (WHERE status NOT IN ('delivered','voided'))::int AS open,
              count(*) FILTER (WHERE status <> 'voided' AND wa_link_status = 'linked')::int AS whatsapp_linked,
              count(*) FILTER (WHERE status <> 'voided' AND channel = 'paper')::int AS paper
         FROM tickets WHERE event_id = $1`,
      [eventId],
    )
  ).rows[0]!;
  const cycles = (
    await q.query(
      `SELECT count(*) FILTER (WHERE rc.outcome = 'reparked')::int AS reparks,
              count(*) FILTER (WHERE rc.outcome = 'canceled')::int AS canceled_requests
         FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id WHERE tk.event_id = $1`,
      [eventId],
    )
  ).rows[0]!;
  const timings = (
    await q.query<{ k: string; p50: number | null; p90: number | null; max: number | null }>(
      `WITH acc AS (
         SELECT EXTRACT(EPOCH FROM (t.claimed_at - t.queued_at))::float8 AS s FROM tasks t
          WHERE t.event_id = $1 AND t.type = 'retrieve' AND t.claimed_at IS NOT NULL AND t.queued_at IS NOT NULL
       ), st AS (
         SELECT EXTRACT(EPOCH FROM (t.started_at - t.accepted_at))::float8 AS s FROM tasks t
          WHERE t.event_id = $1 AND t.type = 'retrieve' AND t.started_at IS NOT NULL AND t.accepted_at IS NOT NULL
       ), rr AS (
         SELECT EXTRACT(EPOCH FROM (rc.ready_at - rc.requested_at))::float8 AS s
           FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id
          WHERE tk.event_id = $1 AND rc.ready_at IS NOT NULL AND rc.outcome IN ('delivered','reparked')
       ), rd AS (
         SELECT EXTRACT(EPOCH FROM (rc.delivered_at - rc.ready_at))::float8 AS s
           FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id
          WHERE tk.event_id = $1 AND rc.outcome = 'delivered' AND rc.ready_at IS NOT NULL AND rc.delivered_at IS NOT NULL
       )
       SELECT 'accept' AS k, percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90, max(s) AS max FROM acc
       UNION ALL SELECT 'start', percentile_cont(0.5) WITHIN GROUP (ORDER BY s), percentile_cont(0.9) WITHIN GROUP (ORDER BY s), max(s) FROM st
       UNION ALL SELECT 'request_to_ready', percentile_cont(0.5) WITHIN GROUP (ORDER BY s), percentile_cont(0.9) WITHIN GROUP (ORDER BY s), max(s) FROM rr
       UNION ALL SELECT 'ready_to_delivered', percentile_cont(0.5) WITHIN GROUP (ORDER BY s), percentile_cont(0.9) WITHIN GROUP (ORDER BY s), max(s) FROM rd`,
      [eventId],
    )
  ).rows;
  const timing = (k: string): Timing => {
    const r = timings.find((x) => x.k === k);
    return { p50: numOrNull(r?.p50), p90: numOrNull(r?.p90), max: numOrNull(r?.max) };
  };
  const offers = (
    await q.query(
      `SELECT count(*) FILTER (WHERE o.mode = 'single')::int AS single,
              count(*) FILTER (WHERE o.mode = 'broadcast')::int AS broadcast,
              count(*) FILTER (WHERE o.status = 'expired')::int AS expired,
              (SELECT count(*)::int FROM tasks x WHERE x.event_id = $1 AND x.type = 'retrieve'
                  AND x.escalated_at IS NOT NULL) AS escalations
         FROM task_offers o JOIN tasks t ON t.id = o.task_id WHERE t.event_id = $1`,
      [eventId],
    )
  ).rows[0]!;
  const messages = (
    await q.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM whatsapp_messages
        WHERE event_id = $1 AND direction = 'outbound' GROUP BY status`,
      [eventId],
    )
  ).rows;
  const msg = (s: string) => num(messages.find((m) => m.status === s)?.n);
  const pay = (
    await q.query(
      `SELECT coalesce(sum(amount_halalas) FILTER (WHERE method = 'cash'), 0) AS cash,
              coalesce(sum(amount_halalas) FILTER (WHERE method = 'pos'), 0) AS pos
         FROM payments WHERE event_id = $1 AND status = 'recorded'`,
      [eventId],
    )
  ).rows[0]!;
  const money = (
    await q.query(
      `SELECT count(*) FILTER (WHERE payment_status = 'waived')::int AS waived,
              count(*) FILTER (WHERE payment_status = 'due')::int AS outstanding
         FROM tickets WHERE event_id = $1 AND status <> 'voided'`,
      [eventId],
    )
  ).rows[0]!;
  const incidents = (
    await q.query(
      `SELECT count(*) FILTER (WHERE status IN ('open','in_review'))::int AS open,
              count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved
         FROM incidents WHERE event_id = $1`,
      [eventId],
    )
  ).rows[0]!;
  const byDriver = (
    await q.query<{
      user_id: string;
      parked: number;
      retrieved: number;
      delivered: number;
      accept_p50_s: number | null;
    }>(
      `WITH k AS (
         SELECT assignee_id AS user_id,
                count(*) FILTER (WHERE type IN ('park','repark') AND status = 'completed')::int AS parked,
                count(*) FILTER (WHERE type = 'retrieve' AND status = 'completed')::int AS retrieved,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (claimed_at - queued_at))::float8)
                  FILTER (WHERE type = 'retrieve' AND claimed_at IS NOT NULL AND queued_at IS NOT NULL) AS accept_p50_s
           FROM tasks WHERE event_id = $1 AND assignee_id IS NOT NULL GROUP BY assignee_id
       ), d AS (
         SELECT rc.delivered_by AS user_id, count(*)::int AS delivered
           FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id
          WHERE tk.event_id = $1 AND rc.outcome = 'delivered' AND rc.delivered_by IS NOT NULL
          GROUP BY rc.delivered_by
       )
       SELECT coalesce(k.user_id, d.user_id) AS user_id, coalesce(k.parked, 0) AS parked,
              coalesce(k.retrieved, 0) AS retrieved, coalesce(d.delivered, 0) AS delivered, k.accept_p50_s
         FROM k FULL OUTER JOIN d ON d.user_id = k.user_id`,
      [eventId],
    )
  ).rows;
  const users = await loadUserRefs(
    q,
    byDriver.map((d) => d.user_id),
  );
  return {
    event: toVenueEvent(ev),
    counts: {
      tickets_total: num(counts.tickets_total),
      delivered: num(counts.delivered),
      voided: num(counts.voided),
      open: num(counts.open),
      reparks: num(cycles.reparks),
      canceled_requests: num(cycles.canceled_requests),
      whatsapp_linked: num(counts.whatsapp_linked),
      paper: num(counts.paper),
    },
    timings_seconds: {
      accept: timing('accept'),
      start: timing('start'),
      request_to_ready: timing('request_to_ready'),
      ready_to_delivered: timing('ready_to_delivered'),
    },
    offers: {
      single: num(offers.single),
      broadcast: num(offers.broadcast),
      expired: num(offers.expired),
      escalations: num(offers.escalations),
    },
    messages: {
      sent: msg('sent'),
      delivered: msg('delivered'),
      read: msg('read'),
      failed: msg('failed'),
      skipped: msg('skipped'),
    },
    payments: {
      cash_halalas: num(pay.cash),
      pos_halalas: num(pay.pos),
      waived: num(money.waived),
      outstanding: num(money.outstanding),
    },
    incidents: { open: num(incidents.open), resolved: num(incidents.resolved) },
    by_driver: byDriver
      .map((d) => ({
        driver: refOf(users, d.user_id)!,
        parked: num(d.parked),
        retrieved: num(d.retrieved),
        delivered: num(d.delivered),
        accept_p50_s: numOrNull(d.accept_p50_s),
      }))
      .sort((a, b) =>
        (a.driver.employee_code ?? a.driver.id).localeCompare(b.driver.employee_code ?? b.driver.id),
      ),
  };
}

// ------------------------------------------------------------------------------------------------
// drivers (15 §11.3; FR-RPT-06: every count belongs to the venue where it happened)
// ------------------------------------------------------------------------------------------------

export interface DriverReportFilters {
  venueIds: string[];
  from: string;
  to: string;
  now: Date;
  limit: number;
  after?: { employee_code: string; user_id: string; venue_id: string } | null;
}

export interface DriverReportRawRow {
  user_id: string;
  full_name: string;
  employee_code: string;
  venue_id: string;
  duty_s: number;
  parked: number;
  retrieved: number;
  delivered: number;
  offers_received: number;
  offers_expired: number;
  accept_p50_s: number | null;
  handover_code_failures: number;
}

export async function driverReportRows(
  q: TicketQueryable,
  f: DriverReportFilters,
): Promise<DriverReportRawRow[]> {
  const r = await q.query<DriverReportRawRow>(
    `WITH duty AS (
       SELECT ds.user_id, ds.venue_id,
              sum(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(coalesce(ds.ended_at, $4::timestamptz), $3::timestamptz)
                                                 - GREATEST(ds.started_at, $2::timestamptz))))) AS duty_s
         FROM duty_sessions ds
        WHERE ds.venue_id = ANY($1::uuid[]) AND ds.started_at < $3 AND coalesce(ds.ended_at, $4::timestamptz) > $2
        GROUP BY ds.user_id, ds.venue_id
     ), done AS (
       SELECT k.assignee_id AS user_id, k.venue_id,
              count(*) FILTER (WHERE k.type IN ('park','repark'))::int AS parked,
              count(*) FILTER (WHERE k.type = 'retrieve')::int AS retrieved
         FROM tasks k
        WHERE k.venue_id = ANY($1::uuid[]) AND k.status = 'completed' AND k.assignee_id IS NOT NULL
          AND k.completed_at >= $2 AND k.completed_at < $3
        GROUP BY k.assignee_id, k.venue_id
     ), deliv AS (
       SELECT rc.delivered_by AS user_id, rc.venue_id, count(*)::int AS delivered
         FROM retrieval_cycles rc
        WHERE rc.venue_id = ANY($1::uuid[]) AND rc.outcome = 'delivered' AND rc.delivered_by IS NOT NULL
          AND rc.delivered_at >= $2 AND rc.delivered_at < $3
        GROUP BY rc.delivered_by, rc.venue_id
     ), offers AS (
       SELECT r.user_id, k.venue_id, count(*)::int AS received,
              count(*) FILTER (WHERE o.mode = 'single' AND o.status = 'expired')::int AS expired
         FROM offer_recipients r JOIN task_offers o ON o.id = r.offer_id JOIN tasks k ON k.id = o.task_id
        WHERE k.venue_id = ANY($1::uuid[]) AND o.created_at >= $2 AND o.created_at < $3
        GROUP BY r.user_id, k.venue_id
     ), acc AS (
       SELECT k.assignee_id AS user_id, k.venue_id,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (k.claimed_at - k.queued_at))::float8) AS p50
         FROM tasks k
        WHERE k.venue_id = ANY($1::uuid[]) AND k.type = 'retrieve' AND k.assignee_id IS NOT NULL
          AND k.claimed_at IS NOT NULL AND k.queued_at IS NOT NULL AND k.claimed_at >= $2 AND k.claimed_at < $3
        GROUP BY k.assignee_id, k.venue_id
     ), fails AS (
       SELECT te.actor_id::uuid AS user_id, te.venue_id, count(*)::int AS failures
         FROM ticket_events te
        WHERE te.venue_id = ANY($1::uuid[]) AND te.type = 'handover.code_attempt_failed' AND te.actor_type = 'user'
          AND te.occurred_at >= $2 AND te.occurred_at < $3
        GROUP BY te.actor_id, te.venue_id
     ), keys AS (
       SELECT user_id, venue_id FROM duty UNION SELECT user_id, venue_id FROM done
       UNION SELECT user_id, venue_id FROM deliv UNION SELECT user_id, venue_id FROM offers
       UNION SELECT user_id, venue_id FROM acc UNION SELECT user_id, venue_id FROM fails
     )
     SELECT u.id AS user_id, u.full_name, u.employee_code, keys.venue_id,
            coalesce(duty.duty_s, 0) AS duty_s, coalesce(done.parked, 0) AS parked,
            coalesce(done.retrieved, 0) AS retrieved, coalesce(deliv.delivered, 0) AS delivered,
            coalesce(offers.received, 0) AS offers_received, coalesce(offers.expired, 0) AS offers_expired,
            acc.p50 AS accept_p50_s, coalesce(fails.failures, 0) AS handover_code_failures
       FROM keys JOIN users u ON u.id = keys.user_id
       LEFT JOIN duty ON duty.user_id = keys.user_id AND duty.venue_id = keys.venue_id
       LEFT JOIN done ON done.user_id = keys.user_id AND done.venue_id = keys.venue_id
       LEFT JOIN deliv ON deliv.user_id = keys.user_id AND deliv.venue_id = keys.venue_id
       LEFT JOIN offers ON offers.user_id = keys.user_id AND offers.venue_id = keys.venue_id
       LEFT JOIN acc ON acc.user_id = keys.user_id AND acc.venue_id = keys.venue_id
       LEFT JOIN fails ON fails.user_id = keys.user_id AND fails.venue_id = keys.venue_id
      WHERE ($5::text IS NULL OR (u.employee_code, u.id, keys.venue_id) > ($5::text, $6::uuid, $7::uuid))
      ORDER BY u.employee_code, u.id, keys.venue_id
      LIMIT $8`,
    [
      f.venueIds,
      f.from,
      f.to,
      f.now,
      f.after?.employee_code ?? null,
      f.after?.user_id ?? null,
      f.after?.venue_id ?? null,
      f.limit,
    ],
  );
  return r.rows;
}

export function driverReportRow(r: DriverReportRawRow) {
  return {
    driver: { id: r.user_id, full_name: r.full_name, employee_code: r.employee_code },
    venue_id: r.venue_id,
    duty_hours: Math.round((num(r.duty_s) / 3600) * 100) / 100,
    parked: num(r.parked),
    retrieved: num(r.retrieved),
    delivered: num(r.delivered),
    offers_received: num(r.offers_received),
    offers_expired: num(r.offers_expired),
    accept_p50_s: numOrNull(r.accept_p50_s),
    handover_code_failures: num(r.handover_code_failures),
  };
}

// ------------------------------------------------------------------------------------------------
// payments (KPI-11 per event; the events held in the period, i.e. their local date)
// ------------------------------------------------------------------------------------------------

/**
 * «Held in the period» for an event of a Riyadh calendar day (DEC-288, DEC-331): the day
 * `[event_date 00:00, event_date + 1 00:00)` Asia/Riyadh overlaps the half-open period `[from, to)` — the same
 * convention as the drivers and messages reports, so S-11's Riyadh days sent as `[from, to + 1 day)` never pull
 * in the events of the day after. `e` is the events alias; the argument is the SQL parameter of the bound.
 */
export const EVENT_DAY_STARTS_BEFORE = (to: string) =>
  `(e.event_date::timestamp AT TIME ZONE 'Asia/Riyadh') < ${to}::timestamptz`;
export const EVENT_DAY_ENDS_AFTER = (from: string) =>
  `((e.event_date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh') > ${from}::timestamptz`;

export interface PaymentsReportFilters {
  venueIds: string[];
  from: string;
  to: string;
  eventId?: string;
}

export async function paymentsReportRows(q: TicketQueryable, f: PaymentsReportFilters) {
  const r = await q.query<{
    event_id: string;
    event_name_ar: string;
    venue_id: string;
    cash_halalas: number;
    pos_halalas: number;
    waived: number;
    reversed: number;
    outstanding: number;
  }>(
    `SELECT e.id AS event_id, e.name_ar AS event_name_ar, e.venue_id,
            coalesce((SELECT sum(p.amount_halalas) FROM payments p
                       WHERE p.event_id = e.id AND p.status = 'recorded' AND p.method = 'cash'), 0) AS cash_halalas,
            coalesce((SELECT sum(p.amount_halalas) FROM payments p
                       WHERE p.event_id = e.id AND p.status = 'recorded' AND p.method = 'pos'), 0) AS pos_halalas,
            (SELECT count(*)::int FROM tickets t
              WHERE t.event_id = e.id AND t.status <> 'voided' AND t.payment_status = 'waived') AS waived,
            (SELECT count(*)::int FROM payments p WHERE p.event_id = e.id AND p.status = 'reversed') AS reversed,
            (SELECT count(*)::int FROM tickets t
              WHERE t.event_id = e.id AND t.status <> 'voided' AND t.payment_status = 'due') AS outstanding
       FROM events e
      WHERE e.venue_id = ANY($1::uuid[])
        AND ${EVENT_DAY_STARTS_BEFORE('$3')} AND ${EVENT_DAY_ENDS_AFTER('$2')}
        AND ($4::uuid IS NULL OR e.id = $4::uuid)
      ORDER BY e.event_date, e.id`,
    [f.venueIds, f.from, f.to, f.eventId ?? null],
  );
  const rows = r.rows.map((x) => ({
    event_id: x.event_id,
    event_name_ar: x.event_name_ar,
    venue_id: x.venue_id,
    cash_halalas: num(x.cash_halalas),
    pos_halalas: num(x.pos_halalas),
    waived: num(x.waived),
    reversed: num(x.reversed),
    outstanding: num(x.outstanding),
  }));
  const totals = rows.reduce(
    (t, x) => ({
      cash_halalas: t.cash_halalas + x.cash_halalas,
      pos_halalas: t.pos_halalas + x.pos_halalas,
      waived: t.waived + x.waived,
      reversed: t.reversed + x.reversed,
      outstanding: t.outstanding + x.outstanding,
    }),
    { cash_halalas: 0, pos_halalas: 0, waived: 0, reversed: 0, outstanding: 0 },
  );
  return { totals, rows };
}

// ------------------------------------------------------------------------------------------------
// messages (KPI-08; 15 §11.4)
// ------------------------------------------------------------------------------------------------

export interface MessagesReportFilters {
  venueIds: string[];
  /** messages without a venue (an inbound text not tied to a ticket) belong to the organization scope only */
  includeUnplaced: boolean;
  from: string;
  to: string;
  status?: string;
}

const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'received'] as const;

export async function messagesReport(q: TicketQueryable, f: MessagesReportFilters, limit = 200) {
  const where = `(m.venue_id = ANY($1::uuid[]) OR ($2::boolean AND m.venue_id IS NULL))
                 AND m.created_at >= $3 AND m.created_at < $4`;
  const params = [f.venueIds, f.includeUnplaced, f.from, f.to];
  const counts = (
    await q.query<{ status: string; n: number }>(
      `SELECT m.status, count(*)::int AS n FROM whatsapp_messages m
        WHERE ${where} AND ($5::text IS NULL OR m.status = $5::text) GROUP BY m.status`,
      [...params, f.status ?? null],
    )
  ).rows;
  const totals = Object.fromEntries(
    MESSAGE_STATUSES.map((s) => [s, num(counts.find((c) => c.status === s)?.n)]),
  ) as Record<(typeof MESSAGE_STATUSES)[number], number>;
  const failures = (
    await q.query<WaMessageRow>(
      `SELECT ${WA_MESSAGE_COLUMNS} FROM whatsapp_messages m
        WHERE ${where} AND m.status = $5::text ORDER BY m.created_at DESC, m.id DESC LIMIT $6`,
      [...params, f.status ?? 'failed', limit],
    )
  ).rows;
  return { from: f.from, to: f.to, totals, failures: failures.map(waMessageView) };
}

// ------------------------------------------------------------------------------------------------
// the routes
// ------------------------------------------------------------------------------------------------

export interface DriversQuery {
  venue_id?: string;
  from: string;
  to: string;
  limit: number;
  cursor?: string;
}

@Injectable()
export class ReportsService {
  private readonly cursors: ReportCursorCodec;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) env: Env,
  ) {
    this.cursors = new ReportCursorCodec(env.SESSION_SECRET);
  }

  /** `GET /v1/reports/events/{eventId}/summary` (FR-RPT-01). */
  async eventSummary(actor: ActorContext, eventId: string) {
    const ev = await findEventInScope(this.db, actor, eventId);
    return eventSummaryReport(this.db, ev.id);
  }

  /** `GET /v1/reports/drivers` (FR-RPT-02): one row per driver and venue, ordered by employee code. */
  async drivers(actor: ActorContext, q: DriversQuery) {
    const venueIds = reportVenues(actor, q.venue_id);
    assertRange(q.from, q.to);
    const scope = `drivers|${q.venue_id ?? ''}|${q.from}|${q.to}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 3) : null;
    const rows = await driverReportRows(this.db, {
      venueIds,
      from: q.from,
      to: q.to,
      now: this.clock.now(),
      limit: q.limit + 1,
      after: after
        ? { employee_code: String(after[0]), user_id: String(after[1]), venue_id: String(after[2]) }
        : null,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map(driverReportRow),
      next_cursor:
        rows.length > q.limit && last
          ? this.cursors.encode(scope, [last.employee_code, last.user_id, last.venue_id])
          : null,
    };
  }

  /** `GET /v1/reports/payments` (FR-RPT-03): per event held in the period, reversals and waivers apart. */
  async payments(actor: ActorContext, q: { venue_id?: string; from: string; to: string; event_id?: string }) {
    const venueIds = reportVenues(actor, q.venue_id);
    assertRange(q.from, q.to);
    if (q.event_id) await findEventInScope(this.db, actor, q.event_id);
    const r = await paymentsReportRows(this.db, { venueIds, from: q.from, to: q.to, eventId: q.event_id });
    return { from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString(), ...r };
  }

  /** `GET /v1/reports/messages` (FR-RPT-04): totals by status and the failed (or filtered) messages, redacted. */
  async messages(actor: ActorContext, q: { venue_id?: string; from: string; to: string; status?: string }) {
    const venueIds = reportVenues(actor, q.venue_id);
    assertRange(q.from, q.to);
    const r = await messagesReport(this.db, {
      venueIds,
      includeUnplaced: actor.orgScope && !q.venue_id,
      from: q.from,
      to: q.to,
      status: q.status,
    });
    return { ...r, from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() };
  }
}
