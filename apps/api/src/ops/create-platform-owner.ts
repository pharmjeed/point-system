import { parseArgs } from 'node:util';
import {
  SecretHasher,
  newId,
  normalizePhone,
  platformAudit,
  randomToken,
  type Database,
  type Env,
} from '@point/server';

/**
 * The installation tool that creates the first platform owner (V2-002, docs/v2/02 §1), mirroring create-owner: no
 * API route can create a platform owner, the account gets a random temporary password shown once (hashed with the
 * server's argon2id + AUTH_SECRET_PEPPER) and no TOTP secret, so the first sign-in at /platform/login is a restricted
 * session that must change the password and then set up MFA. A second platform owner is refused (DEC-465): the
 * owner adds the other platform accounts from the console (platform.user_manage, a later ticket).
 */
export interface CreatePlatformOwnerInput {
  phone: string;
  fullName: string;
}

export interface CreatePlatformOwnerResult {
  userId: string;
  phoneE164: string;
  /** shown once to the operator, never stored or logged */
  temporaryPassword: string;
}

export type PlatformOwnerBootstrapRefusal =
  'owner_exists' | 'phone_invalid' | 'phone_in_use' | 'name_required';

export class PlatformOwnerBootstrapError extends Error {
  override name = 'PlatformOwnerBootstrapError';
  constructor(
    readonly reason: PlatformOwnerBootstrapRefusal,
    message: string,
  ) {
    super(message);
  }
}

export async function createPlatformOwner(
  db: Database,
  env: Env,
  input: CreatePlatformOwnerInput,
): Promise<CreatePlatformOwnerResult> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    throw new PlatformOwnerBootstrapError('phone_invalid', `not a valid phone number: ${input.phone}`);
  const fullName = input.fullName.trim();
  if (!fullName) throw new PlatformOwnerBootstrapError('name_required', '--name is required');
  // 16 random base64url characters, like the temporary staff passwords (DEC-78); hashed before the transaction
  const temporaryPassword = randomToken(12);
  const secretHash = await new SecretHasher(env.AUTH_SECRET_PEPPER).hash(temporaryPassword);

  return db.transaction(async (tx) => {
    // two installers at once: the second waits here, then sees the first owner
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('point.ops.create_platform_owner'))`);
    const owner = await tx.maybeOne(`SELECT 1 FROM platform_users WHERE role = 'platform_owner' LIMIT 1`);
    if (owner) {
      throw new PlatformOwnerBootstrapError(
        'owner_exists',
        'a platform owner already exists; other platform accounts are added from the platform console',
      );
    }
    if (await tx.maybeOne(`SELECT 1 FROM platform_users WHERE phone_e164 = $1`, [phone])) {
      throw new PlatformOwnerBootstrapError('phone_in_use', 'a platform account already has this phone');
    }
    const userId = newId();
    await tx.query(
      `INSERT INTO platform_users (id, phone_e164, full_name, role, status, secret_hash, must_change_secret, mfa_enabled,
                                   created_at, updated_at)
       VALUES ($1, $2, $3, 'platform_owner', 'active', $4, true, false, $5, $5)`,
      [userId, phone, fullName, secretHash, tx.now],
    );
    await platformAudit(tx, {
      actor: { type: 'system', id: null, name: 'ops.create_platform_owner' },
      action: 'platform.owner_bootstrap',
      entityType: 'platform_user',
      entityId: userId,
      metadata: { role: 'platform_owner', must_change_secret: true, mfa_setup_required: true },
    });
    return { userId, phoneE164: phone, temporaryPassword };
  });
}

export const CREATE_PLATFORM_OWNER_USAGE = `usage: node api/dist/cli.js create-platform-owner --phone <phone> --name <full name>
  Creates the first platform owner (POINT platform console, /platform). Refused when one exists.
  Prints a temporary password once: the first sign-in must change it and set up MFA.`;

/** `create-platform-owner` options (`--phone`, `--name`). */
export function parseCreatePlatformOwnerArgs(argv: string[]): CreatePlatformOwnerInput {
  const { values } = parseArgs({
    args: argv,
    options: { phone: { type: 'string' }, name: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.phone || !values.name) throw new Error('--phone and --name are required');
  return { phone: values.phone, fullName: values.name };
}
