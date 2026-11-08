import { randomBytes } from 'node:crypto';
import {
  base64UrlEncode,
  parsePassToken,
  PASS_SECRET_BYTES,
  PASS_STEP_S,
  PASS_TOKEN_PREFIX,
  saudiPlateDisplay,
  verifyPassToken,
  type CustomerPass,
} from '@point/shared/customer';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import { decrypt, encrypt, type EncryptionKey } from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { lockCustomerAccount } from './account-service.js';

/** The secret is rotated on the first `GET /v1/customer/pass` after this many days (DEC-500). */
export const PASS_ROTATE_AFTER_DAYS = 30;
/** A rotated-out secret still verifies for this long, for a device that cached it and is offline (DEC-500). */
export const PASS_PREVIOUS_GRACE_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;

export interface PassKeys {
  /** DATA_ENCRYPTION_KEY: encrypts new secrets */
  key: EncryptionKey;
  /** every key that may have encrypted a stored secret */
  keys: EncryptionKey[];
}

export interface CustomerPassRow {
  account_id: string;
  secret_ciphertext: string;
  previous_secret_ciphertext: string | null;
  previous_valid_until: Date | null;
  key_version: number;
  last_used_step: string | number | null;
  last_used_at: Date | null;
  rotated_at: Date;
}

const newSecret = () => base64UrlEncode(new Uint8Array(randomBytes(PASS_SECRET_BYTES)));

/**
 * The secrets a token of the account may be signed with now: the current one, and the previous one until its grace
 * ends. Plaintext lives in memory only (canon rule 8: never logged, never in a response other than the account's).
 */
export function passSecrets(row: CustomerPassRow, keys: EncryptionKey[], now: Date): string[] {
  const out = [decrypt(row.secret_ciphertext, keys)];
  if (
    row.previous_secret_ciphertext &&
    row.previous_valid_until &&
    row.previous_valid_until.getTime() > now.getTime()
  )
    out.push(decrypt(row.previous_secret_ciphertext, keys));
  return out;
}

/**
 * `GET /v1/customer/pass` (C-11, V2-013, DEC-500): the account's pass secret for the signed-in device, created on
 * the first call and rotated once older than {@link PASS_ROTATE_AFTER_DAYS} (the previous one verifies for
 * {@link PASS_PREVIOUS_GRACE_DAYS} more days), with the server time the app corrects its clock by and the vehicles
 * to choose from. Lock order: the account row, then the pass row (the intake takes them in the same order).
 * Issue and rotation are audited in customer_audit_log without the secret.
 */
export async function getCustomerPass(
  tx: Tx,
  keys: PassKeys,
  accountId: string,
  client: ClientInfo,
): Promise<CustomerPass> {
  await lockCustomerAccount(tx, accountId);
  const now = tx.now;
  let row = await tx.maybeOne<CustomerPassRow>(
    `SELECT * FROM customer_passes WHERE account_id = $1 FOR NO KEY UPDATE`,
    [accountId],
  );
  let secret: string;
  if (!row) {
    secret = newSecret();
    row = await tx.one<CustomerPassRow>(
      `INSERT INTO customer_passes (account_id, secret_ciphertext, rotated_at, created_at)
       VALUES ($1, $2, $3, $3) RETURNING *`,
      [accountId, encrypt(secret, keys.key), now],
    );
    await customerAudit(tx, {
      actor: { type: 'customer', accountId },
      action: 'customer.pass.issued',
      entityType: 'customer_pass',
      entityId: accountId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { key_version: row.key_version },
    });
  } else if (now.getTime() - row.rotated_at.getTime() >= PASS_ROTATE_AFTER_DAYS * DAY_MS) {
    secret = newSecret();
    row = await tx.one<CustomerPassRow>(
      `UPDATE customer_passes
          SET previous_secret_ciphertext = secret_ciphertext, previous_valid_until = $3,
              secret_ciphertext = $2, key_version = key_version + 1, rotated_at = $4
        WHERE account_id = $1 RETURNING *`,
      [
        accountId,
        encrypt(secret, keys.key),
        new Date(now.getTime() + PASS_PREVIOUS_GRACE_DAYS * DAY_MS),
        now,
      ],
    );
    await customerAudit(tx, {
      actor: { type: 'customer', accountId },
      action: 'customer.pass.rotated',
      entityType: 'customer_pass',
      entityId: accountId,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { key_version: row.key_version },
    });
  } else {
    secret = decrypt(row.secret_ciphertext, keys.keys);
  }
  const vehicles = await tx.rows<{
    id: string;
    plate_digits: string | null;
    plate_letters_ar: string | null;
    plate_raw: string | null;
    vehicle_make: string | null;
    vehicle_color: string | null;
  }>(
    `SELECT id, plate_digits, plate_letters_ar, plate_raw, vehicle_make, vehicle_color
       FROM customer_vehicles WHERE account_id = $1 AND removed_at IS NULL ORDER BY created_at, id`,
    [accountId],
  );
  return {
    scheme: PASS_TOKEN_PREFIX,
    account_id: accountId,
    secret,
    step_seconds: PASS_STEP_S,
    server_time: now.toISOString(),
    rotated_at: row.rotated_at.toISOString(),
    refresh_after: new Date(row.rotated_at.getTime() + PASS_ROTATE_AFTER_DAYS * DAY_MS).toISOString(),
    vehicles: vehicles.map((v) => ({
      vehicle_id: v.id,
      plate_display:
        saudiPlateDisplay({ digits: v.plate_digits, letters_ar: v.plate_letters_ar }) || (v.plate_raw ?? ''),
      vehicle_make: v.vehicle_make,
      vehicle_color: v.vehicle_color,
    })),
  };
}

