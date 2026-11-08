import { audit } from '../../../core/audit/audit-writer.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import {
  deleteMediaObjects,
  hasMediaObjectDeleter,
  type StorageBucketKind,
} from '../../../core/hooks/media-objects.js';
import type { Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { RetryableJobError, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { retentionCutoffs, retentionOf, type RetentionCutoffs } from '../domain/retention-rules.js';
import { nextCronRun, retentionDedupeKey } from '../domain/schedule.js';

/** Database role of the purge (migration 0004_retention_role.sql, 06 ERD §8.3). */
export const RETENTION_DB_ROLE = 'point_retention';
export const RETENTION_JOB = 'job.retention_purge';

export type PurgeAction = 'delete' | 'redact' | 'mark' | 'anonymize';

export interface PurgeStepResult {
  step: string;
  table: string;
  action: PurgeAction;
  /** rows eligible when the step started */
  candidates: number;
  /** rows deleted / redacted / marked */
  applied: number;
  /** objects that could not be deleted (retried by the next run) */
  failed: number;
  skipped?: 'no_object_deleter' | 'error';
  error?: string;
}

export interface PurgeRunResult {
  orgId: string;
  runId: string;
  dryRun: boolean;
  steps: PurgeStepResult[];
}

interface PurgeContext {
  orgId: string;
  runId: string;
  now: Date;
  cut: RetentionCutoffs;
}

/**
 * SQL predicate: ticket `t` is released for retention (06 ERD §8.1–8.2): closed, its event closed, no open or
 * in-review incident on the ticket or on its event (legal hold, also payment disputes), and its retention base
 * — the close time, or the last resolution of such an incident if later — before `cutoff`.
 */
const released = (t: string, cutoff: string) => `(
  ${t}.status IN ('delivered','voided')
  AND EXISTS (SELECT 1 FROM events ev WHERE ev.id = ${t}.event_id AND ev.status = 'closed')
  AND NOT EXISTS (SELECT 1 FROM incidents ih WHERE ih.status IN ('open','in_review')
                   AND (ih.ticket_id = ${t}.id OR (ih.ticket_id IS NULL AND ih.event_id = ${t}.event_id)))
  AND GREATEST(COALESCE(${t}.delivered_at, ${t}.voided_at, ${t}.updated_at),
               COALESCE((SELECT max(ir.resolved_at) FROM incidents ir
                          WHERE ir.ticket_id = ${t}.id OR (ir.ticket_id IS NULL AND ir.event_id = ${t}.event_id)),
                        '-infinity'::timestamptz)) < ${cutoff})`;

/** SQL predicate: no open incident holds the ticket `ticketIdExpr` (rows that only need the legal hold). */
const notHeld = (ticketIdExpr: string) => `NOT EXISTS (
  SELECT 1 FROM tickets th JOIN incidents ih
    ON ih.status IN ('open','in_review') AND (ih.ticket_id = th.id OR (ih.ticket_id IS NULL AND ih.event_id = th.event_id))
   WHERE th.id = ${ticketIdExpr})`;

/** A purge step that only touches the database: candidates, then batches of ids in short transactions. */
interface DbStep {
  step: string;
  table: string;
  action: PurgeAction;
  /** `<tables> WHERE <predicate>`; `$1` is always the organization id */
  from(c: PurgeContext): { sql: string; params: unknown[] };
  /** candidate id selected as text */
  id: string;
  batch?: number;
  /** alias locked `FOR NO KEY UPDATE … SKIP LOCKED` while a batch is applied (rows others may hold) */
  lockOf?: string;
  apply(tx: Tx, ids: string[], c: PurgeContext): Promise<void>;
}

/** A purge step that deletes storage objects first, then marks the rows of the keys deleted. */
interface ObjectStep {
  step: string;
  table: string;
  action: PurgeAction;
  bucket: StorageBucketKind;
  /** `<tables> WHERE <predicate>` selecting `<alias>.id` and `<alias>.storage_key` */
  from(c: PurgeContext): { sql: string; params: unknown[] };
  id: string;
  key: string;
  /** marks the rows whose object is gone (or that never had one); returns the ids marked */
  mark(tx: Tx, ids: string[], c: PurgeContext): Promise<number>;
}

const DB_STEPS_BEFORE_OBJECTS: DbStep[] = [
  {
    step: 'idempotency_keys',
    table: 'idempotency_keys',
    action: 'delete',
    from: (c) => ({
      sql: `idempotency_keys k JOIN users u ON u.id = k.user_id WHERE u.org_id = $1 AND k.expires_at <= $2`,
      params: [c.orgId, c.now],
    }),
    id: `k.user_id::text || '|' || k.key`,
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM idempotency_keys WHERE (user_id::text || '|' || key) = ANY($1::text[])`, [
        ids,
      ]);
    },
  },
  {
    // DEC-101: an upload never completed within its URL lifetime (+ margin) is `failed`; no object to delete
    step: 'stale_uploads',
    table: 'media_assets',
    action: 'mark',
    from: (c) => ({
      sql: `media_assets m WHERE m.org_id = $1 AND m.upload_status = 'pending' AND m.created_at < $2`,
      params: [c.orgId, c.cut.staleUploads],
    }),
    id: 'm.id::text',
    apply: async (tx, ids) => {
      await tx.query(
        `UPDATE media_assets SET upload_status = 'failed' WHERE id = ANY($1::uuid[]) AND upload_status = 'pending'`,
        [ids],
      );
    },
  },
];

const OBJECT_STEPS: ObjectStep[] = [
  {
    step: 'photos',
    table: 'media_assets',
    action: 'delete',
    bucket: 'media',
    from: (c) => ({
      sql: `media_assets m JOIN tickets t ON t.id = m.ticket_id
             WHERE m.org_id = $1 AND m.upload_status = 'uploaded' AND ${released('t', '$2')}`,
      params: [c.orgId, c.cut.photos],
    }),
    id: 'm.id',
    key: 'm.storage_key',
    // no hold re-check here: these objects are already gone, so the row must say so (a hold opened in the
    // moment between the candidate read and the deletion cannot bring them back)
    mark: async (tx, ids, c) =>
      (
        await tx.query(
          `UPDATE media_assets SET upload_status = 'deleted', deleted_at = $2, delete_reason = 'retention'
            WHERE id = ANY($1::uuid[]) AND upload_status = 'uploaded'`,
          [ids, c.now],
        )
      ).rowCount ?? 0,
  },
  {
    step: 'export_files',
    table: 'exports',
    action: 'mark',
    bucket: 'exports',
    from: (c) => ({
      sql: `exports x WHERE x.org_id = $1 AND x.status = 'ready' AND x.expires_at <= $2`,
      params: [c.orgId, c.now],
    }),
    id: 'x.id',
    key: 'x.storage_key',
    mark: async (tx, ids) =>
      (
        await tx.query(
          `UPDATE exports SET status = 'expired' WHERE id = ANY($1::uuid[]) AND status = 'ready'`,
          [ids],
        )
      ).rowCount ?? 0,
  },
];

const DB_STEPS_AFTER_OBJECTS: DbStep[] = [
  {
    step: 'export_rows',
    table: 'exports',
    action: 'delete',
    from: (c) => ({
      sql: `exports x WHERE x.org_id = $1 AND x.status IN ('expired','failed') AND x.created_at < $2`,
      params: [c.orgId, c.cut.exportRows],
    }),
    id: 'x.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM exports WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    // raw webhook bodies after processing (retention.wa_raw_days); rows without an org are the single org's (V1)
    step: 'webhook_raw_bodies',
    table: 'whatsapp_inbound_events',
    action: 'redact',
    from: (c) => ({
      sql: `whatsapp_inbound_events w WHERE (w.org_id = $1 OR w.org_id IS NULL) AND w.status <> 'pending'
              AND w.received_at < $2 AND w.raw_body <> ''`,
      params: [c.orgId, c.cut.waRaw],
    }),
    id: 'w.id::text',
    apply: async (tx, ids) => {
      await tx.query(`UPDATE whatsapp_inbound_events SET raw_body = '' WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'webhook_events',
    table: 'whatsapp_inbound_events',
    action: 'delete',
    from: (c) => ({
      sql: `whatsapp_inbound_events w WHERE (w.org_id = $1 OR w.org_id IS NULL) AND w.status <> 'pending'
              AND w.received_at < $2`,
      params: [c.orgId, c.cut.waMessages],
    }),
    id: 'w.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM whatsapp_inbound_events WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    // message text and addresses; the structure (ids, statuses, times) stays (06 ERD §8.1)
    step: 'wa_messages',
    table: 'whatsapp_messages',
    action: 'redact',
    from: (c) => ({
      sql: `whatsapp_messages m WHERE m.org_id = $1 AND m.created_at < $2
              AND (m.body_redacted IS NOT NULL OR m.payload_redacted IS NOT NULL OR m.recipient_wa_id IS NOT NULL
                   OR m.sender_wa_id IS NOT NULL OR m.recipient_user_id IS NOT NULL OR m.sender_user_id IS NOT NULL)
              AND (m.ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = m.ticket_id AND ${released('t', '$2')}))`,
      params: [c.orgId, c.cut.waMessages],
    }),
    id: 'm.id::text',
    apply: async (tx, ids) => {
      await tx.query(
        `UPDATE whatsapp_messages
            SET body_redacted = NULL, payload_redacted = NULL, recipient_wa_id = NULL, sender_wa_id = NULL,
                recipient_user_id = NULL, sender_user_id = NULL
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    },
  },
  {
    step: 'notifications',
    table: 'notifications',
    action: 'delete',
    from: (c) => ({
      sql: `notifications n WHERE n.org_id = $1 AND n.created_at < $2 AND n.status <> 'pending'
              AND (n.ticket_id IS NULL OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = n.ticket_id AND ${released('t', '$2')}))`,
      params: [c.orgId, c.cut.waMessages],
    }),
    id: 'n.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM notification_attempts WHERE notification_id = ANY($1::uuid[])`, [ids]);
      await tx.query(
        `UPDATE whatsapp_messages SET notification_id = NULL WHERE notification_id = ANY($1::uuid[])`,
        [ids],
      );
      await tx.query(`DELETE FROM notifications WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    // DEC-38 safety net: the only encrypted copy of a handover code never outlives its code
    step: 'claim_copies',
    table: 'claim_codes',
    action: 'redact',
    from: (c) => ({
      sql: `claim_codes k WHERE k.org_id = $1 AND k.code_ciphertext IS NOT NULL
              AND (k.expires_at <= $2 OR k.consumed_at IS NOT NULL OR k.revoked_at IS NOT NULL)`,
      params: [c.orgId, c.now],
    }),
    id: 'k.id::text',
    apply: async (tx, ids) => {
      await tx.query(`UPDATE claim_codes SET code_ciphertext = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'action_tokens',
    table: 'action_tokens',
    action: 'delete',
    from: (c) => ({
      sql: `action_tokens a WHERE a.org_id = $1 AND (a.expires_at < $2 OR a.revoked_at < $2) AND ${notHeld('a.ticket_id')}`,
      params: [c.orgId, c.cut.actionTokens],
    }),
    id: 'a.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM action_tokens WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'link_codes',
    table: 'link_codes',
    action: 'delete',
    from: (c) => ({
      sql: `link_codes l WHERE l.org_id = $1 AND l.expires_at < $2 AND l.status NOT IN ('active','pending_confirmation')
              AND ${notHeld('l.ticket_id')}`,
      params: [c.orgId, c.cut.linkCodes],
    }),
    id: 'l.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM link_codes WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'auth_sessions',
    table: 'auth_sessions',
    action: 'delete',
    from: (c) => ({
      sql: `auth_sessions s WHERE s.org_id = $1 AND (s.expires_at < $2 OR s.revoked_at < $2)`,
      params: [c.orgId, c.cut.sessions],
    }),
    id: 's.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'device_push_keys',
    table: 'devices',
    action: 'redact',
    from: (c) => ({
      sql: `devices d WHERE d.org_id = $1 AND d.revoked_at < $2 AND d.push_endpoint IS NOT NULL`,
      params: [c.orgId, c.cut.revokedDevices],
    }),
    id: 'd.id::text',
    apply: async (tx, ids) => {
      await tx.query(
        `UPDATE devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    },
  },
  {
    // anonymization, not deletion (06 ERD §8.1): the structure stays for statistics and money.
    // paper_serial is kept: ck_tickets_paper_serial requires it on a paper ticket that is not voided.
    step: 'tickets',
    table: 'tickets',
    action: 'anonymize',
    from: (c) => ({
      sql: `tickets t WHERE t.org_id = $1 AND ${released('t', '$2')}
              AND (t.plate_digits IS NOT NULL OR t.plate_letters_ar IS NOT NULL OR t.plate_letters_en IS NOT NULL
                   OR t.plate_raw IS NOT NULL OR t.vehicle_make IS NOT NULL OR t.vehicle_model IS NOT NULL
                   OR t.vehicle_color IS NOT NULL OR t.vehicle_type IS NOT NULL OR t.notes IS NOT NULL
                   OR t.key_tag IS NOT NULL OR t.current_spot_note IS NOT NULL OR t.customer_id IS NOT NULL)`,
      params: [c.orgId, c.cut.tickets],
    }),
    id: 't.id::text',
    lockOf: 't',
    apply: async (tx, ids) => {
      await tx.query(
        `UPDATE tickets
            SET plate_digits = NULL, plate_letters_ar = NULL, plate_letters_en = NULL, plate_raw = NULL,
                vehicle_make = NULL, vehicle_model = NULL, vehicle_color = NULL, vehicle_type = NULL,
                notes = NULL, key_tag = NULL, current_spot_note = NULL, customer_id = NULL, version = version + 1
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      await tx.query(
        `UPDATE custody_events SET note = NULL WHERE ticket_id = ANY($1::uuid[]) AND note IS NOT NULL`,
        [ids],
      );
      await tx.query(
        `UPDATE vehicle_inspections SET notes = NULL, damage_marks = '[]'::jsonb
          WHERE ticket_id = ANY($1::uuid[]) AND (notes IS NOT NULL OR damage_marks <> '[]'::jsonb)`,
        [ids],
      );
    },
  },
  {
    step: 'alerts',
    table: 'alerts',
    action: 'delete',
    from: (c) => ({
      sql: `alerts a WHERE a.org_id = $1 AND a.status = 'resolved' AND a.resolved_at < $2`,
      params: [c.orgId, c.cut.alerts],
    }),
    id: 'a.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM alerts WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
  {
    step: 'audit_log',
    table: 'audit_log',
    action: 'delete',
    from: (c) => ({
      sql: `audit_log a WHERE a.org_id = $1 AND a.occurred_at < $2`,
      params: [c.orgId, c.cut.audit],
    }),
    id: 'a.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM audit_log WHERE id = ANY($1::bigint[])`, [ids]);
    },
  },
  {
    step: 'analytics_events',
    table: 'analytics_events',
    action: 'delete',
    batch: 10_000, // 15 §14
    from: (c) => ({
      sql: `analytics_events a WHERE a.org_id = $1 AND a.occurred_at < $2`,
      params: [c.orgId, c.cut.analytics],
    }),
    id: 'a.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM analytics_events WHERE id = ANY($1::bigint[])`, [ids]);
    },
  },
  {
    step: 'outbox_events',
    table: 'outbox_events',
    action: 'delete',
    from: (c) => ({
      sql: `outbox_events o WHERE o.org_id = $1
              AND ((o.status IN ('done','canceled') AND COALESCE(o.processed_at, o.created_at) < $2)
                OR (o.status IN ('failed','dead') AND COALESCE(o.processed_at, o.created_at) < $3))`,
      params: [c.orgId, c.cut.outboxDone, c.cut.outboxFailed],
    }),
    id: 'o.id::text',
    apply: async (tx, ids) => {
      await tx.query(`DELETE FROM outbox_events WHERE id = ANY($1::uuid[])`, [ids]);
    },
  },
];

/** Step order of a run (dry run included). */
export const RETENTION_STEPS: readonly string[] = [
  ...DB_STEPS_BEFORE_OBJECTS.map((s) => s.step),
  ...OBJECT_STEPS.map((s) => s.step),
  ...DB_STEPS_AFTER_OBJECTS.map((s) => s.step),
];

export interface RetentionPurgerOptions {
  /** MEDIA_UPLOAD_URL_TTL_S (DEC-101) */
  mediaUploadUrlTtlS?: number;
  /** rows per transaction (06 ERD §8.3: 1000) */
  batchSize?: number;
  /** upper bound of batches per step and run (the rest waits for the next run) */
  maxBatches?: number;
  /** renews the outbox lease between batches (long runs) */
  renewLease?: () => Promise<void>;
}

/**
 * job.retention_purge (PNT-091, 06 ERD §8): applies `organizations.settings.retention` and the technical
 * durations of 06 §8.1, step by step, in short transactions run as the `point_retention` role; storage
 * objects are deleted through the core seam between transactions, never inside one. Every batch writes an
 * audit row with its counts and the run writes a summary row (no silent deletes); a dry run only counts the
 * candidates (PNT-091 AC1). Tickets with an open incident — on the ticket or its event — and tickets of an
 * event that is not closed are never touched (06 §8.2).
 */
export class RetentionPurger {
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly ttlS: number;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: RetentionPurgerOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 1000;
    this.maxBatches = opts.maxBatches ?? 1000;
    this.ttlS = opts.mediaUploadUrlTtlS ?? (Number(process.env.MEDIA_UPLOAD_URL_TTL_S) || 300);
  }

  async run(orgId: string, o: { dryRun?: boolean; runId?: string } = {}): Promise<PurgeRunResult> {
    const started = this.clock.now();
    const org = (
      await this.db.rows<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [orgId])
    )[0];
    if (!org) throw new Error(`organization ${orgId} not found`);
    const policy = retentionOf(org.settings);
    const ctx: PurgeContext = {
      orgId,
      runId: o.runId ?? `manual:${started.toISOString()}`,
      now: started,
      cut: retentionCutoffs(started, policy, this.ttlS),
    };
    const dryRun = o.dryRun === true;
    const steps: PurgeStepResult[] = [];
    for (const s of DB_STEPS_BEFORE_OBJECTS) steps.push(await this.dbStep(s, ctx, dryRun));
    for (const s of OBJECT_STEPS) steps.push(await this.objectStep(s, ctx, dryRun));
    for (const s of DB_STEPS_AFTER_OBJECTS) steps.push(await this.dbStep(s, ctx, dryRun));

    await this.tx(async (tx) => {
      await audit(tx, {
        orgId,
        actor: { type: 'system', id: null },
        action: RETENTION_JOB,
        entityType: 'organization',
        entityId: orgId,
        metadata: {
          run_id: ctx.runId,
          dry_run: dryRun,
          policy: {
            photos_days: policy.photos_days,
            wa_messages_days: policy.wa_messages_days,
            tickets_months: policy.tickets_months,
            audit_months: policy.audit_months,
            wa_raw_days: policy.wa_raw_days,
            analytics_months: policy.analytics_months,
            approved_by_owner: policy.approved_by_owner === true,
          },
          steps,
        },
      });
    });
    metrics.retentionDuration.observe((this.clock.now().getTime() - started.getTime()) / 1000);
    this.logger.info(
      {
        org_id: orgId,
        run_id: ctx.runId,
        dry_run: dryRun,
        steps: steps.map((s) => `${s.step}:${s.candidates}/${s.applied}${s.skipped ? `:${s.skipped}` : ''}`),
      },
      'retention purge',
    );
    return { orgId, runId: ctx.runId, dryRun, steps };
  }

  /** One short transaction as the retention role (06 ERD §8.3). */
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${RETENTION_DB_ROLE}`);
      return fn(tx);
    });
  }

  private async count(from: { sql: string; params: unknown[] }): Promise<number> {
    const r = await this.db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${from.sql}`, from.params);
    return r[0]?.n ?? 0;
  }

  private batchAudit(
    tx: Tx,
    ctx: PurgeContext,
    s: { step: string; table: string; action: PurgeAction },
    m: Record<string, unknown>,
  ) {
    return audit(tx, {
      orgId: ctx.orgId,
      actor: { type: 'system', id: null },
      action: RETENTION_JOB,
      entityType: s.table,
      metadata: { run_id: ctx.runId, step: s.step, action: s.action, ...m },
    });
  }

  private async dbStep(s: DbStep, ctx: PurgeContext, dryRun: boolean): Promise<PurgeStepResult> {
    const result: PurgeStepResult = {
      step: s.step,
      table: s.table,
      action: s.action,
      candidates: 0,
      applied: 0,
      failed: 0,
    };
    try {
      const from = s.from(ctx);
      result.candidates = await this.count(from);
      if (dryRun || result.candidates === 0) return result;
      const size = s.batch ?? this.batchSize;
      for (let batch = 1; batch <= this.maxBatches; batch++) {
        const n = await this.tx(async (tx) => {
          const ids = (
            await tx.rows<{ id: string }>(
              `SELECT ${s.id} AS id FROM ${from.sql} LIMIT $${from.params.length + 1}${s.lockOf ? ` FOR NO KEY UPDATE OF ${s.lockOf} SKIP LOCKED` : ''}`,
              [...from.params, size],
            )
          ).map((r) => r.id);
          if (ids.length === 0) return 0;
          await s.apply(tx, ids, ctx);
          await this.batchAudit(tx, ctx, s, { batch, rows: ids.length });
          return ids.length;
        });
        result.applied += n;
        metrics.retentionRows.inc({ step: s.step }, n);
        if (n < size) break;
        await this.opts.renewLease?.();
      }
    } catch (err) {
      result.skipped = 'error';
      result.error = (err as Error).message.slice(0, 300);
      this.logger.error({ step: s.step, org_id: ctx.orgId, err: result.error }, 'retention step failed');
    }
    return result;
  }

  private async objectStep(s: ObjectStep, ctx: PurgeContext, dryRun: boolean): Promise<PurgeStepResult> {
    const result: PurgeStepResult = {
      step: s.step,
      table: s.table,
      action: s.action,
      candidates: 0,
      applied: 0,
      failed: 0,
    };
    try {
      const from = s.from(ctx);
      result.candidates = await this.count(from);
      if (dryRun || result.candidates === 0) return result;
      let after = '00000000-0000-0000-0000-000000000000';
      for (let batch = 1; batch <= this.maxBatches; batch++) {
        // read outside any transaction; the keyset skips rows whose object failed this run
        const rows = await this.db.rows<{ id: string; key: string | null }>(
          `SELECT ${s.id}::text AS id, ${s.key} AS key FROM ${from.sql} AND ${s.id} > $${from.params.length + 1}::uuid
            ORDER BY ${s.id} LIMIT $${from.params.length + 2}`,
          [...from.params, after, this.batchSize],
        );
        if (rows.length === 0) break;
        after = rows.at(-1)!.id;
        const withObject = rows.filter((r) => r.key);
        if (withObject.length && !hasMediaObjectDeleter(s.bucket)) {
          result.skipped = 'no_object_deleter';
          this.logger.warn(
            { step: s.step, bucket: s.bucket },
            'retention: no object deleter registered; step skipped',
          );
          break;
        }
        // network, with no transaction open (canon §2): objects first, rows after (06 ERD §8.3)
        const deleted = await deleteMediaObjects(
          withObject.map((r) => r.key!),
          s.bucket,
        );
        const gone = new Set(deleted.deleted);
        const ids = rows.filter((r) => !r.key || gone.has(r.key)).map((r) => r.id);
        result.failed += deleted.failed.length;
        const marked = ids.length
          ? await this.tx(async (tx) => {
              const n = await s.mark(tx, ids, ctx);
              await this.batchAudit(tx, ctx, s, {
                batch,
                rows: n,
                objects_deleted: deleted.deleted.length,
                objects_failed: deleted.failed.length,
              });
              return n;
            })
          : 0;
        result.applied += marked;
        metrics.retentionRows.inc({ step: s.step }, marked);
        if (deleted.failed.length)
          this.logger.warn(
            { step: s.step, failed: deleted.failed.length, sample: deleted.failed[0]?.error },
            'retention: objects not deleted; retried next run',
          );
        if (rows.length < this.batchSize) break;
        await this.opts.renewLease?.();
      }
    } catch (err) {
      result.skipped = 'error';
      result.error = (err as Error).message.slice(0, 300);
      this.logger.error({ step: s.step, org_id: ctx.orgId, err: result.error }, 'retention step failed');
    }
    return result;
  }
}

