import {
  SUMMARY_SELECT,
  ticketSummary,
  type TicketQueryable,
  type TicketSummaryRow,
} from '../../tickets-custody/index.js';
import type { EventRow } from './scope.js';
import { cashHandoverView, loadUserRefs, refOf, type CashHandoverRow, type UserRefDto } from './views.js';

/**
 * The settlement of one event (13 §11, `Settlement` in 07; PNT-082). Read-only: the reference queries of 13 §11.4
 * (tickets and amounts by money state, collections by method, per driver), the adjusted expectation of §10.4, the
 * integrity checks of §11.3 and the financial close blockers of §12. Used by `GET /v1/events/{eventId}/settlement`,
 * by the reconciliation (S-10) and, frozen, by the close (`close_summary.finance`).
 */

export type IntegrityCheck =
  'collected_without_payment' | 'payment_without_collected' | 'amount_mismatch' | 'snapshot_inconsistent';

export interface IntegrityViolation {
  check: IntegrityCheck;
  entity_id: string;
}

export interface DriverSettlement {
  driver: UserRefDto;
  cash: {
    count: number;
    collected_halalas: number;
    handed_over_halalas: number;
    outstanding_halalas: number;
    difference_adjusted_halalas: number;
  };
  pos: { count: number; halalas: number };
}

export interface Discrepancy {
  type: 'cash_difference' | 'delivered_due' | 'reversed_without_replacement';
  driver_id: string | null;
  ticket_id: string | null;
  cash_handover_id: string | null;
  difference_halalas: number | null;
  incident_id: string | null;
}

export interface Settlement {
  event: {
    id: string;
    name_ar: string;
    status: EventRow['status'];
    pricing_mode: EventRow['pricing_mode'];
    fee_halalas: number;
    allowed_payment_methods: string[];
  };
  currency: 'SAR';
  tickets: {
    total: number;
    delivered: number;
    open: number;
    voided: number;
    by_payment_status: { not_required: number; due: number; collected: number; waived: number };
  };
  amounts: {
    billable_halalas: number;
    collected_halalas: number;
    waived_halalas: number;
    due_halalas: number;
    by_method: { cash: { count: number; halalas: number }; pos: { count: number; halalas: number } };
    reversed: { count: number; halalas: number };
  };
  drivers: DriverSettlement[];
  cash_handovers: ReturnType<typeof cashHandoverView>[];
  discrepancies: Discrepancy[];
  close_blockers: {
    unsettled_payments: ReturnType<typeof ticketSummary>[];
    cash_outstanding: { driver: UserRefDto; amount_halalas: number }[];
    payment_integrity: IntegrityViolation[];
  };
  integrity: { ok: boolean; violations: IntegrityViolation[] };
}

const n = (v: unknown): number => Number(v ?? 0);

/** 13 §11.3: each query must return no row; a row is a violation and a close blocker (`payment_integrity`). */
export async function integrityViolations(
  q: TicketQueryable,
  eventId: string,
): Promise<IntegrityViolation[]> {
  const r = await q.query<{ check_id: IntegrityCheck; entity_id: string }>(
    `SELECT 'collected_without_payment' AS check_id, t.id AS entity_id FROM tickets t
      WHERE t.event_id = $1 AND t.payment_status = 'collected'
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.ticket_id = t.id AND p.status = 'recorded')
        AND NOT (t.entitlement = 'app_paid' AND EXISTS (
              SELECT 1 FROM online_payments op WHERE op.ticket_id = t.id AND op.purpose = 'visit'
                 AND op.status IN ('paid','partially_refunded','refunded') AND op.paid_at IS NOT NULL))
     UNION ALL
     SELECT 'payment_without_collected', p.id FROM payments p JOIN tickets t ON t.id = p.ticket_id
      WHERE p.event_id = $1 AND p.status = 'recorded' AND t.payment_status <> 'collected'
     UNION ALL
     SELECT 'amount_mismatch', p.id FROM payments p JOIN tickets t ON t.id = p.ticket_id
      WHERE p.event_id = $1 AND p.status = 'recorded' AND p.amount_halalas <> t.fee_halalas
     UNION ALL
     SELECT 'snapshot_inconsistent', t.id FROM tickets t
      WHERE t.event_id = $1 AND t.status <> 'voided'
        AND ((t.payment_status = 'not_required' AND t.fee_halalas <> 0)
          OR (t.payment_status IN ('due','collected','waived') AND t.fee_halalas = 0))`,
    [eventId],
  );
  return r.rows.map((x) => ({ check: x.check_id, entity_id: x.entity_id }));
}

