import { randomDigits, randomToken } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { pinProblem } from '../domain/secret-policy.js';

/** Next employee code per org and prefix (D- drivers, S- supervisors, A- admins), serialized by an advisory lock. */
export async function nextEmployeeCode(tx: Tx, orgId: string, prefix: 'D' | 'S' | 'A'): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee_code:${orgId}:${prefix}`]);
  const r = await tx.one<{ n: number }>(
    `SELECT COALESCE(MAX(substring(employee_code from '^${prefix}-([0-9]+)$')::int), 0) + 1 AS n
       FROM users WHERE org_id = $1 AND employee_code ~ '^${prefix}-[0-9]+$'`,
    [orgId],
  );
  return `${prefix}-${String(r.n).padStart(4, '0')}`;
}

/** A temporary 6-digit PIN shown once to the admin (09 §9.1), itself compliant with the PIN rules. */
export function temporaryPin(ctx: { phoneE164?: string | null; employeeCode?: string | null }): string {
  for (;;) {
    const pin = randomDigits(6);
    if (!pinProblem(pin, ctx)) return pin;
  }
}

/** A temporary staff password (≥ 12 chars, URL-safe random). */
export function temporaryPassword(): string {
  return randomToken(12); // 16 base64url characters
}
