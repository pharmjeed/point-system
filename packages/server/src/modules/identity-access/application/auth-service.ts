import { Inject, Injectable } from '@nestjs/common';
import { parseOrgSettings } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { mfaRequiredFor } from '../../../core/actor-context/actor-loader.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import {
  decrypt,
  encrypt,
  parseEncryptionKey,
  randomToken,
  sha256Hex,
  type EncryptionKey,
} from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { normalizePhone } from '../../../core/phone.js';
import { ENV } from '../../../http/tokens.js';
import { assertNewSecret } from '../domain/secret-policy.js';
import { SecretHasher } from '../infra/secret-hasher.js';
import { newTotpSecret, totpUri, verifyTotp } from '../infra/totp.js';
import { issueSession, platformFromUserAgent, revokeSessions, type IssuedSession } from './sessions.js';
import { buildMe, type UserRow } from './views.js';

export interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
  requestId: string;
}

const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const LOCK_MS = 15 * 60_000;

/**
 * Login, MFA, secret change and logout (PNT-011, PNT-012; 07 §1.2, 09 §9). One message for an unknown phone
 * and a wrong secret; the disabled state is revealed only after valid credentials (08 §4.1).
 */
@Injectable()
export class AuthService {
  readonly hasher: SecretHasher;
  private readonly keys: EncryptionKey[];

