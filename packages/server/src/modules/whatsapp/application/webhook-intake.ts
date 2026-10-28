import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../core/clock/clock.js';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import { AppError } from '../../../core/errors/app-error.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import { webhookAppSecrets, type ChannelRow } from '../infra/channel.js';
import type { WhatsappRuntime } from '../runtime.js';

/** Constant-time equality of two strings of any length (digests are compared, 12 §6.1). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(app secret, raw body), any accepted secret (12 §6.2). */
export function verifyHubSignature(
  raw: Buffer,
  header: string | undefined,
  secrets: readonly string[],
): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? '').trim());
  if (!m) return false;
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex');
  let ok = false;
  for (const s of secrets) {
    const expected = createHmac('sha256', s).update(raw).digest();
    if (timingSafeEqual(expected, given)) ok = true; // no early exit: same work for every secret
  }
  return ok;
}

export interface StoredInbound {
  id: string | null;
  duplicate: boolean;
}

/**
 * PNT-040: GET handshake and POST intake of `/webhooks/whatsapp`. The POST handler only verifies and
 * stores (12 §6.2 step 5): the raw body is checked before any parsing, saved with
 * `ON CONFLICT (body_sha256) DO NOTHING` and `job.wa_process_inbound` is enqueued in the same
 * transaction; a database failure propagates (5xx), never a false 200.
 */
export class WhatsappWebhookIntake {
  constructor(
    private readonly rt: WhatsappRuntime,
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  private async channels(): Promise<ChannelRow[]> {
    return this.rt.channels.get(this.db);
  }

  async verifyChallenge(query: Record<string, unknown>): Promise<string> {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const refs = (await this.channels()).map((c) => c.verify_token_secret_ref);
    if (refs.length === 0) refs.push(this.rt.env.WA_VERIFY_TOKEN_REF);
    let ok = false;
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      token.length > 0
    ) {
      for (const ref of refs) {
        const expected = await this.rt.secrets.resolve(ref).catch(() => null);
        if (expected && constantTimeEqual(token, expected)) ok = true;
      }
    }
    if (!ok || typeof challenge !== 'string') throw new AppError('WA_WEBHOOK_VERIFY_FAILED');
    return challenge;
  }

  async receive(raw: Buffer | undefined, signature: string | undefined): Promise<StoredInbound> {
    const started = process.hrtime.bigint();
    const body = raw ?? Buffer.alloc(0);
    const channels = await this.channels();
    let channel: ChannelRow | null = null;
    for (const ch of channels) {
      const secrets = await webhookAppSecrets(this.rt.secrets, ch, this.rt.env.WA_APP_SECRET_PREVIOUS_REF);
      if (verifyHubSignature(body, signature, secrets)) {
        channel = ch;
        break;
      }
    }
    if (!channel) {
      if (channels.length === 0) {
        // nothing to attribute the delivery to: Meta retries for 7 days (F-08) until a channel exists
        this.rt.logger.error('whatsapp webhook received but no active channel is configured');
        throw new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 60 });
      }
      this.rt.logger.warn({ body_bytes: body.length }, 'whatsapp webhook signature invalid');
      throw new AppError('WA_WEBHOOK_SIGNATURE_INVALID');
    }
    const now = this.clock.now();
    const sha = sha256Hex(body);
    const stored = await this.db.transaction(async (tx) => {
      const r = await tx.maybeOne<{ id: string }>(
        `INSERT INTO whatsapp_inbound_events (org_id, received_at, signature_verified_at, body_sha256, raw_body)
         VALUES ($1, $2, $2, $3, $4) ON CONFLICT (body_sha256) DO NOTHING RETURNING id`,
        [channel.org_id, tx.now, sha, body.toString('utf8')],
      );
      if (r) {
        await enqueue(tx, {
          type: 'job.wa_process_inbound',
          orgId: channel.org_id,
          payload: { inbound_event_id: r.id },
        });
      }
      return { id: r?.id ?? null, duplicate: !r };
    });
    metrics.waWebhookReceived.inc();
    metrics.waWebhookLastReceived.set(now.getTime() / 1000);
    metrics.waWebhookDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
    this.rt.logger.debug(
      { inbound_event_id: stored.id, body_sha256: sha, duplicate: stored.duplicate },
      'whatsapp webhook stored',
    );
    return stored;
  }
}
