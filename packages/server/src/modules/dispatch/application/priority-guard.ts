import type { TicketQueryable } from '../../tickets-custody/index.js';

export type OlderActionable = {
  older_task_id: string;
  older_offer_id: string;
};

/**
 * The priority guard (PNT-056; 10 §5.4): an OLDER live round of the pool on which the driver is a recipient and
 * which he could act on now (a broadcast, or a single round before `expires_at + dispatch.accept_grace_ms`)
 * blocks taking a newer task — by his own accept, or by a supervisor's reassignment to him without
 * `override_priority`. An older task still `queued` (no round) does not block: nobody can take it yet; nor does
 * an older task offered exclusively to someone else.
 */
export async function findOlderActionable(
  q: TicketQueryable,
  m: {
    poolId: string;
    userId: string;
    taskId: string;
    priorityAt: Date;
    seq: number;
    now: Date;
    graceMs: number;
  },
): Promise<OlderActionable | null> {
  const r = await q.query<OlderActionable>(
    `SELECT t2.id AS older_task_id, o2.id AS older_offer_id
       FROM tasks t2
       JOIN task_offers o2 ON o2.task_id = t2.id AND o2.status = 'active'
       JOIN offer_recipients r2 ON r2.offer_id = o2.id AND r2.user_id = $1
      WHERE t2.dispatch_pool_id = $2 AND t2.status IN ('offered','broadcast') AND t2.id <> $3
        AND (t2.priority_at, t2.seq) < ($4::timestamptz, $5::bigint)
        AND (o2.mode = 'broadcast' OR o2.expires_at > $6)
      ORDER BY t2.priority_at, t2.seq
      LIMIT 1`,
    [m.userId, m.poolId, m.taskId, m.priorityAt, m.seq, new Date(m.now.getTime() - m.graceMs)],
  );
  return r.rows[0] ?? null;
}