  constructor(@Inject(ENV) private readonly env: Env) {
    this.hasher = new SecretHasher(env.AUTH_SECRET_PEPPER);
    this.keys = [parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID)];
  }

  async login(tx: Tx, body: { phone: string; secret: string; device_label?: string }, client: ClientInfo) {
    const phone = normalizePhone(body.phone);
    const user = phone
      ? await tx.maybeOne<UserRow>(
          `SELECT * FROM users WHERE phone_e164 = $1 ORDER BY created_at LIMIT 1 FOR NO KEY UPDATE`,
          [phone],
        )
      : null;
    if (!user) {
      await this.hasher.verifyDummy(body.secret);
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    tx.locks.record('users', [user.id]);
    this.assertNotLocked(user, tx.now);
    const ok = await this.hasher.verify(user.secret_hash, body.secret);
    if (!ok) await this.registerFailure(tx, user, 'auth.login_failed', client, 'AUTH_INVALID_CREDENTIALS');
    if (user.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');

    await tx.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`,
      [user.id, tx.now],
    );
    const org = await tx.one<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [
      user.org_id,
    ]);
    const mfaRequired = mfaRequiredFor(user.role, org.settings);
    const deviceId = await this.registerLoginDevice(tx, user, body.device_label ?? null, client);

    if (user.mfa_enabled) {
      // MFA challenge: a non-session row in auth_sessions (mfa_verified = false, 5 minutes, single use; DEC-75)
      const mfaToken = randomToken(32);
      await tx.query(
        `INSERT INTO auth_sessions (org_id, user_id, device_id, token_hash, mfa_verified, ip, user_agent, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7, $7, $8)`,
        [
          user.org_id,
          user.id,
          deviceId,
          sha256Hex(mfaToken),
          client.ip ?? null,
          client.userAgent?.slice(0, 512) ?? null,
          tx.now,
          new Date(tx.now.getTime() + MFA_CHALLENGE_TTL_MS),
        ],
      );
      await audit(tx, {
        orgId: user.org_id,
        actor: { type: 'user', id: user.id, role: user.role },
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        requestId: client.requestId,
        ip: client.ip,
        userAgent: client.userAgent,
        metadata: { step: 'password', mfa: 'challenge' },
      });
      return {
        result: {
          mfa_required: true,
          mfa_token: mfaToken,
          mfa_setup_required: false,
          must_change_secret: user.must_change_secret,
          me: null,
        },
        session: null as IssuedSession | null,
      };
    }

    const session = await issueSession(tx, user, {
      mfaVerified: false,
      ip: client.ip,
      userAgent: client.userAgent,
      deviceId,
    });
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { session_id: session.id },
    });
    const me = await buildMe(tx, this.env, session.id, user.id);
    return {
      result: {
        mfa_required: false,
        mfa_token: null,
        mfa_setup_required: mfaRequired && !user.mfa_enabled,
        must_change_secret: user.must_change_secret,
        me,
      },
      session,
    };
  }

  async verifyMfa(tx: Tx, body: { mfa_token: string; code: string }, client: ClientInfo) {
    const challenge = await tx.maybeOne<{
      id: string;
      user_id: string;
      device_id: string | null;
      expires_at: Date;
      revoked_at: Date | null;
      mfa_verified: boolean;
    }>(
      `SELECT id, user_id, device_id, expires_at, revoked_at, mfa_verified FROM auth_sessions WHERE token_hash = $1`,
      [sha256Hex(body.mfa_token)],
    );
    if (
      !challenge ||
      challenge.mfa_verified ||
      challenge.revoked_at ||
      challenge.expires_at.getTime() <= tx.now.getTime()
    ) {
      throw new AppError('AUTH_MFA_REQUIRED');
    }
    const user = await tx.one<UserRow>(`SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE`, [
      challenge.user_id,
    ]);
    if (!user.mfa_enabled || !user.mfa_secret_enc) throw new AppError('AUTH_MFA_REQUIRED');
    this.assertNotLocked(user, tx.now);
    const check = await verifyTotp({
      secret: decrypt(user.mfa_secret_enc, this.keys),
      token: body.code,
      now: tx.now,
      lastStep: user.mfa_last_step,
    });
    if (!check.valid) await this.registerFailure(tx, user, 'auth.mfa_failed', client, 'AUTH_MFA_INVALID');
    if (user.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
    if (!check.valid) throw new AppError('AUTH_MFA_INVALID'); // unreachable: registerFailure throws
    // consume the challenge (revoked, no reason) and issue the real session
    await tx.query(`UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1`, [challenge.id, tx.now]);
    await tx.query(
      `UPDATE users SET mfa_last_step = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [user.id, check.step],
    );
    const session = await issueSession(tx, user, {
      mfaVerified: true,
      ip: client.ip,
      userAgent: client.userAgent,
      deviceId: challenge.device_id,
    });
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { step: 'mfa', session_id: session.id },
    });
    return { me: await buildMe(tx, this.env, session.id, user.id), session };
  }

  async logout(tx: Tx, actor: ActorContext, client: ClientInfo): Promise<void> {
    await revokeSessions(tx, actor.userId, 'logout', { onlySessionId: actor.sessionId });
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'auth.logout',
      entityType: 'user',
      entityId: actor.userId,
      requestId: client.requestId,
      ip: client.ip,
    });
  }

  /** New secret → must_change_secret=false, every session revoked (secret_reset), a fresh session issued. */
  async changeSecret(
    tx: Tx,
    actor: ActorContext,
    body: { current_secret: string; new_secret: string },
    client: ClientInfo,
  ) {
    const user = await tx.one<UserRow>(`SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE`, [actor.userId]);
    tx.locks.record('users', [user.id]);
    if (!(await this.hasher.verify(user.secret_hash, body.current_secret))) {
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    assertNewSecret(user.secret_kind, body.new_secret, {
      phoneE164: user.phone_e164,
      employeeCode: user.employee_code,
    });
    if (await this.hasher.verify(user.secret_hash, body.new_secret)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'new_secret', issue: 'same_as_current' }],
      });
    }
    const hash = await this.hasher.hash(body.new_secret);
    await tx.query(
      `UPDATE users SET secret_hash = $2, must_change_secret = false, version = version + 1 WHERE id = $1`,
      [user.id, hash],
    );
    const current = await tx.one<{ mfa_verified: boolean; device_id: string | null }>(
      `SELECT mfa_verified, device_id FROM auth_sessions WHERE id = $1`,
      [actor.sessionId],
    );
    await revokeSessions(tx, user.id, 'secret_reset');
    const session = await issueSession(tx, user, {
      mfaVerified: current.mfa_verified,
      ip: client.ip,
      userAgent: client.userAgent,
      deviceId: current.device_id,
    });
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action: 'auth.self',
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      ip: client.ip,
      metadata: { command: 'secret_change', secret_kind: user.secret_kind },
    });
    return { me: await buildMe(tx, this.env, session.id, user.id), session };
  }

  async mfaSetup(tx: Tx, actor: ActorContext, client: ClientInfo) {
    const user = await tx.one<UserRow>(`SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE`, [actor.userId]);
    if (user.mfa_enabled)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: user.id,
        reason: 'mfa_already_enabled',
      });
    if (user.role === 'driver')
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: user.id,
        reason: 'mfa_not_for_drivers',
      });
    const secret = newTotpSecret();
    await tx.query(`UPDATE users SET mfa_secret_enc = $2, mfa_last_step = NULL WHERE id = $1`, [
      user.id,
      encrypt(secret, this.keys[0]!),
    ]);
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action: 'auth.self',
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      metadata: { command: 'mfa_setup' },
    });
    return {
      otpauth_uri: totpUri({ issuer: this.env.BRAND_STAFF_NAME_EN, label: user.employee_code, secret }),
      secret_base32: secret,
    };
  }

  async mfaConfirm(tx: Tx, actor: ActorContext, body: { code: string }, client: ClientInfo) {
    const user = await tx.one<UserRow>(`SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE`, [actor.userId]);
    if (user.mfa_enabled || !user.mfa_secret_enc) {
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'user',
        entity_id: user.id,
        reason: user.mfa_enabled ? 'mfa_already_enabled' : 'mfa_setup_not_started',
      });
    }
    const check = await verifyTotp({
      secret: decrypt(user.mfa_secret_enc, this.keys),
      token: body.code,
      now: tx.now,
      lastStep: user.mfa_last_step,
    });
    if (!check.valid) {
      const org = await tx.one<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [
        user.org_id,
      ]);
      const max = parseOrgSettings(org.settings ?? {}).security.max_login_attempts;
      throw new AppError('AUTH_MFA_INVALID', { attempts_left: Math.max(max - user.failed_login_count, 0) });
    }
    await tx.query(
      `UPDATE users SET mfa_enabled = true, mfa_last_step = $2, version = version + 1 WHERE id = $1`,
      [user.id, check.step],
    );
    await tx.query(`UPDATE auth_sessions SET mfa_verified = true WHERE id = $1`, [actor.sessionId]);
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action: 'auth.self',
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      metadata: { command: 'mfa_confirm' },
    });
    return buildMe(tx, this.env, actor.sessionId, user.id);
  }

  private assertNotLocked(user: UserRow, now: Date) {
    if (user.locked_until && user.locked_until.getTime() > now.getTime()) {
      throw new AppError('AUTH_ACCOUNT_LOCKED', { locked_until: user.locked_until.toISOString() });
    }
  }

  /**
   * Counts a failed secret/MFA attempt and commits it with the error (keepEffects, 08 §1.3 rule 6b). The
   * `security.max_login_attempts`-th failure locks the account for 15 minutes and answers AUTH_ACCOUNT_LOCKED.
   */
  private async registerFailure(
    tx: Tx,
    user: UserRow,
    action: string,
    client: ClientInfo,
    code: 'AUTH_INVALID_CREDENTIALS' | 'AUTH_MFA_INVALID',
  ): Promise<never> {
    const org = await tx.one<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [
      user.org_id,
    ]);
    const max = parseOrgSettings(org.settings ?? {}).security.max_login_attempts;
    const count = user.failed_login_count + 1;
    const lock = count >= max;
    const lockedUntil = lock ? new Date(tx.now.getTime() + LOCK_MS) : null;
    await tx.query(`UPDATE users SET failed_login_count = $2, locked_until = $3 WHERE id = $1`, [
      user.id,
      lock ? 0 : count,
      lockedUntil,
    ]);
    await audit(tx, {
      orgId: user.org_id,
      actor: { type: 'user', id: user.id, role: user.role },
      action,
      entityType: 'user',
      entityId: user.id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: { failed_count: count, locked: lock },
    });
    if (lock)
      throw new AppError(
        'AUTH_ACCOUNT_LOCKED',
        { locked_until: lockedUntil!.toISOString() },
        { keepEffects: true },
      );
    throw new AppError(code, code === 'AUTH_MFA_INVALID' ? { attempts_left: max - count } : {}, {
      keepEffects: true,
    });
  }

  private async registerLoginDevice(
    tx: Tx,
    user: UserRow,
    label: string | null,
    client: ClientInfo,
  ): Promise<string> {
    // 09 §9.5: every sign-in links a devices row (platform, display mode, permission, audio test, push)
    const r = await tx.one<{ id: string }>(
      `INSERT INTO devices (org_id, user_id, label, user_agent, platform, last_seen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      [
        user.org_id,
        user.id,
        label,
        client.userAgent?.slice(0, 512) ?? null,
        platformFromUserAgent(client.userAgent),
        tx.now,
      ],
    );
    return r.id;
  }
}
