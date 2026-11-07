import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';

/** `YYYY-MM-DD` (operator_contracts.starts_on / ends_on are `date`; ends_on is exclusive, NULL = open-ended). */
export type IsoDate = string;

/**
 * «عقد سارٍ واحد لكل مشغل في أي يوم» (docs/v2/03 §1) without btree_gist (DEC-463): the command that creates or
 * changes a contract calls this first, inside its transaction. It locks the organization row (`FOR NO KEY UPDATE`,
 * ascending id when several — before any platform_users/operator_contracts write), so two concurrent commands for one
 * operator serialize here and the second sees the first's committed contract. Overlap uses the half-open ranges
 * [starts_on, ends_on) the EXCLUDE constraint of the draft would have used.
 *
 * Rejects an overlap with 409 INVALID_STATE_TRANSITION (`reason: contract_overlap`, the overlapping contract id) and
 * an unknown organization with 404 RESOURCE_NOT_FOUND (`resource: organization`).
 */
export async function assertNoContractOverlap(
  tx: Tx,
  orgId: string,
  period: { startsOn: IsoDate; endsOn: IsoDate | null },
  opts: { exceptContractId?: string } = {},
): Promise<void> {
  const org = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
    [orgId],
  );
  if (!org) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'organization' });
  const clash = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM operator_contracts
      WHERE org_id = $1 AND ($4::uuid IS NULL OR id <> $4)
        AND daterange(starts_on, ends_on, '[)') && daterange($2::date, $3::date, '[)')
      ORDER BY starts_on LIMIT 1`,
    [orgId, period.startsOn, period.endsOn, opts.exceptContractId ?? null],
  );
  if (clash) {
    throw new AppError('INVALID_STATE_TRANSITION', {
      entity_type: 'operator_contract',
      entity_id: clash.id,
      command: 'operator_contract.create',
      reason: 'contract_overlap',
    });
  }
}
