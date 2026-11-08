import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

/**
 * The organization the payment jobs are queued under (DEC-512): outbox_events.org_id is mandatory and the platform's
 * own work belongs to no operator, so its rows go to the organization POINT runs itself
 * (`organizations.is_platform_operated`), else — a deployment with a single operator, the V1 shape — the oldest
 * one, as the customer sign-in codes do (pointChannel, DEC-496). Payloads carry ids only, never an amount, a phone
 * or a token, so the operator whose outbox lists them learns nothing of a customer.
 */
export async function platformOrgId(q: Q): Promise<string | null> {
  const r = await q.query<{ id: string }>(
    `SELECT id FROM organizations ORDER BY is_platform_operated DESC, created_at, id LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}
