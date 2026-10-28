import { Inject, Injectable } from '@nestjs/common';
import { assertExplicitVenue, type ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import { AppError } from '../../../core/errors/app-error.js';
import { maskPhone, redact } from '../../../core/logging/redact.js';
import { DATABASE, ENV } from '../../../http/tokens.js';
import { maskPhonesInText } from '../domain/monitor-rules.js';
import { CursorCodec, isIdCursor } from './cursor.js';

export interface AuditLogFilters {
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  action?: string;
  venue_id?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

interface AuditRow {
  id: number;
  occurred_at: Date;
  actor_type: 'user' | 'customer' | 'system';
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  venue_id: string | null;
  request_id: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/** 07 `AuditEntry`: no ip/user agent; diffs redacted again on the way out; phones in free text masked. */
export function auditEntryView(r: AuditRow) {
  return {
    id: Number(r.id),
    occurred_at: new Date(r.occurred_at).toISOString(),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    venue_id: r.venue_id,
    request_id: r.request_id,
    reason: r.reason === null ? null : maskPhonesInText(r.reason, maskPhone),
    before: r.before === null ? null : redact(r.before),
    after: r.after === null ? null : redact(r.after),
    metadata: r.metadata === null ? null : redact(r.metadata),
  };
}

/**
 * `GET /v1/admin/audit-log` (07 §2.7, 09 §3 `audit.read`: owner and admin, organization scope). Newest
 * first, cursor on `audit_log.id`. Reading the log is itself audited (09 §3: «قراءة السجل نفسها تُسجل»).
 */
@Injectable()
export class AuditQuery {
  private readonly cursors: CursorCodec;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    this.cursors = new CursorCodec(env.SESSION_SECRET);
  }

  async list(actor: ActorContext, f: AuditLogFilters, requestId: string) {
    if (f.venue_id) assertExplicitVenue(actor, f.venue_id);
    if (f.from && f.to && Date.parse(f.from) > Date.parse(f.to))
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'from', issue: 'after_to' }] });
    const after = f.cursor ? this.cursors.decode('audit-log', f.cursor, isIdCursor).id : null;
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [
        actor.orgId,
        actor.orgScope ? null : [...actor.venueIds],
        f.entity_type ?? null,
        f.entity_id ?? null,
        f.actor_id ?? null,
        f.action ?? null,
        f.venue_id ?? null,
        f.from ?? null,
        f.to ?? null,
        after,
        f.limit + 1,
      ];
      const rows = await tx.rows<AuditRow>(
        `SELECT id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, venue_id, request_id, reason, before, after, metadata
           FROM audit_log
          WHERE org_id = $1
            AND ($2::uuid[] IS NULL OR venue_id = ANY($2::uuid[]))
            AND ($3::text IS NULL OR entity_type = $3)
            AND ($4::uuid IS NULL OR entity_id = $4)
            AND ($5::text IS NULL OR actor_id = $5)
            AND ($6::text IS NULL OR action = $6)
            AND ($7::uuid IS NULL OR venue_id = $7)
            AND ($8::timestamptz IS NULL OR occurred_at >= $8)
            AND ($9::timestamptz IS NULL OR occurred_at <= $9)
            AND ($10::bigint IS NULL OR id < $10)
          ORDER BY id DESC
          LIMIT $11`,
        params,
      );
      const page = rows.slice(0, f.limit);
      const last = page.at(-1);
      await audit(tx, {
        orgId: actor.orgId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'audit.read',
        entityType: 'audit_log',
        venueId: f.venue_id ?? null,
        requestId,
        metadata: {
          filters: {
            entity_type: f.entity_type ?? null,
            entity_id: f.entity_id ?? null,
            actor_id: f.actor_id ?? null,
            action: f.action ?? null,
            venue_id: f.venue_id ?? null,
            from: f.from ?? null,
            to: f.to ?? null,
            limit: f.limit,
            paged: after !== null,
          },
          returned: page.length,
        },
      });
      return {
        data: page.map(auditEntryView),
        next_cursor:
          rows.length > f.limit && last ? this.cursors.encode('audit-log', { id: Number(last.id) }) : null,
      };
    });
  }
}
