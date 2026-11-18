import type { Tx } from '../db/tx.js';
import { redact } from '../logging/redact.js';
import { audit } from './audit-writer.js';

export interface PlatformAuditEntry {
  /** the platform account, or the bootstrap/system (`id: null`) */
  actor: { type: 'platform_user'; id: string; role: string } | { type: 'system'; id: null; name: string };
  /** e.g. platform.auth.login, operator.suspend, plan.price_change (docs/v2/03 §1) */
  action: string;
  entityType: string;
  entityId?: string | null;
  /**
   * The operator organization the action touches. When set, the same action is also written to that
   * organization's audit_log (docs/v2/02 §1: «في platform_audit_log وفي audit_log للمؤسسة المعنية إن مسّها»).
   */
  orgId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes `platform_audit_log` (append-only: the app role has INSERT/SELECT only, 0008) in the command's transaction,
 * and the organization's `audit_log` when the action touches one (actor_type `system`, actor_id
 * `platform:<platform_users.id>`, the platform role in the metadata). Metadata is redacted like audit_log.
 */
export async function platformAudit(tx: Tx, e: PlatformAuditEntry): Promise<void> {
  const metadata = redact({
    ...(e.metadata ?? {}),
    ...(e.actor.type === 'system' ? { system: e.actor.name } : {}),
  });
  await tx.query(
    `INSERT INTO platform_audit_log (occurred_at, actor_type, actor_id, actor_role, action, entity_type, entity_id, org_id,
                                     request_id, ip, user_agent, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      tx.now,
      e.actor.type,
      e.actor.id,
      e.actor.type === 'platform_user' ? e.actor.role : null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.orgId ?? null,
      e.requestId ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      e.reason ?? null,
      JSON.stringify(metadata),
    ],
  );
  tx.auditCount++;
  if (e.orgId) {
    await audit(tx, {
      orgId: e.orgId,
      actor: {
        type: 'system',
        id: e.actor.type === 'platform_user' ? `platform:${e.actor.id}` : `platform:${e.actor.name}`,
        role: e.actor.type === 'platform_user' ? e.actor.role : null,
      },
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      requestId: e.requestId ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      reason: e.reason ?? null,
      metadata: { ...(e.metadata ?? {}), source: 'platform' },
    });
  }
}
