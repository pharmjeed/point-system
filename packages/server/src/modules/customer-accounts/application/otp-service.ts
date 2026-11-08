import {
  CUSTOMER_OTP_LENGTH,
  CUSTOMER_OTP_LOCK_MINUTES,
  CUSTOMER_OTP_MAX_ATTEMPTS,
  CUSTOMER_OTP_RESEND_AFTER_S,
  CUSTOMER_OTP_TTL_S,
  CUSTOMER_REAUTH_TTL_S,
  maskPhone,
  type CustomerAuthResult,
  type CustomerDevicePlatform,
  type CustomerLocale,
  type CustomerOtpChallenge,
  type CustomerReauth,
} from '@point/shared/customer';
import { customerTokenHash, newCustomerToken } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Env } from '../../../core/config/env.js';
import {
  encrypt,
  hmacHex,
  parseEncryptionKey,
  randomDigits,
  safeEqual,
} from '../../../core/crypto/crypto.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { lockCustomerAccount } from './account-service.js';
import { buildCustomerMe, consentTexts, type CustomerAccountRow } from './account-views.js';
import { issueCustomerSession } from './customer-sessions.js';

/** The worker job that sends the code after COMMIT (canon §7.2 V2 row, DEC-496). */
export const CUSTOMER_OTP_SEND_JOB = 'job.customer_otp_send';

/** Attempts left on an open code carry over to the next code of the number within this window (DEC-496). */
export const CUSTOMER_OTP_ATTEMPT_CARRY_HOURS = 24;

const HOUR_MS = 3_600_000;

interface ChallengeRow {
  id: string;
  phone_e164: string;
  code_hash: string;
  attempts_left: number;
  expires_at: Date;
  resend_available_at: Date;
  created_at: Date;
}

/** HMAC of a code bound to its challenge (the claim-code pattern, DEC-15): never the code itself. */
export function otpCodeHash(pepper: string, challengeId: string, code: string): string {
  return hmacHex(pepper, `customer_otp:${challengeId}:${code}`);
}

const iso = (d: Date) => d.toISOString();

/**
 * Customer sign-in codes over WhatsApp only (V2-D11 as amended by DEC-460; DEC-482, DEC-496). Every command
 * serializes on the number (an advisory transaction lock on `customer_otp:<phone>`), so a resend, a verify and a
 * lock never race. The code request writes the challenge and the outbox row in one transaction; the worker sends
 * (`job.customer_otp_send`) — no network call here (canon rule 3).
 */
