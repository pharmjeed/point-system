import { rooms, type AlertType } from '@point/shared';
import type { Tx } from '../db/tx.js';
import { newId } from '../crypto/ids.js';
import { emitEvent } from '../outbox/outbox-writer.js';
import { publishRealtime } from '../realtime/realtime-publisher.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Severity per type — 14 §8 (binding catalog). */
export const ALERT_SEVERITY: Record<AlertType, AlertSeverity> = {
  no_drivers_on_duty: 'critical',
  request_unaccepted: 'critical',
  next_task_waiting_long: 'warning',
  idle_driver_while_next_waiting: 'warning',
  ready_not_collected: 'warning',
  wa_send_failed: 'warning',
  wa_channel_down: 'critical',
  driver_connection_lost_with_custody: 'warning',
  handover_code_locked: 'critical',
  inspection_incomplete: 'warning',
  draft_abandoned: 'warning',
  transfer_blocked: 'info',
  outbox_lag: 'critical',
  push_failed_repeatedly: 'info',
  task_stuck: 'warning',
  wa_webhook_silent: 'critical',
};

/** Types that touch several venues: one row per affected venue + the org admins room (DEC-46). */
export const MULTI_VENUE_ALERTS: ReadonlySet<AlertType> = new Set([
  'wa_channel_down',
  'outbox_lag',
  'wa_webhook_silent',
  'transfer_blocked',
]);

