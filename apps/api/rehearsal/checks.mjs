// SQL of the automated rehearsal (PNT-102): the consistency queries of 10 §14.1 / 11 §1.7 (the same text as
// INVARIANTS in apps/api/test/dispatch-fixtures.ts — a unit test keeps them equal), the KPI queries of 15 §10
// used by the report, and small pure helpers (percentiles, formatting) shared with the report writer.

/** 10 §14.1 (I-A … I-F) and 11 §1.7: each query must return no row. */
export const INVARIANT_QUERIES = {
  'I-A available ⟺ available_since': `SELECT s.user_id FROM v_driver_state s
     WHERE s.duty_status = 'on_duty' AND ((s.driver_state = 'available') <> (s.available_since IS NOT NULL))`,
  'I-B task status ⟺ live round': `SELECT t.id FROM tasks t LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
     WHERE t.type = 'retrieve' AND ((t.status = 'offered' AND (o.id IS NULL OR o.mode <> 'single'))
        OR (t.status = 'broadcast' AND (o.id IS NULL OR o.mode <> 'broadcast'))
        OR (t.status NOT IN ('offered','broadcast') AND o.id IS NOT NULL))`,
  'I-C ticket mirrors its retrieve task': `SELECT k.id FROM tickets k JOIN tasks t ON t.ticket_id = k.id AND t.type = 'retrieve' AND t.status NOT IN ('completed','canceled')
     WHERE NOT ((k.status = 'requested' AND t.status IN ('queued','offered','broadcast'))
             OR (k.status = 'assigned' AND t.status = 'accepted')
             OR (k.status = 'assigned_waiting' AND t.status = 'assigned_waiting')
             OR (k.status IN ('retrieving','ready') AND t.status = 'in_progress'))`,
  'I-D live single offers only for available drivers': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     JOIN v_driver_state s ON s.user_id = r.user_id
     WHERE o.status = 'active' AND o.mode = 'single' AND s.driver_state <> 'available'`,
  'I-E one live single offer per driver': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     WHERE o.status = 'active' AND o.mode = 'single' GROUP BY r.user_id HAVING count(*) > 1`,
  'I-F rounds never cross pools': `SELECT o.id FROM task_offers o JOIN tasks t ON t.id = o.task_id JOIN offer_recipients r ON r.offer_id = o.id
     LEFT JOIN duty_sessions ds ON ds.id = r.duty_session_id
     WHERE o.status = 'active' AND (o.dispatch_pool_id <> t.dispatch_pool_id OR ds.dispatch_pool_id <> o.dispatch_pool_id)`,
  '11 §1.7 ticket ↔ open task': `SELECT t.id, t.status, k.type AS open_task_type, k.status AS open_task_status
     FROM tickets t LEFT JOIN tasks k ON k.ticket_id = t.id AND k.status NOT IN ('completed','canceled')
     WHERE NOT (
          (t.status IN ('received','parking') AND k.type = 'park' AND k.status = 'in_progress')
       OR (t.status = 'requested' AND k.type = 'retrieve' AND k.status IN ('queued','offered','broadcast'))
       OR (t.status = 'assigned' AND k.type = 'retrieve' AND k.status = 'accepted')
       OR (t.status = 'assigned_waiting' AND k.type = 'retrieve' AND k.status = 'assigned_waiting')
       OR (t.status IN ('retrieving','ready') AND k.type = 'retrieve' AND k.status = 'in_progress')
       OR (t.status = 'reparking' AND k.type = 'repark' AND k.status = 'in_progress')
       OR (t.status IN ('parked','delivered','voided') AND k.id IS NULL))`,
};

