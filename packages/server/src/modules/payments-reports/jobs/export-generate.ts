import { audit } from '../../../core/audit/audit-writer.js';
import {
  PermanentJobError,
  RetryableJobError,
  type JobContext,
  type JobHandler,
} from '../../../core/outbox/dispatcher.js';
import { ObjectStorageError, type ObjectStorage } from '../../media/index.js';
import { buildExport, ExportTooLarge } from '../application/export-data.js';
import { EXPORT_FILE_TTL_MS, EXPORT_JOB, type ExportRow } from '../application/exports.js';
import { staffVenueIds } from '../application/scope.js';
import { EXPORT_CONTENT_TYPE, exportStorageKey, registeredExportsStorage } from '../infra/exports-storage.js';

/** Long reads of an export run with a longer statement timeout than a command (05 §7.4: 5 s by default). */
const EXPORT_QUERY_TIMEOUT_MS = 30_000;

/**
 * `job.export_generate` (PNT-089; 11 §8.11, mode `external`): claim the row (`pending|running → running`, a
 * crashed attempt is resumed), read the data in one short REPEATABLE READ, READ ONLY transaction limited to the
 * requester's venues at generation time, build the CSV in memory, upload it to the private exports bucket outside
 * any transaction (canon §2), then mark the row `ready` with `row_count`, `completed_at` and `expires_at`
 * (24 hours, 06 ERD §8.1) and an audit row. Storage outages are retried; the last attempt, a misconfigured
 * bucket, a lost scope or too many rows mark the export `failed` with the reason.
 */
export function exportGenerateHandler(
  storage: () => ObjectStorage | null = registeredExportsStorage,
): JobHandler {
  return {
    type: EXPORT_JOB,
    mode: 'external',
    async handle(ctx) {
      const exportId = String(ctx.row.payload?.export_id ?? '');
      const row = (
        await ctx.db.query<ExportRow>(
          `UPDATE exports SET status = 'running', error = NULL
            WHERE id = $1 AND status IN ('pending','running') RETURNING *`,
          [exportId],
        )
      ).rows[0];
      if (!row) return; // already ready, failed or expired: nothing to do
      const store = storage();
      if (!store) throw new RetryableJobError('no exports storage is registered in this process');

      const scope = await staffVenueIds(ctx.db, row.requested_by);
      if (!scope || scope.orgId !== row.org_id) return fail(ctx, row, 'requester_inactive');
      if (row.kind === 'audit' && !scope.canReadAudit) return fail(ctx, row, 'scope_revoked');
      const filters = row.filters ?? {};
      if (filters.venue_id && !scope.venueIds.includes(filters.venue_id))
        return fail(ctx, row, 'scope_revoked');

      let built: { csv: string; rowCount: number };
      try {
        built = await ctx.db
          .transaction(
            async (tx) => {
              await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
              if (filters.event_id) {
                const ev = await tx.maybeOne<{ venue_id: string }>(
                  `SELECT venue_id FROM events WHERE id = $1`,
                  [filters.event_id],
                );
                if (!ev || !scope.venueIds.includes(ev.venue_id)) return null;
              }
              return buildExport(
                tx,
                row.kind,
                { orgId: row.org_id, venueIds: scope.venueIds, now: tx.now },
                filters,
              );
            },
            { statementTimeoutMs: EXPORT_QUERY_TIMEOUT_MS },
          )
          .then((r) => {
            if (r === null) throw new ScopeRevoked();
            return r;
          });
      } catch (e) {
        if (e instanceof ScopeRevoked) return fail(ctx, row, 'scope_revoked');
        if (e instanceof ExportTooLarge) return fail(ctx, row, 'too_many_rows');
        throw e;
      }

      const key = exportStorageKey(row.org_id, row.id);
      try {
        await store.put(key, Buffer.from(built.csv, 'utf8'), {
          contentType: EXPORT_CONTENT_TYPE,
          cacheControl: 'private, no-store',
        });
      } catch (e) {
        if (e instanceof ObjectStorageError && e.failure !== 'misconfigured') {
          if (ctx.row.attempts >= ctx.row.max_attempts) return fail(ctx, row, 'storage_unavailable');
          throw new RetryableJobError(`export upload failed: ${e.failure}`);
        }
        await fail(ctx, row, 'storage_error');
        throw new PermanentJobError(`export upload failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      await ctx.db.transaction(async (tx) => {
        const done = await tx.maybeOne<{ id: string }>(
          `UPDATE exports SET status = 'ready', storage_key = $2, row_count = $3, completed_at = $4,
                  expires_at = $5, error = NULL
            WHERE id = $1 AND status = 'running' RETURNING id`,
          [row.id, key, built.rowCount, tx.now, new Date(tx.now.getTime() + EXPORT_FILE_TTL_MS)],
        );
        if (!done) return;
        await audit(tx, {
          orgId: row.org_id,
          actor: { type: 'system', id: null },
          action: EXPORT_JOB,
          entityType: 'export',
          entityId: row.id,
          metadata: {
            kind: row.kind,
            status: 'ready',
            row_count: built.rowCount,
            requested_by: row.requested_by,
          },
        });
      });
    },
  };
}

class ScopeRevoked extends Error {}

async function fail(ctx: JobContext, row: ExportRow, reason: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const r = await tx.maybeOne<{ id: string }>(
      `UPDATE exports SET status = 'failed', error = $2, completed_at = $3
        WHERE id = $1 AND status IN ('pending','running') RETURNING id`,
      [row.id, reason, tx.now],
    );
    if (!r) return;
    await audit(tx, {
      orgId: row.org_id,
      actor: { type: 'system', id: null },
      action: EXPORT_JOB,
      entityType: 'export',
      entityId: row.id,
      metadata: { kind: row.kind, status: 'failed', error: reason, requested_by: row.requested_by },
    });
  });
}
