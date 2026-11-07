import type { Tx } from '../db/tx.js';
import { redact } from '../logging/redact.js';

export interface CustomerAuditEntry {
  /** the signed-in account, or a caller before sign-in (`anonymous`: the code request, a wrong code) */
  actor: { type: 'customer'; accountId: string } | { type: 'anonymous' } | { type: 'system'; name: string };
  /** e.g. customer.auth.otp_requested, customer.auth.signed_in, customer.vehicle.add */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** the account the action concerns (for an anonymous actor: the account signed in, when there is one) */
  accountId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes `customer_audit_log` (append-only: the app role has INSERT/SELECT only, 0009; V2-010, DEC-498) in the
 * command's transaction. Customer accounts belong to no operator, so these rows never go to an organization's
 * audit_log. Metadata is redacted like audit_log, and never carries a full phone number or a code (canon rule 8).
 */
export async function customerAudit(tx: Tx, e: CustomerAuditEntry): Promise<void> {
  const accountId = e.actor.type === 'customer' ? e.actor.accountId : (e.accountId ?? null);
  const metadata = redact({
    ...(e.metadata ?? {}),
    ...(e.actor.type === 'system' ? { system: e.actor.name } : {}),
  });
  await tx.query(
    `INSERT INTO customer_audit_log (occurred_at, actor_type, account_id, action, entity_type, entity_id, request_id, ip,
                                     user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tx.now,
      e.actor.type,
      accountId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.requestId ?? null,
      e.ip ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      JSON.stringify(metadata),
    ],
  );
  tx.auditCount++;
}
