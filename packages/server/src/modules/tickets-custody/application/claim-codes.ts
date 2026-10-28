import type { Tx } from '../../../core/db/tx.js';

/**
 * The live handover code of a retrieval cycle stops working (10 §9.3/§9.4, TT-20b, TT-21): `revoked_at`,
 * the reason, and the only encrypted copy purged (DEC-38). Issuing and verifying codes belong to PNT-047;
 * revocation is needed by the cancel-after-start and repark flows of S4 whether or not a code exists.
 */
export async function revokeLiveClaimCode(
  tx: Tx,
  cycleId: string,
  reason: 'reparked' | 'canceled',
): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `UPDATE claim_codes SET revoked_at = $2, revoke_reason = $3, code_ciphertext = NULL
      WHERE cycle_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [cycleId, tx.now, reason],
  );
  return r.rows.map((x) => x.id);
}
