import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_SECURITY } from '@point/shared';
import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Env } from '../../../core/config/env.js';
import {
  decrypt,
  encrypt,
  parseEncryptionKey,
  sha256Hex,
  type EncryptionKey,
} from '../../../core/crypto/crypto.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { maskPhone } from '../../../core/logging/redact.js';
import { normalizePhone } from '../../../core/phone.js';
import { ENV } from '../../../http/tokens.js';
import { assertNewSecret } from '../../identity-access/domain/secret-policy.js';
import { SecretHasher } from '../../identity-access/infra/secret-hasher.js';
import { newTotpSecret, totpUri, verifyTotp } from '../../identity-access/infra/totp.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import {
  issuePlatformMfaChallenge,
  issuePlatformSession,
  revokePlatformSessions,
  type IssuedPlatformSession,
} from './platform-sessions.js';
import { buildPlatformMe, type PlatformUserRow } from './platform-views.js';

const actorOf = (u: Pick<PlatformUserRow, 'id' | 'role'>) =>
  ({ type: 'platform_user', id: u.id, role: u.role }) as const;

/**
 * Platform sign-in (V2-002, docs/v2/02 §1: «MFA إلزامي»): phone + password, then TOTP on every sign-in. The first
 * sign-in of an account (temporary password from create-platform-owner) is a restricted session, exactly like the
 * staff owner's (DEC-82): change the password, then set up TOTP; nothing else is reachable before both. Same
 * hasher (argon2id + AUTH_SECRET_PEPPER), TOTP, encryption key, one message for an unknown phone and a wrong
 * password, lockout after PLATFORM_SECURITY.max_login_attempts. Every command writes platform_audit_log in its
 * transaction.
 */
@Injectable()
export class PlatformAuthService {
  readonly hasher: SecretHasher;
  private readonly keys: EncryptionKey[];