/** Delivered tickets that are `due` (after a reversal without replacement): 13 §12 `unsettled_payments`. */
export async function unsettledTickets(q: TicketQueryable, eventId: string) {
  const r = await q.query<TicketSummaryRow>(
    `${SUMMARY_SELECT} WHERE t.event_id = $1 AND t.status = 'delivered' AND t.payment_status = 'due'
      ORDER BY t.display_number`,
    [eventId],
  );
  return r.rows.map(ticketSummary);
}

export async function computeSettlement(q: TicketQueryable, ev: EventRow): Promise<Settlement> {
  const tk = (
    await q.query(
      `SELECT count(*) FILTER (WHERE status <> 'voided')::int                                   AS total,
              count(*) FILTER (WHERE status = 'delivered')::int                                 AS delivered,
              count(*) FILTER (WHERE status NOT IN ('delivered','voided'))::int                 AS open,
              count(*) FILTER (WHERE status = 'voided')::int                                    AS voided,
              count(*) FILTER (WHERE status <> 'voided' AND payment_status = 'not_required')::int AS not_required,
              count(*) FILTER (WHERE status <> 'voided' AND payment_status = 'due')::int         AS due,
              count(*) FILTER (WHERE status <> 'voided' AND payment_status = 'collected')::int   AS collected,
              count(*) FILTER (WHERE status <> 'voided' AND payment_status = 'waived')::int      AS waived,
              coalesce(sum(fee_halalas) FILTER (WHERE status <> 'voided' AND payment_status = 'due'), 0)    AS due_halalas,
              coalesce(sum(fee_halalas) FILTER (WHERE status <> 'voided' AND payment_status = 'waived'), 0) AS waived_halalas,
              coalesce(sum(fee_halalas) FILTER (WHERE status <> 'voided'
                                                 AND payment_status IN ('due','collected','waived')), 0)    AS billable_halalas
         FROM tickets WHERE event_id = $1`,
      [ev.id],
    )
  ).rows[0]!;

  const pay = (
    await q.query<{ method: 'cash' | 'pos'; status: string; count: number; halalas: number }>(
      `SELECT method, status, count(*)::int AS count, coalesce(sum(amount_halalas), 0) AS halalas
         FROM payments WHERE event_id = $1 GROUP BY method, status`,
      [ev.id],
    )
  ).rows;
  const sumOf = (status: string, method?: string) =>
    pay
      .filter((p) => p.status === status && (!method || p.method === method))
      .reduce((s, p) => ({ count: s.count + n(p.count), halalas: s.halalas + n(p.halalas) }), {
        count: 0,
        halalas: 0,
      });
  const cash = sumOf('recorded', 'cash');
  const pos = sumOf('recorded', 'pos');
  const reversed = sumOf('reversed');

  const perDriver = (
    await q.query<{
      driver_id: string;
      cash_count: number;
      cash_collected: number;
      cash_outstanding: number;
      pos_count: number;
      pos_collected: number;
      reversed_after_handover: number;
      handed: number;
      expected: number;
      handovers: number;
    }>(
      `WITH p AS (
         SELECT collected_by AS driver_id,
                count(*) FILTER (WHERE method = 'cash' AND status = 'recorded')::int                       AS cash_count,
                coalesce(sum(amount_halalas) FILTER (WHERE method = 'cash' AND status = 'recorded'), 0)    AS cash_collected,
                coalesce(sum(amount_halalas) FILTER (WHERE method = 'cash' AND status = 'recorded'
                                                       AND cash_handover_id IS NULL), 0)                  AS cash_outstanding,
                count(*) FILTER (WHERE method = 'pos' AND status = 'recorded')::int                        AS pos_count,
                coalesce(sum(amount_halalas) FILTER (WHERE method = 'pos' AND status = 'recorded'), 0)     AS pos_collected,
                coalesce(sum(amount_halalas) FILTER (WHERE method = 'cash' AND status = 'reversed'
                                                       AND cash_handover_id IS NOT NULL), 0)              AS reversed_after_handover
           FROM payments WHERE event_id = $1 GROUP BY collected_by
       ), h AS (
         SELECT driver_id, sum(amount_halalas) AS handed, sum(expected_halalas) AS expected, count(*)::int AS handovers
           FROM cash_handovers WHERE event_id = $1 GROUP BY driver_id
       )
       SELECT coalesce(p.driver_id, h.driver_id) AS driver_id,
              coalesce(p.cash_count, 0) AS cash_count, coalesce(p.cash_collected, 0) AS cash_collected,
              coalesce(p.cash_outstanding, 0) AS cash_outstanding, coalesce(p.pos_count, 0) AS pos_count,
              coalesce(p.pos_collected, 0) AS pos_collected,
              coalesce(p.reversed_after_handover, 0) AS reversed_after_handover,
              coalesce(h.handed, 0) AS handed, coalesce(h.expected, 0) AS expected, coalesce(h.handovers, 0) AS handovers
         FROM p FULL OUTER JOIN h ON h.driver_id = p.driver_id`,
      [ev.id],
    )
  ).rows;

  const handovers = (
    await q.query<CashHandoverRow>(
      `SELECT * FROM cash_handovers WHERE event_id = $1 ORDER BY handed_at, id`,
      [ev.id],
    )
  ).rows;
  const handoverIds = handovers.map((h) => h.id);
  const linked = handoverIds.length
    ? (
        await q.query<{ id: string; cash_handover_id: string }>(
          `SELECT id, cash_handover_id FROM payments WHERE cash_handover_id = ANY($1::uuid[]) ORDER BY id`,
          [handoverIds],
        )
      ).rows
    : [];
  // the incident a handover opened is recorded with its audit row (cash.handover_confirm, same transaction)
  const handoverIncidents = handoverIds.length
    ? new Map(
        (
          await q.query<{ entity_id: string; incident_id: string | null }>(
            `SELECT entity_id, metadata->>'incident_id' AS incident_id FROM audit_log
              WHERE entity_type = 'cash_handover' AND entity_id = ANY($1::uuid[]) AND action = 'cash.handover_confirm'`,
            [handoverIds],
          )
        ).rows.map((r) => [r.entity_id, r.incident_id]),
      )
    : new Map<string, string | null>();

  const deliveredDue = (
    await q.query<{ ticket_id: string; incident_id: string | null }>(
      `SELECT t.id AS ticket_id,
              (SELECT i.id FROM incidents i WHERE i.ticket_id = t.id AND i.type = 'payment_discrepancy'
                ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS incident_id
         FROM tickets t WHERE t.event_id = $1 AND t.status = 'delivered' AND t.payment_status = 'due'
        ORDER BY t.display_number`,
      [ev.id],
    )
  ).rows;
  const reversedNoReplacement = (
    await q.query<{ ticket_id: string; driver_id: string; incident_id: string | null }>(
      `SELECT p.ticket_id, p.collected_by AS driver_id,
              (SELECT i.id FROM incidents i WHERE i.ticket_id = p.ticket_id AND i.type = 'payment_discrepancy'
                ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS incident_id
         FROM payments p JOIN tickets t ON t.id = p.ticket_id
        WHERE p.event_id = $1 AND p.status = 'reversed' AND t.status = 'delivered'
          AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.ticket_id = p.ticket_id AND x.status = 'recorded')
        ORDER BY t.display_number, p.id`,
      [ev.id],
    )
  ).rows;

  const users = await loadUserRefs(q, [
    ...perDriver.map((d) => d.driver_id),
    ...handovers.flatMap((h) => [h.driver_id, h.received_by]),
  ]);
  const drivers: DriverSettlement[] = perDriver
    .map((d) => ({
      driver: refOf(users, d.driver_id)!,
      cash: {
        count: n(d.cash_count),
        collected_halalas: n(d.cash_collected),
        handed_over_halalas: n(d.handed),
        outstanding_halalas: n(d.cash_outstanding),
        // 13 §10.4: handed − (expected − cash reversed after it was handed over); no handover → 0
        difference_adjusted_halalas:
          n(d.handovers) > 0 ? n(d.handed) - (n(d.expected) - n(d.reversed_after_handover)) : 0,
      },
      pos: { count: n(d.pos_count), halalas: n(d.pos_collected) },
    }))
    .sort(byDriver);

  const discrepancies: Discrepancy[] = [
    ...handovers
      .filter((h) => n(h.difference_halalas) !== 0)
      .map((h) => ({
        type: 'cash_difference' as const,
        driver_id: h.driver_id,
        ticket_id: null,
        cash_handover_id: h.id,
        difference_halalas: n(h.difference_halalas),
        incident_id: handoverIncidents.get(h.id) ?? null,
      })),
    ...deliveredDue.map((d) => ({
      type: 'delivered_due' as const,
      driver_id: null,
      ticket_id: d.ticket_id,
      cash_handover_id: null,
      difference_halalas: null,
      incident_id: d.incident_id,
    })),
    ...reversedNoReplacement.map((d) => ({
      type: 'reversed_without_replacement' as const,
      driver_id: d.driver_id,
      ticket_id: d.ticket_id,
      cash_handover_id: null,
      difference_halalas: null,
      incident_id: d.incident_id,
    })),
  ];

  const violations = await integrityViolations(q, ev.id);
  return {
    event: {
      id: ev.id,
      name_ar: ev.name_ar,
      status: ev.status,
      pricing_mode: ev.pricing_mode,
      fee_halalas: n(ev.fee_halalas),
      allowed_payment_methods: [...ev.allowed_payment_methods],
    },
    currency: 'SAR',
    tickets: {
      total: n(tk.total),
      delivered: n(tk.delivered),
      open: n(tk.open),
      voided: n(tk.voided),
      by_payment_status: {
        not_required: n(tk.not_required),
        due: n(tk.due),
        collected: n(tk.collected),
        waived: n(tk.waived),
      },
    },
    amounts: {
      billable_halalas: n(tk.billable_halalas),
      collected_halalas: cash.halalas + pos.halalas,
      waived_halalas: n(tk.waived_halalas),
      due_halalas: n(tk.due_halalas),
      by_method: { cash, pos },
      reversed,
    },
    drivers,
    cash_handovers: handovers.map((h) =>
      cashHandoverView(h, users, {
        payment_ids: linked.filter((p) => p.cash_handover_id === h.id).map((p) => p.id),
        incident_id: handoverIncidents.get(h.id) ?? null,
      }),
    ),
    discrepancies,
    close_blockers: {
      unsettled_payments: await unsettledTickets(q, ev.id),
      cash_outstanding: drivers
        .filter((d) => d.cash.outstanding_halalas > 0)
        .map((d) => ({ driver: d.driver, amount_halalas: d.cash.outstanding_halalas })),
      payment_integrity: violations,
    },
    integrity: { ok: violations.length === 0, violations },
  };
}

function byDriver(a: { driver: UserRefDto }, b: { driver: UserRefDto }): number {
  const ka = a.driver.employee_code ?? a.driver.id;
  const kb = b.driver.employee_code ?? b.driver.id;
  return ka < kb ? -1 : ka > kb ? 1 : a.driver.id < b.driver.id ? -1 : a.driver.id > b.driver.id ? 1 : 0;
}

/** The frozen financial part of `events.close_summary` (13 §12: the fields of `amounts`, `drivers`, `discrepancies`). */
export function financeSummary(s: Settlement) {
  return { currency: s.currency, amounts: s.amounts, drivers: s.drivers, discrepancies: s.discrepancies };
}
