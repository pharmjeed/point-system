import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

export interface PointChannel {
  id: string;
  orgId: string;
  healthStatus: string;
}

/**
 * The Point number that sends the customer app's sign-in codes (V2-D02: one WhatsApp number for every operator;
 * DEC-496): the active channel of the organization POINT runs itself (`organizations.is_platform_operated`), else —
 * a deployment with a single operator, which is the V1 shape — the oldest active channel, as the webhook addresses
 * an unnamed delivery (DEC-475). Its health is the caller's to judge: a `down` number cannot deliver a code, and
 * another operator's number never stands in for it.
 */
export async function pointChannel(q: Q): Promise<PointChannel | null> {
  const r = await q.query<{ id: string; org_id: string; health_status: string }>(
    `SELECT c.id, c.org_id, c.health_status FROM whatsapp_channel c JOIN organizations o ON o.id = c.org_id
      WHERE c.is_active
      ORDER BY o.is_platform_operated DESC, c.created_at, c.id LIMIT 1`,
  );
  const row = r.rows[0];
  return row ? { id: row.id, orgId: row.org_id, healthStatus: row.health_status } : null;
}
