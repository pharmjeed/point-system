import type { CustomerConsentsBody, CustomerMe, CustomerMePatchBody } from '@point/shared/customer';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { buildCustomerMe, type ConsentTexts } from './account-views.js';

/** The account row first (FOR NO KEY UPDATE): every write of the account serializes on it (DEC-497). */
export async function lockCustomerAccount(tx: Tx, accountId: string): Promise<void> {
  const r = await tx.maybeOne<{ status: string }>(
    `SELECT status FROM customer_accounts WHERE id = $1 FOR NO KEY UPDATE`,
    [accountId],
  );
  if (!r) throw new AppError('AUTH_UNAUTHENTICATED');
  if (r.status === 'deleted') throw new AppError('ACCOUNT_DELETED');
  if (r.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
}

/** `PATCH /v1/customer/me` (C-04 name, C-19 language). */
export async function patchCustomerMe(
  tx: Tx,
  texts: ConsentTexts,
  actor: CustomerActorContext,
  body: CustomerMePatchBody,
  client: ClientInfo,
): Promise<CustomerMe> {
  await lockCustomerAccount(tx, actor.accountId);
  const sets: string[] = [];
  const params: unknown[] = [actor.accountId];
  if (body.display_name !== undefined) {
    params.push(body.display_name);
    sets.push(`display_name = $${params.length}`);
  }
  if (body.locale !== undefined) {
    params.push(body.locale);
    sets.push(`locale = $${params.length}`);
  }
  await tx.query(`UPDATE customer_accounts SET ${sets.join(', ')} WHERE id = $1`, params);
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.account.update',
    entityType: 'customer_account',
    entityId: actor.accountId,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    // which fields changed, never the name itself (personal data stays out of the audit metadata)
    metadata: { fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) },
  });
  return buildCustomerMe(tx, texts, actor.accountId);
}

/**
 * `POST /v1/customer/consents`: one append-only row per answer, with the version the customer saw. A version other
 * than the one in force → CUSTOMER_CONSENT_VERSION_STALE (`kind`, `current_version`) and nothing is written.
 */
export async function recordCustomerConsents(
  tx: Tx,
  texts: ConsentTexts,
  actor: CustomerActorContext,
  body: CustomerConsentsBody,
  client: ClientInfo,
): Promise<CustomerMe> {
  await lockCustomerAccount(tx, actor.accountId);
  for (const a of body.consents) {
    const current = texts.versions[a.kind];
    if (a.version !== current)
      throw new AppError('CUSTOMER_CONSENT_VERSION_STALE', { kind: a.kind, current_version: current });
  }
  for (const a of body.consents)
    await tx.query(
      `INSERT INTO customer_account_consents (account_id, kind, version, granted, request_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.accountId, a.kind, a.version, a.granted, client.requestId, tx.now],
    );
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.consents.record',
    entityType: 'customer_account',
    entityId: actor.accountId,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: {
      answers: body.consents.map((c) => ({ kind: c.kind, version: c.version, granted: c.granted })),
    },
  });
  return buildCustomerMe(tx, texts, actor.accountId);
}