/** What a closed event must not keep (PNT-093 / 13 §12): open custody, open work, live codes. */
export const CLOSED_EVENT_CHECKS = {
  'tickets not delivered or voided': `SELECT id FROM tickets WHERE event_id = $1 AND status NOT IN ('delivered','voided')`,
  'vehicle or key not with the customer': `SELECT id FROM tickets WHERE event_id = $1
      AND (vehicle_holder_type <> 'customer' OR key_holder_type <> 'customer')`,
  'spot still allocated': `SELECT a.id FROM spot_allocations a JOIN tickets t ON t.id = a.ticket_id
      WHERE t.event_id = $1 AND a.released_at IS NULL`,
  'key slot still allocated': `SELECT a.id FROM key_slot_allocations a JOIN tickets t ON t.id = a.ticket_id
      WHERE t.event_id = $1 AND a.released_at IS NULL`,
  'open task': `SELECT id FROM tasks WHERE event_id = $1 AND status NOT IN ('completed','canceled')`,
  'open retrieval cycle': `SELECT rc.id FROM retrieval_cycles rc JOIN tickets t ON t.id = rc.ticket_id
      WHERE t.event_id = $1 AND rc.closed_at IS NULL`,
  'live handover code': `SELECT c.id FROM claim_codes c JOIN tickets t ON t.id = c.ticket_id
      WHERE t.event_id = $1 AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > now()`,
  'handover code copy kept (DEC-38)': `SELECT c.id FROM claim_codes c JOIN tickets t ON t.id = c.ticket_id
      WHERE t.event_id = $1 AND c.code_ciphertext IS NOT NULL`,
  'cash not handed over': `SELECT id FROM payments WHERE event_id = $1 AND method = 'cash' AND status = 'recorded'
      AND cash_handover_id IS NULL`,
  'ticket still due': `SELECT id FROM tickets WHERE event_id = $1 AND payment_status = 'due'`,
};

/**
 * Durations of 15 §10 per event, in seconds, with the filters of its SQL (KPI-01 queue → claim, KPI-02 accepted →
 * start, KPI-03 request → ready, KPI-04 ready → delivered, KPI-05 request → delivered; KPI-16 intake and first
 * parking). One row per measure and value.
 */
export const DURATION_QUERIES = {
  'request → accepted (KPI-01)': `SELECT extract(epoch FROM k.claimed_at - k.queued_at) AS s
      FROM tasks k WHERE k.event_id = $1 AND k.type = 'retrieve' AND k.claimed_at IS NOT NULL AND k.queued_at IS NOT NULL`,
  'accepted → start (KPI-02)': `SELECT extract(epoch FROM k.started_at - k.accepted_at) AS s
      FROM tasks k WHERE k.event_id = $1 AND k.type = 'retrieve' AND k.started_at IS NOT NULL AND k.accepted_at IS NOT NULL`,
  'request → ready (KPI-03)': `SELECT extract(epoch FROM rc.ready_at - rc.requested_at) AS s
      FROM retrieval_cycles rc JOIN tickets t ON t.id = rc.ticket_id
     WHERE t.event_id = $1 AND rc.ready_at IS NOT NULL AND rc.outcome IN ('delivered','reparked')`,
  'ready → delivered (KPI-04)': `SELECT extract(epoch FROM rc.delivered_at - rc.ready_at) AS s
      FROM retrieval_cycles rc JOIN tickets t ON t.id = rc.ticket_id
     WHERE t.event_id = $1 AND rc.outcome = 'delivered' AND rc.ready_at IS NOT NULL`,
  'request → delivered (KPI-05)': `SELECT extract(epoch FROM rc.delivered_at - rc.requested_at) AS s
      FROM retrieval_cycles rc JOIN tickets t ON t.id = rc.ticket_id
     WHERE t.event_id = $1 AND rc.outcome = 'delivered'`,
  'intake: created → submitted (KPI-16)': `SELECT extract(epoch FROM submitted_at - created_at) AS s
      FROM tickets WHERE event_id = $1 AND status <> 'voided' AND submitted_at IS NOT NULL`,
  'parking: submitted → first parked (KPI-16)': `SELECT extract(epoch FROM f.first_parked_at - f.submitted_at) AS s
      FROM (SELECT tk.submitted_at, (SELECT min(te.occurred_at) FROM ticket_events te
                                      WHERE te.ticket_id = tk.id AND te.type = 'ticket.parked') AS first_parked_at
              FROM tickets tk WHERE tk.event_id = $1 AND tk.status <> 'voided') f
     WHERE f.submitted_at IS NOT NULL AND f.first_parked_at IS NOT NULL`,
};

/** Nearest-rank percentile of a list of numbers (null for an empty list). */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.min(xs.length, Math.max(1, Math.ceil((p / 100) * xs.length)));
  return xs[rank - 1];
}

/** `12.3 s` / `—` */
export const secs = (v) =>
  v === null || v === undefined ? '—' : `${(Math.round(v * 10) / 10).toFixed(1)} s`;

/** halalas → `1,234.00 SAR` */
export const sar = (h) =>
  `${(Number(h) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SAR`;

/** A markdown table from a header row and rows (every cell turned to text; `|` escaped). */
export function table(header, rows) {
  const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|');
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

/** `/v1/tickets/<uuid>/handover` → `/v1/tickets/{id}/handover` (HTTP statistics by route). */
export const routeOf = (path) =>
  path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}');