/** The account behind a verified pass, with what the operator may keep of it (V2-D12). */
export interface VerifiedPass {
  accountId: string;
  /** the vehicle chosen on C-11 (not yet checked against the account: see the intake) */
  vehicleId: string | null;
  step: number;
  phoneE164: string;
  displayName: string | null;
  locale: 'ar' | 'en';
}

/**
 * Verifies a scanned pass token at intake (O-01; V2-013, DEC-500), inside the intake command. Lock order: after the
 * organization row (FOR SHARE) and before L1/L5 — the account row FOR SHARE, then the pass row FOR NO KEY UPDATE,
 * the order `GET /v1/customer/pass` takes them in (the customer side never locks an operator row). Refusals:
 * PASS_INVALID (`malformed`, `account_unavailable` — unknown, suspended or deleted account alike —, `bad_signature`),
 * PASS_EXPIRED (`stale`, `future` outside the current step ± 1, `already_used` for a step at or before the last
 * intake's). The step is consumed by {@link markPassUsed} in the same transaction.
 */
export async function verifyIntakePass(tx: Tx, keys: EncryptionKey[], token: string): Promise<VerifiedPass> {
  const parsed = parsePassToken(token);
  if (!parsed) throw new AppError('PASS_INVALID', { reason: 'malformed' });
  const account = await tx.maybeOne<{
    id: string;
    status: string;
    phone_e164: string;
    display_name: string | null;
    locale: 'ar' | 'en';
  }>(`SELECT id, status, phone_e164, display_name, locale FROM customer_accounts WHERE id = $1 FOR SHARE`, [
    parsed.accountId,
  ]);
  if (!account || account.status !== 'active')
    throw new AppError('PASS_INVALID', { reason: 'account_unavailable' });
  const row = await tx.maybeOne<CustomerPassRow>(
    `SELECT * FROM customer_passes WHERE account_id = $1 FOR NO KEY UPDATE`,
    [parsed.accountId],
  );
  if (!row) throw new AppError('PASS_INVALID', { reason: 'bad_signature' });
  const v = verifyPassToken({ token, secrets: passSecrets(row, keys, tx.now), nowMs: tx.now.getTime() });
  if (!v.ok) {
    if (v.reason === 'stale' || v.reason === 'future')
      throw new AppError('PASS_EXPIRED', { reason: v.reason });
    throw new AppError('PASS_INVALID', { reason: v.reason === 'malformed' ? 'malformed' : 'bad_signature' });
  }
  if (row.last_used_step !== null && v.step <= Number(row.last_used_step))
    throw new AppError('PASS_EXPIRED', { reason: 'already_used' });
  return {
    accountId: account.id,
    vehicleId: v.vehicleId,
    step: v.step,
    phoneE164: account.phone_e164,
    displayName: account.display_name,
    locale: account.locale,
  };
}

/** Consumes the pass step (the row is locked by {@link verifyIntakePass}): an equal or older step is refused next. */
export async function markPassUsed(tx: Tx, accountId: string, step: number): Promise<void> {
  await tx.query(`UPDATE customer_passes SET last_used_step = $2, last_used_at = $3 WHERE account_id = $1`, [
    accountId,
    step,
    tx.now,
  ]);
}