export interface AlertRow {
  id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string | null;
  event_id: string | null;
  ticket_id: string | null;
  task_id: string | null;
  user_id: string | null;
  type: AlertType;
  severity: AlertSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  dedupe_key: string | null;
  details: Record<string, unknown>;
  raised_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** Alert schema of 07. */
export function alertView(a: AlertRow) {
  return {
    id: a.id,
    venue_id: a.venue_id,
    dispatch_pool_id: a.dispatch_pool_id,
    event_id: a.event_id,
    ticket_id: a.ticket_id,
    task_id: a.task_id,
    user_id: a.user_id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    details: a.details,
    raised_at: iso(a.raised_at)!,
    acknowledged_at: iso(a.acknowledged_at),
    acknowledged_by: a.acknowledged_by,
    resolved_at: iso(a.resolved_at),
    resolved_by: a.resolved_by,
    resolution_note: a.resolution_note,
  };
}

export interface RaiseAlertInput {
  orgId: string;
  venueId: string;
  type: AlertType;
  /** 14 §8 dedupe key, e.g. `request_unaccepted:{task_id}` */
  dedupeKey: string;
  details?: Record<string, unknown>;
  poolId?: string | null;
  eventId?: string | null;
  ticketId?: string | null;
  taskId?: string | null;
  userId?: string | null;
  severity?: AlertSeverity;
}

function alertRooms(a: AlertRow): string[] {
  const r = [rooms.venueSupervisors(a.venue_id)];
  if (MULTI_VENUE_ALERTS.has(a.type)) r.push(rooms.orgAdmins(a.org_id));
  return r;
}

/**
 * Raises (or refreshes) the live alert for (venue, dedupe_key) — uq_alerts_live_dedupe never errors: a
 * repeated condition updates `details` (08 §5.1, 14 §8). Writes `alert.raised` + realtime only when created.
 * Payloads carry ids and numbers only (no phones, plates or codes).
 */
export async function raiseAlert(tx: Tx, a: RaiseAlertInput): Promise<{ alert: AlertRow; created: boolean }> {
  const severity = a.severity ?? ALERT_SEVERITY[a.type];
  const r = await tx.one<AlertRow & { inserted: boolean }>(
    `INSERT INTO alerts (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, task_id, user_id, type, severity, dedupe_key, details, raised_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (venue_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL
     DO UPDATE SET details = alerts.details || EXCLUDED.details
     RETURNING *, (xmax = 0) AS inserted`,
    [
      newId(),
      a.orgId,
      a.venueId,
      a.poolId ?? null,
      a.eventId ?? null,
      a.ticketId ?? null,
      a.taskId ?? null,
      a.userId ?? null,
      a.type,
      severity,
      a.dedupeKey,
      JSON.stringify(a.details ?? {}),
      tx.now,
    ],
  );
  const { inserted, ...alert } = r;
  if (inserted) {
    const ev = await emitEvent(tx, {
      type: 'alert.raised',
      orgId: a.orgId,
      venueId: a.venueId,
      dispatchPoolId: a.poolId ?? null,
      eventId: a.eventId ?? null,
      aggregate: { type: 'alert', id: alert.id, version: 1 },
      actor: { type: 'system', id: null },
      payload: {
        alert_id: alert.id,
        type: a.type,
        severity,
        dedupe_key: a.dedupeKey,
        ticket_id: a.ticketId ?? null,
        task_id: a.taskId ?? null,
        user_id: a.userId ?? null,
      },
    });
    await publishRealtime(tx, a.orgId, alertRooms(alert), {
      event: 'alert.raised',
      id: ev.id,
      venue_id: a.venueId,
      aggregate: { type: 'alert', id: alert.id, version: 1 },
      data: { cause: 'alert.raised', ...alertView(alert) },
    });
  }
  return { alert, created: inserted };
}

/** DEC-46: one row per venue that has an open or closing event (multi-venue alert types). */
export async function raiseAlertForAffectedVenues(
  tx: Tx,
  a: Omit<RaiseAlertInput, 'venueId'> & { venueIds?: string[] },
): Promise<AlertRow[]> {
  const venues = a.venueIds?.length
    ? a.venueIds
    : (
        await tx.rows<{ venue_id: string }>(
          `SELECT DISTINCT venue_id FROM events WHERE org_id = $1 AND status IN ('open','closing')`,
          [a.orgId],
        )
      ).map((r) => r.venue_id);
  const out: AlertRow[] = [];
  for (const venueId of [...new Set(venues)].sort())
    out.push((await raiseAlert(tx, { ...a, venueId })).alert);
  return out;
}

/** Automatic resolution (14 §8): resolved_at set, resolved_by left NULL; `alert.resolved` + `alert.updated`. */
export async function autoResolveAlerts(
  tx: Tx,
  f: { orgId: string; dedupeKeys: string[]; venueId?: string | null; note?: string },
): Promise<AlertRow[]> {
  if (!f.dedupeKeys.length) return [];
  const rows = await tx.rows<AlertRow>(
    `UPDATE alerts SET status = 'resolved', resolved_at = $3, resolved_by = NULL, resolution_note = COALESCE($5, resolution_note)
      WHERE org_id = $1 AND status <> 'resolved' AND dedupe_key = ANY($2::text[]) AND ($4::uuid IS NULL OR venue_id = $4)
      RETURNING *`,
    [f.orgId, f.dedupeKeys, tx.now, f.venueId ?? null, f.note ?? null],
  );
  for (const a of rows) await publishStatus(tx, a, null, true);
  return rows;
}

export async function publishStatus(tx: Tx, a: AlertRow, by: string | null, auto: boolean): Promise<void> {
  const ev = await emitEvent(tx, {
    type: a.status === 'resolved' ? 'alert.resolved' : 'alert.acknowledged',
    orgId: a.org_id,
    venueId: a.venue_id,
    aggregate: { type: 'alert', id: a.id, version: null },
    actor: by ? { type: 'user', id: by } : { type: 'system', id: null },
    payload: { alert_id: a.id, type: a.type, status: a.status, by, auto },
  });
  await publishRealtime(tx, a.org_id, alertRooms(a), {
    event: 'alert.updated',
    id: ev.id,
    venue_id: a.venue_id,
    aggregate: { type: 'alert', id: a.id, version: null },
    data: { cause: ev.type, ...alertView(a) },
  });
}
