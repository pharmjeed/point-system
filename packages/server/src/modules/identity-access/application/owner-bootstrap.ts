import { randomToken } from '../../../core/crypto/crypto.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Tx } from '../../../core/db/tx.js';

export interface FirstOwnerInput {
  orgId: string;
  phoneE164: string;
  fullName: string;
  /** argon2id + AUTH_SECRET_PEPPER of the temporary password (hashed before the transaction) */
  secretHash: string;
  /**
   * Where the phone must be free: the organization (`users` is unique per organization, the create-owner tool) or
   * every organization (the platform console, DEC-485: staff sign-in by phone takes the oldest account holding it,
   * so a new operator's owner on a phone already in use elsewhere could never sign in).
   */
  phoneScope: 'org' | 'all';
}

export type FirstOwnerResult =
  { ok: true; userId: string; employeeCode: string } | { ok: false; reason: 'owner_exists' | 'phone_in_use' };

/**
 * The first owner of an organization (09 §2: no staff API creates an owner) — shared by the installation tool
 * `create-owner` (DEC-302) and the platform console's «إضافة مشغل» (V2-003, DEC-485), inside the caller's
 * transaction: the next `O-####` code, an owner account with the temporary password (`must_change_secret`, no TOTP:
 * the first sign-in changes the password then sets MFA up, DEC-82) and its active org scope row. The caller writes
 * the audit entry and shows the password once.
 */
export async function insertFirstOwner(tx: Tx, input: FirstOwnerInput): Promise<FirstOwnerResult> {
  const owner = await tx.maybeOne(`SELECT 1 FROM users WHERE org_id = $1 AND role = 'owner' LIMIT 1`, [
    input.orgId,
  ]);
  if (owner) return { ok: false, reason: 'owner_exists' };
  // two consoles creating operators with one owner phone at once: the second waits here, then sees the first
  if (input.phoneScope === 'all')
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('point.owner_phone:' || $1))`, [input.phoneE164]);
  const taken =
    input.phoneScope === 'all'
      ? await tx.maybeOne(`SELECT 1 FROM users WHERE phone_e164 = $1 LIMIT 1`, [input.phoneE164])
      : await tx.maybeOne(`SELECT 1 FROM users WHERE org_id = $1 AND phone_e164 = $2`, [
          input.orgId,
          input.phoneE164,
        ]);
  if (taken) return { ok: false, reason: 'phone_in_use' };

  const n = await tx.one<{ n: number }>(
    `SELECT COALESCE(MAX(substring(employee_code from '^O-([0-9]+)$')::int), 0) + 1 AS n
       FROM users WHERE org_id = $1 AND employee_code ~ '^O-[0-9]+$'`,
    [input.orgId],
  );
  const employeeCode = `O-${String(n.n).padStart(4, '0')}`;
  const userId = newId();
  await tx.query(
    `INSERT INTO users (id, org_id, employee_code, full_name, phone_e164, role, can_drive, status, secret_kind,
                        secret_hash, must_change_secret, mfa_enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'owner', false, 'active', 'password', $6, true, false, $7, $7)`,
    [userId, input.orgId, employeeCode, input.fullName, input.phoneE164, input.secretHash, tx.now],
  );
  // 09 §2 rule 1: the owner reaches the organization through an active org scope row
  await tx.query(
    `INSERT INTO role_scopes (id, org_id, user_id, scope_type, granted_at) VALUES ($1, $2, $3, 'org', $4)`,
    [newId(), input.orgId, userId, tx.now],
  );
  return { ok: true, userId, employeeCode };
}

/** 16 random base64url characters, like the temporary staff passwords (DEC-78); shown once, never stored. */
export function newOwnerTemporaryPassword(): string {
  return randomToken(12);
}
