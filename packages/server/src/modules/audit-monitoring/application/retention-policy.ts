import { Injectable } from '@nestjs/common';
import type { OrgSettings, RetentionPolicyEditable } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { RETENTION_SECTION, retentionOf } from '../domain/retention-rules.js';

type Q = Pick<Tx, 'maybeOne'> | Pick<Database, 'query'>;

/** 07 `RetentionPolicy`: `organizations.settings.retention.*` with the canon §12 defaults (Q-06). */
export function retentionPolicyView(r: OrgSettings['retention'], updatedAt: Date | null) {
  return {
    photos_days: r.photos_days,
    wa_messages_days: r.wa_messages_days,
    tickets_months: r.tickets_months,
    audit_months: r.audit_months,
    wa_raw_days: r.wa_raw_days,
    analytics_months: r.analytics_months,
    approved_by_owner: r.approved_by_owner === true,
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

async function one<R>(q: Q, text: string, params: unknown[]): Promise<R | null> {
  if ('maybeOne' in q) return q.maybeOne<R & Record<string, unknown>>(text, params) as Promise<R | null>;
  const r = await q.query(text, params);
  return (r.rows[0] as R | undefined) ?? null;
}

/**
 * `GET /v1/admin/retention-policy` (`audit.read`) and `PUT` (`retention.manage`, owner only, canon §10).
 * The PUT is the owner's approval of the durations (`approved_by_owner = true`, DEC-67); `updated_at` is
 * the time of the last `retention.manage` audit row (DEC-67: not stored in the jsonb).
 */
@Injectable()
export class RetentionPolicyService {
  async get(q: Q, actor: ActorContext) {
    const row = await one<{ settings: unknown; updated_at: Date | null }>(
      q,
      `SELECT o.settings,
              (SELECT max(a.occurred_at) FROM audit_log a
                WHERE a.org_id = o.id AND a.entity_type = 'organization' AND a.entity_id = o.id AND a.action = 'retention.manage') AS updated_at
         FROM organizations o WHERE o.id = $1`,
      [actor.orgId],
    );
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'organization' });
    return retentionPolicyView(retentionOf(row.settings), row.updated_at);
  }

  /**
   * Touches `settings.retention` only: read-modify-write of that one section under the organization row lock
   * (`FOR NO KEY UPDATE`), every other section (`security`, `heartbeat`, `ops`… — `/v1/admin/org-settings`)
   * kept byte for byte.
   */
  async put(tx: Tx, actor: ActorContext, body: RetentionPolicyEditable, requestId: string) {
    const row = await tx.maybeOne<{ settings: Record<string, unknown> | null }>(
      `SELECT settings FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
      [actor.orgId],
    );
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'organization' });
    const stored = (row.settings ?? {}).retention;
    const parsedBefore = RETENTION_SECTION.safeParse(stored ?? {});
    const before = parsedBefore.success
      ? { ...parsedBefore.data, approved_by_owner: parsedBefore.data.approved_by_owner === true }
      : (stored ?? null); // a section that no longer parses is replaced, and audited as it was
    const next = RETENTION_SECTION.parse({ ...body, approved_by_owner: true });
    // (trg_organizations_updated_at stamps updated_at)
    await tx.query(
      `UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{retention}', $2::jsonb)
        WHERE id = $1`,
      [actor.orgId, JSON.stringify(next)],
    );
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'retention.manage',
      entityType: 'organization',
      entityId: actor.orgId,
      requestId,
      before: { retention: before },
      after: { retention: next },
    });
    return retentionPolicyView(next, tx.now);
  }
}
