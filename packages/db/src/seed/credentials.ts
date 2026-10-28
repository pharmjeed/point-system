// =====================================================================================
// DEVELOPMENT / TEST ONLY — plaintext credentials of the seeded accounts (PNT-010).
// They exist so tests and local developers can log in. The seed refuses to run when
// APP_ENV is production or staging or NODE_ENV is production, so these values can
// never become real credentials. Never reuse them anywhere else.
// =====================================================================================
import { SEED_USERS, type SeedRole } from './fixtures.js';
import type { SeedUserKey } from './ids.js';

export interface SeedCredential {
  /** Login identifier (`users.phone_e164`). */
  phone: string;
  role: SeedRole;
  secretKind: 'pin' | 'password';
  /** Plaintext PIN (drivers, 6 digits) or password (staff, ≥ 12 characters) — 09 §9.1. */
  secret: string;
  /** Base32 TOTP secret (RFC 6238, 160 bit) for accounts seeded with MFA enabled (OWN1, ADM1). */
  totpSecret?: string;
}

// PINs avoid the rejected patterns of 09 §9.1 (repeated digits, ascending/descending runs,
// the last 6 digits of the phone, the employee-code digits).
const SECRETS: Record<SeedUserKey, { secret: string; totpSecret?: string }> = {
  OWN1: { secret: 'point-dev-OWN1-2026', totpSecret: 'PMGZS6R3IBTNKTNUXEHT5ZEG4GP2BNUI' },
  ADM1: { secret: 'point-dev-ADM1-2026', totpSecret: 'RLULVMSMBBA3TE6MPJ2ECPAJ2OL2TJYX' },
  'SUP-R': { secret: 'point-dev-SUP-R-2026' },
  'SUP-RL': { secret: 'point-dev-SUP-RL-2026' },
  'SUP-RD': { secret: 'point-dev-SUP-RD-2026' },
  DRV1: { secret: '314159' },
  DRV2: { secret: '271828' },
  DRV3: { secret: '161803' },
  DRV4: { secret: '141421' },
  DRV5: { secret: '173205' },
  DRV6: { secret: '223606' },
  DRV7: { secret: '244949' },
  DRV8: { secret: '264575' },
};

function build(): Readonly<Record<SeedUserKey, SeedCredential>> {
  const out = {} as Record<SeedUserKey, SeedCredential>;
  for (const u of SEED_USERS) {
    const s = SECRETS[u.key];
    const cred: SeedCredential = {
      phone: u.phone,
      role: u.role,
      secretKind: u.role === 'driver' ? 'pin' : 'password',
      secret: s.secret,
    };
    if (u.mfaEnabled) {
      if (!s.totpSecret) throw new Error(`seed: ${u.key} has MFA enabled but no TOTP secret`);
      cred.totpSecret = s.totpSecret;
    }
    out[u.key] = Object.freeze(cred);
  }
  return Object.freeze(out);
}

/** DEV/TEST ONLY: plaintext login credentials of every seeded user, keyed like `SEED_IDS.users`. */
export const SEED_CREDENTIALS = build();
