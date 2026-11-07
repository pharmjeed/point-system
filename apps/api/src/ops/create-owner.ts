import { parseArgs } from 'node:util';
import {
  SecretHasher,
  audit,
  insertFirstOwner,
  newId,
  newOwnerTemporaryPassword,
  normalizePhone,
  type Database,
  type Env,
} from '@point/server';

/**
 * The installation tool that creates the first owner (09 §2: «أداة التهيئة عند التثبيت فقط، لا عبر الـAPI»,
 * 09 §10 rule 4). No API route can create an owner. The account gets a random temporary password shown once
 * (09 §9.1, `must_change_secret = true`) hashed with the server's argon2id + AUTH_SECRET_PEPPER (DEC-58), and no
 * TOTP secret: MFA is mandatory for owners, so the first sign-in is a restricted session that must change the
 * password and then set up MFA (07 §1.2, DEC-82) before anything else.
 */
export interface CreateOwnerInput {
  phone: string;
  fullName: string;
  /** used when the database holds no organization yet */
  orgNameAr?: string;
  orgNameEn?: string;
  /** required when the database holds more than one organization */
  orgId?: string;
}

export interface CreateOwnerResult {
  orgId: string;
  orgCreated: boolean;
  userId: string;
  employeeCode: string;
  phoneE164: string;
  /** shown once to the operator, never stored or logged */
  temporaryPassword: string;
}

export type OwnerBootstrapRefusal =
  | 'owner_exists'
  | 'org_name_required'
  | 'org_ambiguous'
  | 'org_not_found'
  | 'phone_invalid'
  | 'phone_in_use'
  | 'name_required';

export class OwnerBootstrapError extends Error {
  override name = 'OwnerBootstrapError';
  constructor(
    readonly reason: OwnerBootstrapRefusal,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createOwner(
  db: Database,
  env: Env,
  input: CreateOwnerInput,
): Promise<CreateOwnerResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new OwnerBootstrapError('phone_invalid', `not a valid phone number: ${input.phone}`);
  const fullName = input.fullName.trim();
  if (!fullName) throw new OwnerBootstrapError('name_required', '--name is required');
  if (input.orgId && !UUID.test(input.orgId)) {
    throw new OwnerBootstrapError('org_not_found', `--org-id is not a uuid: ${input.orgId}`);
  }
  // 16 random base64url characters, like the temporary staff passwords (DEC-78); hashed before the transaction
  const temporaryPassword = newOwnerTemporaryPassword();
  const secretHash = await new SecretHasher(env.AUTH_SECRET_PEPPER).hash(temporaryPassword);

  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('point.ops.create_owner'))`);
    const orgs = (await tx.query<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at, id`))
      .rows;
    let orgId: string;
    let orgCreated = false;
    if (input.orgId) {
      if (!orgs.some((o) => o.id === input.orgId)) {
        throw new OwnerBootstrapError('org_not_found', `no organization ${input.orgId}`);
      }
      orgId = input.orgId;
    } else if (orgs.length === 1) {
      orgId = orgs[0]!.id;
    } else if (orgs.length > 1) {
      throw new OwnerBootstrapError('org_ambiguous', 'several organizations exist: pass --org-id');
    } else {
      const nameAr = input.orgNameAr?.trim();
      if (!nameAr) {
        throw new OwnerBootstrapError('org_name_required', 'no organization yet: pass --org-name-ar');
      }
      orgId = newId();
      await tx.query(
        `INSERT INTO organizations (id, name_ar, name_en, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
        [orgId, nameAr, input.orgNameEn?.trim() || null, tx.now],
      );
      orgCreated = true;
    }
    const r = await insertFirstOwner(tx, {
      orgId,
      phoneE164: phone,
      fullName,
      secretHash,
      phoneScope: 'org',
    });
    if (!r.ok && r.reason === 'owner_exists') {
      throw new OwnerBootstrapError(
        'owner_exists',
        'this organization already has an owner; owner recovery is an audited out-of-band procedure (09 §9.1)',
      );
    }
    if (!r.ok)
      throw new OwnerBootstrapError('phone_in_use', 'a user of this organization already has this phone');
    const { userId, employeeCode } = r;
    await audit(tx, {
      orgId,
      actor: { type: 'system', id: 'ops.create_owner' },
      action: 'owner.bootstrap',
      entityType: 'user',
      entityId: userId,
      after: {
        command: 'create',
        role: 'owner',
        employee_code: employeeCode,
        organization_created: orgCreated,
        must_change_secret: true,
        mfa_setup_required: true,
      },
    });
    return { orgId, orgCreated, userId, employeeCode, phoneE164: phone, temporaryPassword };
  });
}

export const CREATE_OWNER_USAGE = `usage: node api/dist/cli.js create-owner --phone <phone> --name <full name>
                                   [--org-name-ar <name> [--org-name-en <name>]] [--org-id <uuid>]
  Creates the first owner of the organization (the only way to create an owner, 09 §2).
  --org-name-ar is required when the database has no organization yet; --org-id when it has several.
  Prints a temporary password once: the first sign-in must change it and set up MFA.`;

/** `create-owner` options (`--phone`, `--name`, `--org-name-ar`, `--org-name-en`, `--org-id`). */
export function parseCreateOwnerArgs(argv: string[]): CreateOwnerInput {
  const { values } = parseArgs({
    args: argv,
    options: {
      phone: { type: 'string' },
      name: { type: 'string' },
      'org-name-ar': { type: 'string' },
      'org-name-en': { type: 'string' },
      'org-id': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.phone || !values.name) throw new Error('--phone and --name are required');
  return {
    phone: values.phone,
    fullName: values.name,
    ...(values['org-name-ar'] ? { orgNameAr: values['org-name-ar'] } : {}),
    ...(values['org-name-en'] ? { orgNameEn: values['org-name-en'] } : {}),
    ...(values['org-id'] ? { orgId: values['org-id'] } : {}),
  };
}
