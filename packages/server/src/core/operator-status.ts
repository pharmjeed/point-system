import { OPERATOR_BLOCKED_STATUSES, type OperatorStatus } from '@point/shared';
import type { Database } from './db/database.js';
import type { Tx } from './db/tx.js';
import { AppError, InvariantViolation } from './errors/app-error.js';

type Q = Pick<Tx, 'query'> | Pick<Database, 'query'>;

async function statusOf(q: Q, orgId: string, lock: '' | 'FOR SHARE' = ''): Promise<OperatorStatus | null> {
  const r = await q.query<{ operator_status: OperatorStatus }>(
    `SELECT operator_status FROM organizations WHERE id = $1 ${lock}`,
    [orgId],
  );
  return r.rows[0]?.operator_status ?? null;
}

/**
 * Whether the operator may be shown to the public — the customer map and venue listings (V2-004, docs/v2/02 §4:
 * «مواقعه تختفي من خريطة التطبيق»): `operator_status = 'active'` only. A `trial` operator runs simulator venues
 * without real customers, an `invited` one has none yet, and `suspended` / `terminated` are hidden (DEC-487).
 * A plain read: listings are never the source of truth for a command.
 */
export async function isOperatorActive(q: Q, orgId: string): Promise<boolean> {
  return (await statusOf(q, orgId)) === 'active';
}

/**
 * V2-005 (02 §4, DEC-486): the staff commands that start something new — opening an event (or reopening a closing
 * one), opening a shift, starting a duty, starting a ticket intake — refuse a `suspended` or `terminated` operator
 * with 409 OPERATOR_SUSPENDED (`details.operator_status`). Work already in progress is not checked and completes.
 *
 * Reads the organization row `FOR SHARE` as the command's first lock (before L1): the platform's status change
 * holds that row `FOR NO KEY UPDATE`, so a command and a suspension serialize and a command that passed this check
 * commits before the suspension does. Deadlock-free: the platform and settings commands that lock the organization
 * row hold no L1–L10 row (DEC-462, DEC-121), and FOR SHARE locks do not conflict with each other.
 */
export async function assertOperatorOperating(tx: Tx, orgId: string): Promise<void> {
  const status = await statusOf(tx, orgId, 'FOR SHARE');
  if (!status) throw new InvariantViolation(`organization ${orgId} of an authenticated actor is missing`);
  if ((OPERATOR_BLOCKED_STATUSES as readonly string[]).includes(status))
    throw new AppError('OPERATOR_SUSPENDED', { operator_status: status });
}
