import type { Tx } from '../db/tx.js';
import { enqueue } from '../outbox/outbox-writer.js';

export const REALTIME_NOTIFY_CHANNEL = process.env.REALTIME_NOTIFY_CHANNEL ?? 'point_realtime';
const NOTIFY_MAX_BYTES = 7900; // PostgreSQL NOTIFY payload limit is 8000 bytes

export interface RealtimeMessage {
  /** server → client event name (canon §7.3), e.g. 'task.offered' */
  event: string;
  id: string;
  aggregate?: { type: string; id: string; version: number | null };
  /** becomes `payload` of the canon §7 envelope; `cause` = the domain event that produced it (07 §4.2) */
  data: Record<string, unknown>;
  occurred_at?: string;
  venue_id?: string | null;
  dispatch_pool_id?: string | null;
  event_id?: string | null;
  actor?: { type: 'user' | 'customer' | 'system'; id: string | null };
}

/**
 * Publishes inside the producing transaction with pg_notify (DEC-48): every api instance LISTENs on
 * point_realtime and relays to its sockets; nothing is delivered if the transaction rolls back. Payloads
 * too large for NOTIFY fall back to job.ws_publish carrying only the ids (never both paths).
 */
export async function publishRealtime(
  tx: Tx,
  orgId: string,
  rooms: string[],
  msg: RealtimeMessage,
): Promise<void> {
  if (rooms.length === 0) return;
  const json = JSON.stringify({
    org_id: orgId,
    rooms,
    message: { ...msg, occurred_at: msg.occurred_at ?? tx.now.toISOString() },
  });
  if (Buffer.byteLength(json) <= NOTIFY_MAX_BYTES) {
    await tx.query(`SELECT pg_notify($1, $2)`, [REALTIME_NOTIFY_CHANNEL, json]);
    return;
  }
  await enqueue(tx, {
    type: 'job.ws_publish',
    orgId,
    dedupeKey: `ws:${msg.id}`,
    payload: { rooms, event: msg.event, event_id: msg.id, aggregate: msg.aggregate ?? null },
  });
}