/** Schedules the next daily run (`retention:<date>`, 04 §6.6) on the first organization's row. */
export async function scheduleRetention(tx: Tx, cron: string, after: Date): Promise<string | null> {
  const next = nextCronRun(cron, after);
  const org = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM organizations ORDER BY created_at, id LIMIT 1`,
  );
  if (!org) return null;
  return schedule(tx, RETENTION_JOB, next, {
    orgId: org.id,
    dedupeKey: retentionDedupeKey(next),
    payload: { scope: 'all' },
  });
}

/** Re-creates the daily schedule when no run is pending (first start, or after a dead run). */
export async function ensureRetentionScheduled(tx: Tx, cron: string): Promise<string | null> {
  const pending = await tx.maybeOne(
    `SELECT 1 FROM outbox_events WHERE type = $1 AND status IN ('pending','processing') LIMIT 1`,
    [RETENTION_JOB],
  );
  if (pending) return null;
  return scheduleRetention(tx, cron, tx.now);
}

export interface RetentionJobOptions extends Omit<RetentionPurgerOptions, 'renewLease'> {
  /** RETENTION_PURGE_CRON_UTC (05 §8) */
  cron?: string;
}

/**
 * The `job.retention_purge` handler (mode external: storage calls between short transactions). Payload
 * `{ scope: 'all' }` (11 §8.11), optionally `org_id`, `dry_run: true` (counts only, audited) and
 * `reschedule: false`. A scheduled run plans the next one; a failed step makes the job retry with backoff.
 */
export function retentionPurgeJob(opts: RetentionJobOptions = {}): JobHandler {
  const cron = opts.cron ?? process.env.RETENTION_PURGE_CRON_UTC ?? '0 2 * * *';
  nextCronRun(cron, new Date(0)); // a malformed expression fails at registration, not at 02:00
  return {
    type: RETENTION_JOB,
    mode: 'external',
    async handle({ row, db, clock, logger, renewLease }) {
      const p = (row.payload ?? {}) as { org_id?: unknown; dry_run?: unknown; reschedule?: unknown };
      const dryRun = p.dry_run === true;
      const purger = new RetentionPurger(db, clock, logger, { ...opts, renewLease });
      const orgs =
        typeof p.org_id === 'string'
          ? [p.org_id]
          : (await db.rows<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at, id`)).map(
              (r) => r.id,
            );
      const failed: string[] = [];
      for (const orgId of orgs) {
        const r = await purger.run(orgId, { dryRun, runId: row.id });
        for (const s of r.steps) if (s.skipped === 'error') failed.push(s.step);
      }
      if (!dryRun && p.reschedule !== false)
        await db.transaction((tx) => scheduleRetention(tx, cron, clock.now()));
      if (failed.length)
        throw new RetryableJobError(`retention steps failed: ${[...new Set(failed)].join(', ')}`);
    },
  };
}
