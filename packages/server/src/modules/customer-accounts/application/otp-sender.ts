import { customerOtpMessage, type WaCustomerOtpLanguage } from '@point/shared';
import { decrypt } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import {
  RetryableJobError,
  backoffMs,
  type JobContext,
  type JobHandler,
} from '../../../core/outbox/dispatcher.js';
import { classifyGraphFailure, type ChannelRow, type WhatsappRuntime } from '../../whatsapp/index.js';
import { CUSTOMER_OTP_SEND_JOB } from './otp-service.js';

interface ChallengeRow {
  id: string;
  phone_e164: string;
  locale: WaCustomerOtpLanguage;
  status: string;
  code_ciphertext: string | null;
  expires_at: Date;
  delivery_status: string;
}

type Outcome = 'sent' | 'failed' | 'skipped';

/**
 * `job.customer_otp_send` (V2-010, DEC-496): sends one sign-in code with the AUTHENTICATION template of the Point
 * number, outside any transaction (mode `external`, canon rule 3). The code exists only as the challenge's single
 * encrypted copy, decrypted here in memory and wiped from the row as soon as the send ends — sent, failed for good,
 * skipped because the code is no longer open (superseded, used, locked, expired) or because the recipient is
 * outside WA_TEST_RECIPIENT_ALLOWLIST (staging; dev and tests talk to tools/wa-simulator, never to a real number).
 * Nothing about the code or the phone is logged or written to whatsapp_messages (an operator's table: the sign-in of
 * a platform customer is not an operator's message, DEC-496); the delivery state stays on the challenge.
 */
export function customerOtpSendHandler(runtime: () => WhatsappRuntime): JobHandler {
  return {
    type: CUSTOMER_OTP_SEND_JOB,
    mode: 'external',
    async handle(ctx) {
      const id = ctx.row.payload?.challenge_id;
      if (typeof id !== 'string') return;
      await sendOtp(runtime(), ctx, id);
    },
  };
}

async function finish(
  db: Database,
  id: string,
  outcome: Outcome,
  fields: { wamid?: string | null; error?: string | null; at: Date },
): Promise<void> {
  await db.query(
    `UPDATE customer_otp_challenges SET delivery_status = $2, code_ciphertext = NULL,
            wa_message_id = COALESCE($3, wa_message_id), delivery_error_code = $4,
            sent_at = CASE WHEN $2 = 'sent' THEN $5::timestamptz ELSE sent_at END
      WHERE id = $1 AND delivery_status = 'queued'`,
    [id, outcome, fields.wamid ?? null, fields.error ?? null, fields.at],
  );
}

async function sendOtp(rt: WhatsappRuntime, ctx: JobContext, id: string): Promise<void> {
  const now = ctx.clock.now();
  const c = (
    await ctx.db.query<ChallengeRow>(
      `SELECT id, phone_e164, locale, status, code_ciphertext, expires_at, delivery_status
         FROM customer_otp_challenges WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!c || c.delivery_status !== 'queued') return;
  if (c.status !== 'open' || !c.code_ciphertext || c.expires_at.getTime() <= now.getTime())
    return finish(ctx.db, id, 'skipped', { error: 'not_open', at: now });
  if (!rt.recipientAllowed(c.phone_e164))
    return finish(ctx.db, id, 'skipped', { error: 'allowlist', at: now });

  const channelId = ctx.row.payload?.channel_id;
  const ch = (
    await ctx.db.query<ChannelRow>(`SELECT * FROM whatsapp_channel WHERE id = $1 AND is_active`, [channelId])
  ).rows[0];
  if (!ch) return finish(ctx.db, id, 'failed', { error: 'no_channel', at: now });
  const name = rt.catalog.customerOtp.name;
  // the send gate of 12 §5.4 (L-05): only an approved template of the number's catalog is sent
  const tpl = (
    await ctx.db.query<{ status: string }>(
      `SELECT status FROM whatsapp_templates WHERE org_id = $1 AND name = $2 AND language = $3`,
      [ch.org_id, name, c.locale],
    )
  ).rows[0];
  if (tpl?.status !== 'approved')
    return finish(ctx.db, id, 'failed', { error: 'template_not_approved', at: now });
  if (ch.health_status === 'down') throw new RetryableJobError('channel down', 5_000);
  const token = await rt.secrets.resolve(ch.access_token_secret_ref).catch(() => null);
  if (!token) throw new RetryableJobError('channel token unavailable', backoffMs(ctx.row.attempts + 1));

  const code = decrypt(c.code_ciphertext, rt.encryptionKeys);
  const to = c.phone_e164.replace(/^\+/, '');
  const res = await rt.graph.sendMessage(ch, token, customerOtpMessage(to, c.locale, code));
  if (res.ok) {
    const wamid = res.body.messages?.[0]?.id ?? null;
    ctx.logger.info({ challenge_id: id, outcome: 'sent' }, 'customer sign-in code sent');
    return finish(ctx.db, id, 'sent', { wamid, at: ctx.clock.now() });
  }
  const cls = classifyGraphFailure(res);
  // a temporary failure is retried while the code can still be used; otherwise the send ends here
  const last = ctx.row.attempts + 1 >= ctx.row.max_attempts;
  if (cls.retryable && !last && c.expires_at.getTime() > ctx.clock.now().getTime() + 5_000)
    throw new RetryableJobError(`whatsapp ${cls.providerCode}`, backoffMs(ctx.row.attempts + 1));
  ctx.logger.warn(
    { challenge_id: id, provider_error_code: cls.providerCode },
    'customer sign-in code not sent',
  );
  return finish(ctx.db, id, 'failed', { error: cls.providerCode, at: ctx.clock.now() });
}
