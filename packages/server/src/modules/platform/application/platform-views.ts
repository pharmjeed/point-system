import type { PlatformRole } from '@point/shared';
import { effectivePlatformPermissions, platformPending } from '../../../core/actor-context/platform-actor.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { maskPhone } from '../../../core/logging/redact.js';

type Q = Pick<Tx, 'query'> | Pick<Database, 'query'>;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

export interface PlatformUserRow {
  id: string;
  phone_e164: string;
  full_name: string;
  role: PlatformRole;
  status: 'active' | 'disabled';
  secret_hash: string;
  must_change_secret: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_last_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  version: number;
}

/** PlatformUser (07_openapi.yaml): the full phone only for its owner (this view is the account's own). */
export function platformUserView(u: PlatformUserRow) {
  return {
    id: u.id,
    full_name: u.full_name,
    phone_e164: u.phone_e164,
    phone_masked: maskPhone(u.phone_e164),
    role: u.role,
    status: u.status,
    mfa_enabled: u.mfa_enabled,
    must_change_secret: u.must_change_secret,
    last_login_at: iso(u.last_login_at),
  };
}

/** PlatformMe (07_openapi.yaml): the account, the platform permissions it holds now, and the session. */
export async function buildPlatformMe(q: Q, env: Env, sessionId: string, userId: string) {
  // sequential: `q` may be a transaction client
  const u = (await q.query<PlatformUserRow>(`SELECT * FROM platform_users WHERE id = $1`, [userId])).rows[0]!;
  const s = (
    await q.query<{ expires_at: Date; mfa_verified: boolean }>(
      `SELECT expires_at, mfa_verified FROM platform_sessions WHERE id = $1`,
      [sessionId],
    )
  ).rows[0];
  const state = {
    role: u.role,
    mustChangeSecret: u.must_change_secret,
    mfaVerified: s?.mfa_verified ?? false,
  };
  const pending = platformPending(state);
  return {
    user: platformUserView(u),
    permissions: effectivePlatformPermissions(state),
    session: {
      expires_at: iso(s?.expires_at),
      mfa_verified: state.mfaVerified,
      restricted: pending.length > 0,
      pending,
    },
    brand: { staff_name_ar: env.BRAND_STAFF_NAME_AR, staff_name_en: env.BRAND_STAFF_NAME_EN },
  };
}
