import { Inject, Injectable } from '@nestjs/common';
import type { AlertSeverity, AlertStatus, AlertType } from '@point/shared';
import { assertExplicitVenue, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { alertView, publishStatus, type AlertRow } from '../../../core/alerts/alerts.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { DATABASE } from '../../../http/tokens.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';
import { scopeStillGranted } from './scope.js';

export interface ListAlertsQuery {
  venue_id?: string;
  status?: AlertStatus[];
  type?: AlertType;
  severity?: AlertSeverity;
  limit: number;
  cursor?: string;
}

export interface AlertCommandMeta {
  operation: string;
  requestId: string;
}

const DEFAULT_STATUSES: AlertStatus[] = ['open', 'acknowledged'];

const notFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'alert' });

/**
 * The supervisor alerts center (PNT-075; 07 §9.7, 11 §6.10, 14 §8, S-04). Alerts are raised and auto-resolved by
 * the core writer (DEC-79); this service lists them in the caller's venues and applies the two manual
 * transitions: open → acknowledged, open|acknowledged → resolved. Both go through `publishStatus`, which writes
 * `alert.acknowledged` / `alert.resolved` and the realtime `alert.updated` (11 §8.8).
 */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cursors: ListCursorCodec,
  ) {}

  /**
   * GET /v1/alerts — newest first (`raised_at`, `id`), statuses `open,acknowledged` by default. `venue_id`
   * outside the caller's scope → SCOPE_VENUE_DENIED (08 §1.3); without it every venue of the scope is listed.
   */
  async list(actor: ActorContext, q: ListAlertsQuery) {
    if (q.venue_id) assertExplicitVenue(actor, q.venue_id);
    const venues = q.venue_id ? [q.venue_id] : [...actor.venueIds].sort();
    const statuses = [...new Set(q.status?.length ? q.status : DEFAULT_STATUSES)].sort();
    const scope = `alerts|${q.venue_id ?? '*'}|${statuses.join(',')}|${q.type ?? ''}|${q.severity ?? ''}`;
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [actor.orgId, venues, statuses];
    let where = `a.org_id = $1 AND a.venue_id = ANY($2::uuid[]) AND a.status = ANY($3::text[])`;
    if (q.type) {
      params.push(q.type);
      where += ` AND a.type = $${params.length}`;
    }
    if (q.severity) {
      params.push(q.severity);
      where += ` AND a.severity = $${params.length}`;
    }
    if (after) {
      if (typeof after[0] !== 'string' || typeof after[1] !== 'string' || Number.isNaN(Date.parse(after[0])))
        throw new AppError('PAGINATION_CURSOR_INVALID');
      params.push(after[0], after[1]);
      where += ` AND (a.raised_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(q.limit + 1);
    const rows = await this.db.rows<AlertRow>(
      `SELECT a.* FROM alerts a WHERE ${where} ORDER BY a.raised_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
    return pageOf(rows, q.limit, alertView, (r) =>
      this.cursors.encode(scope, [new Date(r.raised_at).toISOString(), r.id]),
    );
  }

  /** POST /v1/alerts/{alertId}/acknowledge — stops the escalation sound of this alert (07). */
  async acknowledge(
    tx: Tx,
    actor: ActorContext,
    meta: AlertCommandMeta,
    alertId: string,
    body: { note?: string | null },
  ) {
    const a = await this.lockInScope(tx, actor, alertId);
    if (a.status !== 'open') throw transition(a, meta.operation, ['open']);
    const note = body.note?.trim() || null;
    const updated = await tx.one<AlertRow>(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [a.id, tx.now, actor.userId],
    );
    await publishStatus(tx, updated, actor.userId, false);
    await this.audit(tx, actor, meta, updated, a.status, note);
    return alertView(updated);
  }

  /** POST /v1/alerts/{alertId}/resolve — manual resolution with an optional note (`resolution_note`). */
  async resolve(
    tx: Tx,
    actor: ActorContext,
    meta: AlertCommandMeta,
    alertId: string,
    body: { note?: string | null },
  ) {
    const a = await this.lockInScope(tx, actor, alertId);
    if (a.status === 'resolved') throw transition(a, meta.operation, ['open', 'acknowledged']);
    const note = body.note?.trim() || null;
    const updated = await tx.one<AlertRow>(
      `UPDATE alerts SET status = 'resolved', resolved_at = $2, resolved_by = $3, resolution_note = $4
        WHERE id = $1 AND status <> 'resolved' RETURNING *`,
      [a.id, tx.now, actor.userId, note],
    );
    await publishStatus(tx, updated, actor.userId, false);
    await this.audit(tx, actor, meta, updated, a.status, note);
    return alertView(updated);
  }

  /**
   * The alert row under `FOR NO KEY UPDATE` (L9: alerts are guarded by uq_alerts_live_dedupe and only ever
   * locked alone), then the TOCTOU scope re-check (09 §8.4). Missing, another org or outside the scope →
   * RESOURCE_NOT_FOUND (`resource: alert`, 08 §1.3 rule 4).
   */
  private async lockInScope(tx: Tx, actor: ActorContext, alertId: string): Promise<AlertRow> {
    const a = await tx.maybeOne<AlertRow>(
      `SELECT * FROM alerts WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE`,
      [alertId, actor.orgId],
    );
    if (!a || !actor.venueIds.has(a.venue_id)) throw notFound();
    if (!(await scopeStillGranted(tx, actor, a.venue_id))) throw notFound();
    return a;
  }

  private audit(
    tx: Tx,
    actor: ActorContext,
    meta: AlertCommandMeta,
    a: AlertRow,
    before: AlertStatus,
    note: string | null,
  ) {
    return audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'alert.manage',
      entityType: 'alert',
      entityId: a.id,
      venueId: a.venue_id,
      requestId: meta.requestId,
      before: { status: before },
      after: { status: a.status },
      metadata: { operation: meta.operation, alert_type: a.type, note },
    });
  }
}

function transition(a: AlertRow, command: string, allowedFrom: AlertStatus[]): AppError {
  return new AppError('INVALID_STATE_TRANSITION', {
    entity_type: 'alert',
    entity_id: a.id,
    current_status: a.status,
    current_version: null,
    command,
    allowed_from: allowedFrom,
  });
}