export class CustomerOtpService {
  private readonly key;
  constructor(private readonly env: Env) {
    this.key = parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID);
  }

  private async lockPhone(tx: Tx, phone: string) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`customer_otp:${phone}`]);
  }

  /** CUSTOMER_OTP_LOCKED while the number is locked (it refuses the request and the verify alike). */
  private async assertNotLocked(tx: Tx, phone: string) {
    const lock = await tx.maybeOne<{ locked_until: Date }>(
      `SELECT max(locked_until) AS locked_until FROM customer_otp_challenges
        WHERE phone_e164 = $1 AND status = 'locked' AND locked_until > $2 HAVING max(locked_until) IS NOT NULL`,
      [phone, tx.now],
    );
    if (lock) throw new AppError('CUSTOMER_OTP_LOCKED', { locked_until: iso(lock.locked_until) });
  }

  private async openChallenge(tx: Tx, phone: string): Promise<ChallengeRow | null> {
    return tx.maybeOne<ChallengeRow>(
      `SELECT id, phone_e164, code_hash, attempts_left, expires_at, resend_available_at, created_at
         FROM customer_otp_challenges WHERE phone_e164 = $1 AND status = 'open'`,
      [phone],
    );
  }

  /** RATE_LIMITED with `retry_after_s` when `count` codes were issued in the hour; the wait ends with the oldest. */
  private async assertHourly(tx: Tx, column: 'phone_e164' | 'device_id', value: string, limit: number) {
    if (limit <= 0) return;
    const r = await tx.one<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM customer_otp_challenges
        WHERE ${column} = $1 AND created_at > $2::timestamptz - interval '1 hour'`,
      [value, tx.now],
    );
    if (r.n >= limit && r.oldest) {
      const retry = Math.max(1, Math.ceil((r.oldest.getTime() + HOUR_MS - tx.now.getTime()) / 1000));
      throw new AppError(
        'RATE_LIMITED',
        { retry_after_s: retry, scope: column === 'phone_e164' ? 'phone' : 'device' },
        {
          retryAfterS: retry,
        },
      );
    }
  }

  async request(
    tx: Tx,
    body: { phone_e164: string; device_id: string; platform: CustomerDevicePlatform; locale: CustomerLocale },
    channel: { id: string; orgId: string } | null,
    client: ClientInfo,
  ): Promise<CustomerOtpChallenge> {
    const phone = body.phone_e164;
    await this.lockPhone(tx, phone);
    await this.assertNotLocked(tx, phone);
    const open = await this.openChallenge(tx, phone);
    if (open && open.resend_available_at.getTime() > tx.now.getTime()) {
      const retry = Math.ceil((open.resend_available_at.getTime() - tx.now.getTime()) / 1000);
      throw new AppError('RATE_LIMITED', { retry_after_s: retry, scope: 'resend' }, { retryAfterS: retry });
    }
    await this.assertHourly(tx, 'phone_e164', phone, this.env.CUSTOMER_OTP_PER_PHONE_PER_HOUR);
    await this.assertHourly(tx, 'device_id', body.device_id, this.env.CUSTOMER_OTP_PER_DEVICE_PER_HOUR);
    // WhatsApp is the only channel (DEC-460): without the Point number there is no way to deliver the code
    if (!channel) throw new AppError('WA_CHANNEL_UNAVAILABLE', { reason: 'no_channel' }, { retryAfterS: 30 });

    // a new code keeps the attempts already used on the number (C-03), within the carry window
    const carried =
      open && tx.now.getTime() - open.created_at.getTime() < CUSTOMER_OTP_ATTEMPT_CARRY_HOURS * HOUR_MS
        ? open.attempts_left
        : CUSTOMER_OTP_MAX_ATTEMPTS;
    if (open)
      await tx.query(
        `UPDATE customer_otp_challenges SET status = 'superseded', closed_at = $2, code_ciphertext = NULL,
                delivery_status = CASE WHEN delivery_status = 'queued' THEN 'skipped' ELSE delivery_status END
          WHERE id = $1`,
        [open.id, tx.now],
      );
    const id = newId();
    const code = randomDigits(CUSTOMER_OTP_LENGTH);
    const expiresAt = new Date(tx.now.getTime() + CUSTOMER_OTP_TTL_S * 1000);
    const resendAt = new Date(tx.now.getTime() + CUSTOMER_OTP_RESEND_AFTER_S * 1000);
    await tx.query(
      `INSERT INTO customer_otp_challenges (id, phone_e164, device_id, platform, locale, code_hash, code_ciphertext,
              attempts_left, expires_at, resend_available_at, wa_channel_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        phone,
        body.device_id,
        body.platform,
        body.locale,
        otpCodeHash(this.env.CODE_PEPPER, id, code),
        encrypt(code, this.key),
        carried,
        expiresAt,
        resendAt,
        channel.id,
        tx.now,
      ],
    );
    // the payload names the challenge only: never the phone or the code (PNT-007 AC6, DEC-38)
    await enqueue(tx, {
      type: CUSTOMER_OTP_SEND_JOB,
      orgId: channel.orgId,
      aggregate: { type: 'customer_otp_challenge', id },
      payload: { challenge_id: id, channel_id: channel.id },
      maxAttempts: 5,
    });
    await customerAudit(tx, {
      actor: { type: 'anonymous' },
      action: 'customer.auth.otp_requested',
      entityType: 'customer_otp_challenge',
      entityId: id,
      requestId: client.requestId,
      ip: client.ip ?? null,
      userAgent: client.userAgent ?? null,
      metadata: {
        phone_masked: maskPhone(phone),
        platform: body.platform,
        resend: !!open,
        attempts_left: carried,
      },
    });
    return {
      channel: 'whatsapp',
      phone_masked: maskPhone(phone),
      expires_at: iso(expiresAt),
      resend_available_at: iso(resendAt),
      attempts_left: carried,
    };
  }

  /**
   * The code check of the sign-in verify, shared by the re-verification of C-20 (DEC-507): serialized on the
   * number, refused while it is locked, CUSTOMER_OTP_EXPIRED without a live code, a wrong code costs an attempt
   * (the fifth locks the number 15 minutes) and commits although the request is refused (`keepEffects`); the right
   * code is consumed. `accountId` names the caller of a re-verification in the audit rows.
   */
  private async consumeCode(
    tx: Tx,
    phone: string,
    code: string,
    client: ClientInfo,
    accountId: string | null,
  ): Promise<{ id: string; audit: (action: string, accountId: string | null, m: object) => Promise<void> }> {
    await this.lockPhone(tx, phone);
    await this.assertNotLocked(tx, phone);
    const ch = await this.openChallenge(tx, phone);
    if (!ch || ch.expires_at.getTime() <= tx.now.getTime()) throw new AppError('CUSTOMER_OTP_EXPIRED');
    const audit = async (action: string, who: string | null, metadata: object) => {
      await customerAudit(tx, {
        actor: who ? { type: 'customer', accountId: who } : { type: 'anonymous' },
        action,
        entityType: 'customer_otp_challenge',
        entityId: ch.id,
        requestId: client.requestId,
        ip: client.ip ?? null,
        userAgent: client.userAgent ?? null,
        metadata: { phone_masked: maskPhone(phone), ...metadata },
      });
    };
    if (!safeEqual(otpCodeHash(this.env.CODE_PEPPER, ch.id, code), ch.code_hash)) {
      const left = ch.attempts_left - 1;
      if (left <= 0) {
        const until = new Date(tx.now.getTime() + CUSTOMER_OTP_LOCK_MINUTES * 60_000);
        await tx.query(
          `UPDATE customer_otp_challenges SET attempts_left = 0, status = 'locked', locked_until = $2, closed_at = $3,
                  code_ciphertext = NULL,
                  delivery_status = CASE WHEN delivery_status = 'queued' THEN 'skipped' ELSE delivery_status END
            WHERE id = $1`,
          [ch.id, until, tx.now],
        );
        await audit('customer.auth.otp_locked', accountId, { locked_until: iso(until) });
        throw new AppError('CUSTOMER_OTP_LOCKED', { locked_until: iso(until) }, { keepEffects: true });
      }
      await tx.query(`UPDATE customer_otp_challenges SET attempts_left = $2 WHERE id = $1`, [ch.id, left]);
      await audit('customer.auth.otp_failed', accountId, { attempts_left: left });
      throw new AppError('CUSTOMER_OTP_INVALID', { attempts_left: left }, { keepEffects: true });
    }
    await tx.query(
      `UPDATE customer_otp_challenges SET status = 'consumed', consumed_at = $2, closed_at = $2, code_ciphertext = NULL,
              delivery_status = CASE WHEN delivery_status = 'queued' THEN 'skipped' ELSE delivery_status END
        WHERE id = $1`,
      [ch.id, tx.now],
    );
    return { id: ch.id, audit };
  }

  async verify(
    tx: Tx,
    body: { phone_e164: string; code: string; device_id: string; platform: CustomerDevicePlatform },
    client: ClientInfo,
  ): Promise<CustomerAuthResult> {
    const phone = body.phone_e164;
    const { audit } = await this.consumeCode(tx, phone, body.code, client, null);
    // the account is created by the first verified sign-in (DEC-482); a deleted account no longer holds its number
    // (0011), so the same number signs up again as a new account (DEC-508)
    const inserted = await tx.maybeOne<{ id: string }>(
      `INSERT INTO customer_accounts (phone_e164, created_at, updated_at) VALUES ($1, $2, $2)
       ON CONFLICT ON CONSTRAINT uq_customer_accounts_phone DO NOTHING RETURNING id`,
      [phone, tx.now],
    );
    const account = await tx.one<CustomerAccountRow>(
      `SELECT * FROM customer_accounts WHERE phone_e164 = $1 FOR NO KEY UPDATE`,
      [phone],
    );
    if (account.status === 'deleted') throw new AppError('ACCOUNT_DELETED');
    if (account.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED');
    const { sessionId, tokens } = await issueCustomerSession(tx, account.id, {
      id: body.device_id,
      platform: body.platform,
    });
    await audit('customer.auth.signed_in', account.id, {
      session_id: sessionId,
      platform: body.platform,
      new_account: !!inserted,
    });
    return {
      ...tokens,
      account: await buildCustomerMe(tx, consentTexts(this.env), account.id),
      is_new_account: !!inserted,
    };
  }

  /**
   * `POST /v1/customer/auth/reauth/verify` (C-20, DEC-507): the code the app just requested for the account's own
   * number (`POST /v1/customer/auth/otp`) proves the caller holds that WhatsApp now. Same rules as the sign-in
   * verify; the answer is a single-use proof bound to the caller's session, valid CUSTOMER_REAUTH_TTL_S, stored as
   * sha256 only. A newer proof replaces the previous one. Lock order: the number, then the account row.
   */
  async reauthVerify(
    tx: Tx,
    actor: { accountId: string; sessionId: string },
    body: { code: string },
    client: ClientInfo,
  ): Promise<CustomerReauth> {
    const a = await tx.maybeOne<{ phone_e164: string | null }>(
      `SELECT phone_e164 FROM customer_accounts WHERE id = $1`,
      [actor.accountId],
    );
    if (!a?.phone_e164) throw new AppError('ACCOUNT_DELETED');
    const { id, audit } = await this.consumeCode(tx, a.phone_e164, body.code, client, actor.accountId);
    await lockCustomerAccount(tx, actor.accountId);
    const token = newCustomerToken('reauth', actor.sessionId);
    const expiresAt = new Date(tx.now.getTime() + CUSTOMER_REAUTH_TTL_S * 1000);
    const r = await tx.query(
      `UPDATE customer_account_sessions SET reauth_hash = $2, reauth_expires_at = $3
        WHERE id = $1 AND account_id = $4 AND revoked_at IS NULL`,
      [actor.sessionId, customerTokenHash(token), expiresAt, actor.accountId],
    );
    if (!r.rowCount) throw new AppError('AUTH_SESSION_REVOKED', { reason: 'revoked' });
    await audit('customer.auth.reauth_verified', actor.accountId, {
      session_id: actor.sessionId,
      challenge_id: id,
    });
    return { reauth_token: token, expires_at: iso(expiresAt) };
  }
}
