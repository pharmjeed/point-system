import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Queryable } from '../infra/channel.js';
import type { CustomerRow, WaSenderIdentity } from '../infra/customers.js';

/** `rq1.` + 16 random bytes base64url = 26 characters (12 §5.11; payload < 128 characters). */
export const ACTION_TOKEN_PREFIX = 'rq1.';

export function newActionToken(): string {
  return ACTION_TOKEN_PREFIX + randomBytes(16).toString('base64url');
}

/** Only sha256(token) is stored (`action_tokens.token_hash`, `whatsapp_messages.button_payload_hash`). */
export function actionTokenHash(token: string): string {
  return sha256Hex(token);
}

export interface ActionTokenRow {
  id: string;
  org_id: string;
  ticket_id: string;
  customer_id: string;
  action: 'request_retrieval';
  token_hash: string;
  link_version: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_count: number;
}

/** Issues a token for W-01 (expires `ttlHours` after creation, wa.action_token_ttl_h); returns the raw value once. */
export async function issueActionToken(
  tx: Tx,
  a: { orgId: string; ticketId: string; customerId: string; linkVersion: number; ttlHours: number },
): Promise<{ id: string; token: string }> {
  for (let i = 0; i < 5; i++) {
    const token = newActionToken();
    // action_tokens_token_hash_key: a collision regenerates (08 §5.2)
    const r = await tx.maybeOne<{ id: string }>(
      `INSERT INTO action_tokens (org_id, ticket_id, customer_id, token_hash, link_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + make_interval(hours => $7))
       ON CONFLICT (token_hash) DO NOTHING RETURNING id`,
      [a.orgId, a.ticketId, a.customerId, actionTokenHash(token), a.linkVersion, tx.now, a.ttlHours],
    );
    if (r) return { id: r.id, token };
  }
  throw new Error('could not issue a unique action token');
}

export async function findActionTokenByHash(q: Queryable, hash: string): Promise<ActionTokenRow | null> {
  const r = await q.query<ActionTokenRow>(`SELECT * FROM action_tokens WHERE token_hash = $1`, [hash]);
  return r.rows[0] ?? null;
}

/** 11 §5.3: revoked, expired (72 h from creation, no grace) or an older link_version make a button inactive (W-09). */
export function actionTokenState(
  t: Pick<ActionTokenRow, 'revoked_at' | 'expires_at' | 'link_version'>,
  now: Date,
  ticketLinkVersion: number,
): 'usable' | 'revoked' | 'expired' | 'stale_link_version' {
  if (t.revoked_at) return 'revoked';
  if (new Date(t.expires_at).getTime() <= now.getTime()) return 'expired';
  if (t.link_version !== ticketLinkVersion) return 'stale_link_version';
  return 'usable';
}

export async function touchActionToken(tx: Tx, id: string): Promise<void> {
  await tx.query(`UPDATE action_tokens SET last_used_at = $2, use_count = use_count + 1 WHERE id = $1`, [
    id,
    tx.now,
  ]);
}

/** Phone change / void (11 §5.3): every token of the ticket stops working. */
export async function revokeActionTokens(tx: Tx, ticketId: string): Promise<number> {
  const r = await tx.query(
    `UPDATE action_tokens SET revoked_at = $2 WHERE ticket_id = $1 AND revoked_at IS NULL`,
    [ticketId, tx.now],
  );
  return r.rowCount ?? 0;
}

/**
 * 12 §6.4 `sameCustomer`: the sender is the token's customer when the wa_id, the BSUID or the phone
 * matches (a forwarded button from another number never does, AC-02).
 */
export function sameCustomer(
  c: Pick<CustomerRow, 'wa_id' | 'wa_user_id' | 'phone_e164'>,
  s: WaSenderIdentity,
): boolean {
  return (
    (!!s.waId && c.wa_id === s.waId) ||
    (!!s.userId && c.wa_user_id === s.userId) ||
    (!!s.phoneE164 && c.phone_e164 === s.phoneE164)
  );
}