  constructor(@Inject(ENV) private readonly env: Env) {
    this.hasher = new SecretHasher(env.AUTH_SECRET_PEPPER);
    this.keys = [parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID)];
  }

  async login(tx: Tx, body: { phone: string; secret: string }, client: ClientInfo) {
    const phone = normalizePhone(body.phone);
    const user = phone
      ? await tx.maybeOne<PlatformUserRow>(
          `SELECT * FROM platform_users WHERE phone_e164 = $1 FOR NO KEY UPDATE`,
          [phone],
        )
      : null;
    if (!user) {
      await this.hasher.verifyDummy(body.secret);
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    this.assertNotLocked(user, tx.now);
    if (!(await this.hasher.verify(user.secret_hash, body.secret)))
      await this.registerFailure(tx, user, 'platform.auth.login_failed', client, 'AUTH_INVALID_CREDENTIALS');
    if (user.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
    await tx.query(
      `UPDATE platform_users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`,
      [user.id, tx.now],
    );

    if (user.mfa_enabled) {
      const mfaToken = await issuePlatformMfaChallenge(tx, user.id, client);
      await this.audit(tx, user, 'platform.auth.login', client, { step: 'password', mfa: 'challenge' });
      return {
        result: {
          mfa_required: true,
          mfa_token: mfaToken,
          mfa_setup_required: false,
          must_change_secret: user.must_change_secret,
          me: null,
        },
        session: null as IssuedPlatformSession | null,
      };
    }

    // first sign-in: a restricted session (mfa_verified = false) until the password change and the TOTP set-up
    const session = await issuePlatformSession(tx, user.id, { ...client, mfaVerified: false });
    await this.audit(tx, user, 'platform.auth.login', client, {
      step: 'password',
      mfa: 'setup_required',
      session_id: session.id,
    });
    return {
      result: {
        mfa_required: false,
        mfa_token: null,
        mfa_setup_required: true,
        must_change_secret: user.must_change_secret,
        me: await buildPlatformMe(tx, this.env, session.id, user.id),
      },
      session,
    };
  }

  async verifyMfa(tx: Tx, body: { mfa_token: string; code: string }, client: ClientInfo) {
    const challenge = await tx.maybeOne<{
      id: string;
      platform_user_id: string;
      kind: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, platform_user_id, kind, expires_at, revoked_at FROM platform_sessions WHERE token_hash = $1 FOR NO KEY UPDATE`,
      [sha256Hex(body.mfa_token)],
    );
    if (
      !challenge ||
      challenge.kind !== 'mfa_challenge' ||
      challenge.revoked_at ||
      challenge.expires_at.getTime() <= tx.now.getTime()
    ) {
      throw new AppError('AUTH_MFA_REQUIRED');
    }
    const user = await tx.one<PlatformUserRow>(
      `SELECT * FROM platform_users WHERE id = $1 FOR NO KEY UPDATE`,
      [challenge.platform_user_id],
    );
    if (!user.mfa_enabled || !user.mfa_secret_enc) throw new AppError('AUTH_MFA_REQUIRED');
    this.assertNotLocked(user, tx.now);
    const check = await verifyTotp({
      secret: decrypt(user.mfa_secret_enc, this.keys),
      token: body.code,
      now: tx.now,
      lastStep: user.mfa_last_step,
    });
    if (!check.valid)
      await this.registerFailure(tx, user, 'platform.auth.mfa_failed', client, 'AUTH_MFA_INVALID');
    if (user.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
    if (!check.valid) throw new AppError('AUTH_MFA_INVALID'); // unreachable: registerFailure throws
    await tx.query(
      `UPDATE platform_sessions SET revoked_at = $2, revoked_reason = 'consumed' WHERE id = $1`,
      [challenge.id, tx.now],
    );
    await tx.query(
      `UPDATE platform_users SET mfa_last_step = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [user.id, check.step],
    );
    const session = await issuePlatformSession(tx, user.id, { ...client, mfaVerified: true });
    await this.audit(tx, user, 'platform.auth.login', client, { step: 'mfa', session_id: session.id });
    return { me: await buildPlatformMe(tx, this.env, session.id, user.id), session };
  }

  async logout(tx: Tx, actor: PlatformActorContext, client: ClientInfo): Promise<void> {
    await revokePlatformSessions(tx, actor.userId, 'logout', { onlySessionId: actor.sessionId });
    await this.audit(tx, { id: actor.userId, role: actor.role }, 'platform.auth.logout', client, {
      session_id: actor.sessionId,
    });
  }

  /** New password → must_change_secret=false, every session revoked (secret_reset), a fresh one issued. */
  async changeSecret(
    tx: Tx,
    actor: PlatformActorContext,
    body: { current_secret: string; new_secret: string },
    client: ClientInfo,
  ) {
    const user = await this.lockUser(tx, actor.userId);
    if (!(await this.hasher.verify(user.secret_hash, body.current_secret)))
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    assertNewSecret('password', body.new_secret, { phoneE164: user.phone_e164 });
    if (await this.hasher.verify(user.secret_hash, body.new_secret)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'new_secret', issue: 'same_as_current' }],
      });
    }
    await tx.query(
      `UPDATE platform_users SET secret_hash = $2, must_change_secret = false, version = version + 1 WHERE id = $1`,
      [user.id, await this.hasher.hash(body.new_secret)],
    );
    await revokePlatformSessions(tx, user.id, 'secret_reset');
    const session = await issuePlatformSession(tx, user.id, { ...client, mfaVerified: actor.mfaVerified });
    await this.audit(tx, user, 'platform.auth.secret_change', client, { session_id: session.id });
    return { me: await buildPlatformMe(tx, this.env, session.id, user.id), session };
  }

  async mfaSetup(tx: Tx, actor: PlatformActorContext, client: ClientInfo) {
    const user = await this.lockUser(tx, actor.userId);
    if (user.mfa_enabled)
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'platform_user',
        entity_id: user.id,
        reason: 'mfa_already_enabled',
      });
    const secret = newTotpSecret();
    await tx.query(`UPDATE platform_users SET mfa_secret_enc = $2, mfa_last_step = NULL WHERE id = $1`, [
      user.id,
      encrypt(secret, this.keys[0]!),
    ]);
    await this.audit(tx, user, 'platform.auth.mfa_setup', client);
    return {
      otpauth_uri: totpUri({
        issuer: `${this.env.BRAND_STAFF_NAME_EN} Platform`,
        label: maskPhone(user.phone_e164) ?? user.id,
        secret,
      }),
      secret_base32: secret,
    };
  }

  async mfaConfirm(tx: Tx, actor: PlatformActorContext, body: { code: string }, client: ClientInfo) {
    const user = await this.lockUser(tx, actor.userId);
    if (user.mfa_enabled || !user.mfa_secret_enc) {
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'platform_user',
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
      throw new AppError('AUTH_MFA_INVALID', {
        attempts_left: Math.max(PLATFORM_SECURITY.max_login_attempts - user.failed_login_count, 0),
      });
    }
    await tx.query(
      `UPDATE platform_users SET mfa_enabled = true, mfa_last_step = $2, version = version + 1 WHERE id = $1`,
      [user.id, check.step],
    );
    await tx.query(`UPDATE platform_sessions SET mfa_verified = true WHERE id = $1`, [actor.sessionId]);
    await this.audit(tx, user, 'platform.auth.mfa_confirm', client, { session_id: actor.sessionId });
    return buildPlatformMe(tx, this.env, actor.sessionId, user.id);
  }

  private lockUser(tx: Tx, id: string): Promise<PlatformUserRow> {
    return tx.one<PlatformUserRow>(`SELECT * FROM platform_users WHERE id = $1 FOR NO KEY UPDATE`, [id]);
  }

  private assertNotLocked(user: PlatformUserRow, now: Date) {
    if (user.locked_until && user.locked_until.getTime() > now.getTime()) {
      throw new AppError('AUTH_ACCOUNT_LOCKED', { locked_until: user.locked_until.toISOString() });
    }
  }

  private audit(
    tx: Tx,
    user: Pick<PlatformUserRow, 'id' | 'role'>,
    action: string,
    client: ClientInfo,
    metadata: Record<string, unknown> = {},
  ) {
    return platformAudit(tx, {
      actor: actorOf(user),
      action,
      entityType: 'platform_user',
      entityId: user.id,
      requestId: client.requestId,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata,
    });
  }

  /**
   * Counts a failed password/TOTP attempt and commits it with the error (keepEffects, 08 §1.3 rule 6b). The
   * PLATFORM_SECURITY.max_login_attempts-th failure locks the account for lock_minutes (AUTH_ACCOUNT_LOCKED).
   */
  private async registerFailure(
    tx: Tx,
    user: PlatformUserRow,
    action: string,
    client: ClientInfo,
    code: 'AUTH_INVALID_CREDENTIALS' | 'AUTH_MFA_INVALID',
  ): Promise<never> {
    const max = PLATFORM_SECURITY.max_login_attempts;
    const count = user.failed_login_count + 1;
    const lock = count >= max;
    const lockedUntil = lock ? new Date(tx.now.getTime() + PLATFORM_SECURITY.lock_minutes * 60_000) : null;
    await tx.query(`UPDATE platform_users SET failed_login_count = $2, locked_until = $3 WHERE id = $1`, [
      user.id,
      lock ? 0 : count,
      lockedUntil,
    ]);
    await this.audit(tx, user, action, client, { failed_count: count, locked: lock });
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
}
