import { Inject, Injectable } from '@nestjs/common';
import type { ExportKind, ExportStatus } from '@point/shared';
import { hasPermission, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import { CLOCK, DATABASE, ENV } from '../../../http/tokens.js';
import type { ObjectStorage } from '../../media/index.js';
import { EXPORT_CONTENT_TYPE, EXPORTS_STORAGE } from '../infra/exports-storage.js';
import type { ExportFilters } from './export-data.js';
import { assertRange } from './reports.js';
import { assertNamedVenue, findEventInScope, isUuid, notFound } from './scope.js';
import { iso } from './views.js';

export const EXPORT_JOB = 'job.export_generate';
/** 06 ERD §8.1: an export file lives 24 hours, its row 90 days (the retention job). */
export const EXPORT_FILE_TTL_MS = 24 * 3600 * 1000;
export const EXPORT_JOB_MAX_ATTEMPTS = 5;

export interface ExportRow {
  id: string;
  org_id: string;
  requested_by: string;
  kind: ExportKind;
  filters: ExportFilters;
  status: ExportStatus;
  storage_key: string | null;
  row_count: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
}

export function exportView(x: ExportRow, now: Date, downloadUrl: string | null = null) {
  // a file past its expiry is gone for the caller even before the retention job marks the row
  const expired = x.status === 'ready' && x.expires_at !== null && new Date(x.expires_at) <= now;
  return {
    id: x.id,
    kind: x.kind,
    filters: x.filters ?? {},
    status: expired ? ('expired' as const) : x.status,
    row_count: x.row_count,
    error: x.error,
    created_at: iso(x.created_at)!,
    completed_at: iso(x.completed_at),
    expires_at: iso(x.expires_at),
    download_url: expired ? null : downloadUrl,
  };
}

/**
 * `POST /v1/exports` and `GET /v1/exports/{exportId}` (PNT-089; 07 §2.7, 09 §3 `export.create`). The request
 * only validates the scope of the filters (a named venue outside it → SCOPE_VENUE_DENIED, an event outside it →
 * 404), stores the row `pending`, schedules `job.export_generate` and audits the creation with its filters; the
 * worker builds the CSV. The download link is presigned for the requester only, short-lived, and every link
 * issued is audited (09 §11: «وكل تنزيل بوقته»).
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(EXPORTS_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async request(
    tx: Tx,
    actor: ActorContext,
    body: { kind: ExportKind; filters: ExportFilters },
    requestId: string,
  ) {
    const f = body.filters;
    // 07: an audit export needs audit.read as well (owner and administrators)
    if (body.kind === 'audit' && !hasPermission(actor, 'audit.read'))
      throw new AppError('PERMISSION_DENIED', { permission: 'audit.read', reason: 'audit_read_required' });
    if (f.venue_id) assertNamedVenue(actor, f.venue_id);
    if (f.event_id) await findEventInScope(tx, actor, f.event_id);
    if (f.from && f.to) assertRange(f.from, f.to);
    const filters: ExportFilters = {
      ...(f.venue_id ? { venue_id: f.venue_id } : {}),
      ...(f.event_id ? { event_id: f.event_id } : {}),
      ...(f.from ? { from: new Date(f.from).toISOString() } : {}),
      ...(f.to ? { to: new Date(f.to).toISOString() } : {}),
    };
    const row = await tx.one<ExportRow>(
      `INSERT INTO exports (id, org_id, requested_by, kind, filters, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
      [newId(), actor.orgId, actor.userId, body.kind, JSON.stringify(filters), tx.now],
    );
    await enqueue(tx, {
      type: EXPORT_JOB,
      orgId: actor.orgId,
      venueId: f.venue_id ?? null,
      aggregate: { type: 'export', id: row.id, version: null },
      dedupeKey: `export:${row.id}`,
      maxAttempts: EXPORT_JOB_MAX_ATTEMPTS,
      payload: { export_id: row.id },
    });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'export.create',
      entityType: 'export',
      entityId: row.id,
      venueId: f.venue_id ?? null,
      requestId,
      after: { kind: body.kind, status: 'pending' },
      metadata: { operation: 'POST /v1/exports', kind: body.kind, filters },
    });
    return exportView(row, tx.now);
  }

  /** The requester's own export only (another user's or another org's is 404, 09 §4.7). */
  async get(actor: ActorContext, exportId: string, requestId: string) {
    if (!isUuid(exportId)) throw notFound('export');
    const now = this.clock.now();
    const row = (await this.db.query<ExportRow>(`SELECT * FROM exports WHERE id = $1`, [exportId])).rows[0];
    if (!row || row.org_id !== actor.orgId || row.requested_by !== actor.userId) throw notFound('export');
    const live =
      row.status === 'ready' && row.storage_key && row.expires_at && new Date(row.expires_at) > now;
    if (!live) return exportView(row, now);
    const left = Math.floor((new Date(row.expires_at!).getTime() - now.getTime()) / 1000);
    const ttl = Math.max(1, Math.min(this.env.EXPORT_URL_TTL_S, left));
    // presigning is local computation (no network); the link itself is a credential and is never logged
    const link = await this.storage.presignDownload(row.storage_key!, {
      expiresInS: ttl,
      now,
      contentType: EXPORT_CONTENT_TYPE,
      cacheControl: 'private, no-store',
    });
    await this.db.transaction(async (tx) => {
      await audit(tx, {
        orgId: actor.orgId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'export.create',
        entityType: 'export',
        entityId: row.id,
        requestId,
        metadata: {
          operation: 'GET /v1/exports/{exportId}',
          download_link_issued: true,
          kind: row.kind,
          row_count: row.row_count,
          link_expires_at: link.expiresAt.toISOString(),
        },
      });
    });
    return exportView(row, now, link.url);
  }
}
