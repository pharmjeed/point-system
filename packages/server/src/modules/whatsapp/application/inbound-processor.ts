import { WA_TEMPLATE_DEFINITIONS, type WaMessageKind } from '@point/shared';
import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import { killPoint } from '../../../core/chaos/kill-points.js';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import type { Logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { RetryableJobError, type JobContext, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { classifyGraphFailure } from '../domain/graph-errors.js';
import { extractLinkCode, isOptOutKeyword, normalizeInboundText } from '../domain/inbound-text.js';
import { messageIdFromOpaque } from '../domain/render.js';
import { activeChannel, type ChannelRow } from '../infra/channel.js';
import { phoneFromWaId, upsertInboundCustomer, type WaSenderIdentity } from '../infra/customers.js';
import type { WhatsappRuntime } from '../runtime.js';
import { setChannelHealth } from './channel-health.js';
import { recordMessageStatusChange, type OutboundStatus } from './message-status.js';
import { optOutCustomer } from './opt-out.js';
import { buttonPressHandler, linkCodeHandler, w01OutcomeHandler, type ButtonPressResult } from './seams.js';
import { templateStatusFromMeta } from './templates.js';

const RANK = { sent: 1, delivered: 2, read: 3 } as const;
/** Statuses without a message are retried within ~60 s, then dropped with a metric (12 §6.8). */
const ORPHAN_ATTEMPTS = 5;
const ORPHAN_RETRY_MS = 12_000;

type Json = Record<string, any>;

interface InboundEventRow {
  id: string;
  org_id: string | null;
  raw_body: string;
  status: string;
}

interface OutboundRow {
  id: string;
  org_id: string;
  notification_id: string | null;
  ticket_id: string | null;
  venue_id: string | null;
  event_id: string | null;
  purpose: string | null;
  wa_message_id: string | null;
  status: string;
  status_rank: number;
  queued_at: Date | null;
}

export function unixToDate(ts: unknown): Date | null {
  return typeof ts === 'string' && /^\d{1,12}$/.test(ts) ? new Date(Number(ts) * 1000) : null;
}

function kindOf(type: unknown): WaMessageKind {
  switch (type) {
    case 'text':
      return 'inbound_text';
    case 'button':
      return 'inbound_button';
    case 'interactive':
      return 'inbound_interactive';
    default:
      return 'inbound_other';
  }
}

/** The contact entry of a message (12 §6.4). */
function senderOf(m: Json, contacts: Json[] | undefined): WaSenderIdentity {
  const list = Array.isArray(contacts) ? contacts : [];
  const contact =
    list.find((c) => (m.from && c?.wa_id === m.from) || (m.from_user_id && c?.user_id === m.from_user_id)) ??
    (list.length === 1 ? list[0] : undefined);
  const waId =
    typeof contact?.wa_id === 'string' ? contact.wa_id : typeof m.from === 'string' ? m.from : null;
  const userId =
    typeof contact?.user_id === 'string'
      ? contact.user_id
      : typeof m.from_user_id === 'string'
        ? m.from_user_id
        : null;
  return { waId, userId, phoneE164: phoneFromWaId(typeof m.from === 'string' ? m.from : waId) };
}

/**
 * `job.wa_process_inbound` (12 §6.3, PNT-041). Each message and each status runs in its own short
 * transaction; replays are harmless: messages are deduplicated by `uq_whatsapp_messages_wamid`, statuses
 * only move the rank up, opt-out and link/button effects run only with a newly inserted message.
 */
export class WhatsappInboundProcessor {
  constructor(
    private readonly rt: WhatsappRuntime,
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async run(ctx: Pick<JobContext, 'row'>, inboundEventId: string): Promise<void> {
    const ev = (
      await this.db.query<InboundEventRow>(
        `SELECT id, org_id, raw_body, status FROM whatsapp_inbound_events WHERE id = $1`,
        [inboundEventId],
      )
    ).rows[0];
    if (!ev || ev.status === 'processed' || ev.status === 'ignored' || !ev.org_id) return;
    await this.db.query(`UPDATE whatsapp_inbound_events SET attempts = attempts + 1 WHERE id = $1`, [ev.id]);
    try {
      await this.process(ctx, ev);
    } catch (e) {
      if (!(e instanceof RetryableJobError) && ctx.row.attempts >= ctx.row.max_attempts) {
        await this.db.query(
          `UPDATE whatsapp_inbound_events SET status = 'failed', last_error = $2 WHERE id = $1`,
          [ev.id, String((e as Error)?.message ?? e).slice(0, 500)],
        );
      }
      throw e;
    }
  }

  private async process(ctx: Pick<JobContext, 'row'>, ev: InboundEventRow): Promise<void> {
    let body: Json;
    try {
      body = JSON.parse(ev.raw_body) as Json;
    } catch {
      await this.finish(ev.id, 'ignored', 'invalid_json');
      return;
    }
    const orgId = ev.org_id!;
    const channel = await activeChannel(this.db, orgId);
    if (!channel) throw new RetryableJobError('no active whatsapp channel', 60_000);
    let relevant = 0;
    let foreign = 0;
    let orphans = 0;
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (change?.field !== 'messages') {
          if (await this.accountField(channel, change)) relevant++;
          continue;
        }
        const v: Json = change.value ?? {};
        if (v.metadata?.phone_number_id !== channel.phone_number_id) {
          foreign++;
          continue;
        }
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          await this.message(channel, m, v.contacts);
          // 17 H-03 KP-2: the press's transaction (the cycle) committed, the event not yet `processed` (TC-014)
          if (m?.type === 'button') killPoint('inbound_after_cycle_commit');
          relevant++;
        }
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
          if (!(await this.status(channel, s))) orphans++;
          relevant++;
        }
      }
    }
    if (orphans > 0) {
      if (ctx.row.attempts < ORPHAN_ATTEMPTS) {
        throw new RetryableJobError(`${orphans} status(es) without a matching message`, ORPHAN_RETRY_MS);
      }
      metrics.waStatusOrphan.inc(orphans);
      this.logger.warn(
        { inbound_event_id: ev.id, orphans },
        'whatsapp statuses dropped: no matching message',
      );
    }
    await this.finish(ev.id, relevant > 0 ? 'processed' : 'ignored', foreign > 0 ? 'foreign_number' : null);
    await this.resolveWebhookSilent(orgId);
    await this.backlogGauges();
  }

  private async finish(id: string, status: 'processed' | 'ignored', lastError: string | null): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_inbound_events SET status = $2, processed_at = $3, last_error = $4 WHERE id = $1`,
      [id, status, this.db.clock.now(), lastError],
    );
  }

  /** A webhook arrived: the «webhooks silent» condition is over (14 §8 `wa_webhook_silent`). */
  private async resolveWebhookSilent(orgId: string): Promise<void> {
    const live = await this.db.query<{ venue_id: string }>(
      `SELECT venue_id FROM alerts WHERE org_id = $1 AND type = 'wa_webhook_silent' AND status <> 'resolved'`,
      [orgId],
    );
    if (!live.rows.length) return;
    await this.db.transaction((tx) =>
      autoResolveAlerts(tx, {
        orgId,
        dedupeKeys: live.rows.map((r) => `wa_webhook_silent:${r.venue_id}`),
        note: 'webhooks received again',
      }),
    );
  }

  private async backlogGauges(): Promise<void> {
    const r = await this.db.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(received_at) AS oldest FROM whatsapp_inbound_events WHERE status = 'pending'`,
    );
    const row = r.rows[0];
    metrics.waInboundBacklog.set(row?.n ?? 0);
    metrics.waInboundLag.set(
      row?.oldest ? Math.max(0, (this.db.clock.now().getTime() - new Date(row.oldest).getTime()) / 1000) : 0,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Messages (12 §6.5–§6.7)
  // ---------------------------------------------------------------------------------------------

  private async message(channel: ChannelRow, m: Json, contacts: Json[] | undefined): Promise<void> {
    if (typeof m?.id !== 'string') return;
    const sender = senderOf(m, contacts);
    if (!sender.waId && !sender.userId) {
      this.logger.warn({ message_type: m.type }, 'inbound whatsapp message without a sender identity');
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `wa_sender:${channel.org_id}:${sender.waId ?? sender.userId}`,
      ]);
      const at = unixToDate(m.timestamp) ?? tx.now;
      const kind = kindOf(m.type);
      const text = m.type === 'text' && typeof m.text?.body === 'string' ? (m.text.body as string) : null;
      const buttonPayload =
        m.type === 'button' && typeof m.button?.payload === 'string' ? m.button.payload : null;
      const buttonText =
        m.type === 'button' && typeof m.button?.text === 'string' ? (m.button.text as string) : null;
      const interactiveTitle =
        m.type === 'interactive'
          ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null)
          : null;
      const ins = await tx.maybeOne<{ id: string }>(
        `INSERT INTO whatsapp_messages (org_id, channel_id, direction, wa_message_id, sender_wa_id, sender_user_id, kind,
                body_redacted, payload_redacted, button_payload_hash, status, status_rank, received_at, created_at, updated_at)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, 'received', 0, $10, $11, $11)
         ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [
          channel.org_id,
          channel.id,
          m.id,
          sender.waId,
          sender.userId,
          kind,
          (text ?? buttonText ?? interactiveTitle ?? null)?.slice(0, 1000) ?? null,
          JSON.stringify({ type: m.type ?? null, context_id: m.context?.id ?? null }),
          buttonPayload ? sha256Hex(buttonPayload) : null,
          at,
          tx.now,
        ],
      );
      if (!ins) return; // the same message again (AC-01)
      const customer = await upsertInboundCustomer(tx, channel.org_id, sender, at);
      await tx.query(`UPDATE whatsapp_messages SET customer_id = $2 WHERE id = $1`, [ins.id, customer.id]);
      const inbound = {
        id: ins.id,
        waMessageId: m.id as string,
        contextWamid: m.context?.id ?? null,
        receivedAt: at,
      };

      let matched: 'action_token' | 'link_code' | 'opt_out' | 'none' = 'none';
      let linkResult: 'received' | 'invalid' | null = null;
      let ticketId: string | null = null;
      let button: ButtonPressResult | null = null;
      if (text !== null) {
        const norm = normalizeInboundText(text);
        if (isOptOutKeyword(norm)) {
          matched = 'opt_out';
          await optOutCustomer(tx, {
            orgId: channel.org_id,
            customerId: customer.id,
            inboundMessageId: ins.id,
          });
        } else {
          const code = extractLinkCode(norm);
          if (code) {
            matched = 'link_code';
            const r = await linkCodeHandler()(tx, {
              orgId: channel.org_id,
              channelId: channel.id,
              code,
              inbound,
              sender,
              customer,
            });
            linkResult = r.result;
            ticketId = r.ticket_id;
          }
        }
      } else if (m.type === 'button') {
        button = await buttonPressHandler()(tx, {
          orgId: channel.org_id,
          channelId: channel.id,
          inbound,
          sender,
          customer,
          payloadHash: buttonPayload ? sha256Hex(buttonPayload) : '',
          buttonText,
        });
        ticketId = button.ticket_id;
        if (!(button.outcome === 'rejected' && button.reject_reason === 'unknown_token'))
          matched = 'action_token';
      } else if (m.type === 'interactive') {
        // we never send interactive messages: a reply is an unknown button (12 §6.7)
        button = {
          outcome: 'rejected',
          reject_reason: 'unknown_token',
          ticket_id: null,
          customer_id: customer.id,
        };
      }
      let venueId: string | null = null;
      if (ticketId) {
        const t = await tx.maybeOne<{ venue_id: string; event_id: string }>(
          `SELECT venue_id, event_id FROM tickets WHERE id = $1`,
          [ticketId],
        );
        venueId = t?.venue_id ?? null;
        await tx.query(
          `UPDATE whatsapp_messages SET ticket_id = $2, venue_id = $3, event_id = $4 WHERE id = $1`,
          [ins.id, ticketId, venueId, t?.event_id ?? null],
        );
      }
      await emitEvent(tx, {
        type: 'wa.inbound_received',
        orgId: channel.org_id,
        venueId,
        aggregate: { type: 'whatsapp_message', id: ins.id, version: 0 },
        actor: { type: 'customer', id: customer.id },
        payload: {
          whatsapp_message_id: ins.id,
          kind,
          message_type: typeof m.type === 'string' ? m.type : 'unknown',
          customer_id: customer.id,
          ticket_id: ticketId,
          matched,
          link_result: linkResult,
        },
      });
      if (button) {
        await emitEvent(tx, {
          type: 'wa.button_pressed',
          orgId: channel.org_id,
          venueId,
          aggregate: { type: 'whatsapp_message', id: ins.id, version: 0 },
          actor: { type: 'customer', id: customer.id },
          payload: {
            whatsapp_message_id: ins.id,
            ticket_id: button.ticket_id,
            customer_id: button.customer_id ?? customer.id,
            outcome: button.outcome,
            ...(button.reject_reason ? { reject_reason: button.reject_reason } : {}),
          },
        });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Statuses (12 §6.8, 11 §6.8)
  // ---------------------------------------------------------------------------------------------

  /** Returns false when no message matches (orphan). */
  private async status(channel: ChannelRow, s: Json): Promise<boolean> {
    const wamid = typeof s?.id === 'string' ? s.id : null;
    const opaqueId = messageIdFromOpaque(s?.biz_opaque_callback_data);
    const find = async (q: Pick<Tx, 'maybeOne'>, lock: boolean) => {
      const suffix = lock ? 'FOR NO KEY UPDATE' : '';
      let row = wamid
        ? await q.maybeOne<OutboundRow>(
            `SELECT * FROM whatsapp_messages WHERE wa_message_id = $1 AND direction = 'outbound' ${suffix}`,
            [wamid],
          )
        : null;
      if (!row && opaqueId)
        row = await q.maybeOne<OutboundRow>(
          `SELECT * FROM whatsapp_messages WHERE id = $1 AND direction = 'outbound' AND org_id = $2 ${suffix}`,
          [opaqueId, channel.org_id],
        );
      return row;
    };
    return this.db.transaction(async (tx) => {
      const peek = await find(tx, false);
      if (!peek) return false;
      // canon order: a failed W-01 changes the ticket (L5) — lock it before the message row
      if (s.status === 'failed' && peek.purpose === 'W-01' && peek.ticket_id)
        await lockTickets(tx, [peek.ticket_id]);
      const row = (await find(tx, true))!;
      const at = unixToDate(s.timestamp) ?? tx.now;
      if (!row.wa_message_id && wamid) {
        // acceptance proven by the webhook before the sender recorded it (crash window, 12 §5.13);
        // the sender finalizes the notification when its job resumes
        await tx.query(
          `UPDATE whatsapp_messages SET wa_message_id = $2, queued_at = COALESCE(queued_at, $3) WHERE id = $1 AND wa_message_id IS NULL`,
          [row.id, wamid, tx.now],
        );
        row.wa_message_id = wamid;
      }
      if (s.status === 'failed') await this.failedStatus(tx, channel, row, s, at);
      else if (s.status in RANK) await this.advance(tx, row, s.status as keyof typeof RANK, at);
      if (s.pricing && typeof s.pricing === 'object') {
        await tx.query(`UPDATE whatsapp_messages SET pricing_category = $2, billable = $3 WHERE id = $1`, [
          row.id,
          typeof s.pricing.category === 'string' ? s.pricing.category : null,
          typeof s.pricing.billable === 'boolean' ? s.pricing.billable : null,
        ]);
      }
      return true;
    });
  }

  /** The rank never goes down: `sent` after `read` changes nothing; `read` fills `delivered_at` (TC-WA-15). */
  private async advance(tx: Tx, row: OutboundRow, status: keyof typeof RANK, at: Date): Promise<void> {
    const rank = RANK[status];
    if (row.status === 'failed' || row.status === 'skipped' || rank <= row.status_rank) return;
    await tx.query(
      `UPDATE whatsapp_messages SET status = $2, status_rank = $3::int,
              sent_at = COALESCE(sent_at, $4::timestamptz),
              delivered_at = CASE WHEN $3::int >= 2 THEN COALESCE(delivered_at, $4::timestamptz) ELSE delivered_at END,
              read_at = CASE WHEN $3::int = 3 THEN COALESCE(read_at, $4::timestamptz) ELSE read_at END
        WHERE id = $1`,
      [row.id, status, rank, at],
    );
    if (rank >= 2 && row.status_rank < 2 && row.queued_at)
      metrics.waDelivery.observe(Math.max(0, (at.getTime() - new Date(row.queued_at).getTime()) / 1000));
    await this.statusChanged(tx, row, status, rank, null);
  }

  private async failedStatus(
    tx: Tx,
    channel: ChannelRow,
    row: OutboundRow,
    s: Json,
    at: Date,
  ): Promise<void> {
    const e: Json = Array.isArray(s.errors) ? (s.errors[0] ?? {}) : {};
    const code = typeof e.code === 'number' ? e.code : null;
    if (row.status === 'failed') return; // replayed failure
    if (row.status_rank >= 2) {
      // a delivered message never becomes failed: keep the anomaly only (11 §6.8)
      await tx.query(
        `UPDATE whatsapp_messages SET error_details = COALESCE(error_details, '{}'::jsonb) || jsonb_build_object('late_failure', $2::jsonb) WHERE id = $1`,
        [row.id, JSON.stringify({ code, title: e.title ?? null, at: at.toISOString() })],
      );
      return;
    }
    const c = classifyGraphFailure({ kind: 'http', status: null, code, message: String(e.title ?? '') });
    await tx.query(
      `UPDATE whatsapp_messages SET status = 'failed', failed_at = $2, error_code = $3, error_title = $4, error_details = $5 WHERE id = $1`,
      [
        row.id,
        at,
        code !== null ? String(code) : null,
        typeof e.title === 'string' ? e.title.slice(0, 200) : null,
        JSON.stringify({
          code,
          details: typeof e.error_data?.details === 'string' ? e.error_data.details.slice(0, 300) : null,
        }),
      ],
    );
    if (row.notification_id) {
      await tx.query(
        `UPDATE notifications SET status = 'failed', failed_at = $2, last_error_code = $3, last_error_message = $4
          WHERE id = $1 AND status IN ('pending','sent')`,
        [row.notification_id, tx.now, c.internalCode, `provider ${c.providerCode}`],
      );
    }
    if (row.purpose === 'W-01' && row.ticket_id && row.notification_id) {
      const lv = await tx.maybeOne<{ link_version: number | null }>(
        `SELECT (payload->>'link_version')::int AS link_version FROM outbox_events
          WHERE type = 'job.wa_send' AND payload->>'notification_id' = $1 ORDER BY seq DESC LIMIT 1`,
        [row.notification_id],
      );
      await w01OutcomeHandler()(tx, {
        ticketId: row.ticket_id,
        notificationId: row.notification_id,
        linkVersion: lv?.link_version ?? null,
        outcome: 'failed',
        errorCode: c.providerCode,
        action: 'job.wa_process_inbound',
      });
    }
    if (row.ticket_id && row.venue_id && row.purpose) {
      await raiseAlert(tx, {
        orgId: row.org_id,
        venueId: row.venue_id,
        type: 'wa_send_failed',
        dedupeKey: `wa_send_failed:${row.ticket_id}:${row.purpose}`,
        ticketId: row.ticket_id,
        eventId: row.event_id,
        details: {
          purpose: row.purpose,
          notification_id: row.notification_id,
          error_code: c.internalCode,
          provider_error_code: c.providerCode,
          reason: c.cls,
        },
      });
    }
    if (c.channel)
      await setChannelHealth(tx, channel.id, c.channel, `status_${c.providerCode}`, 'job.wa_process_inbound');
    await this.statusChanged(tx, row, 'failed', row.status_rank, code !== null ? String(code) : null);
  }

  private statusChanged(
    tx: Tx,
    row: OutboundRow,
    status: OutboundStatus,
    rank: number,
    errorCode: string | null,
  ): Promise<void> {
    return recordMessageStatusChange(tx, row, status, rank, errorCode);
  }

  // ---------------------------------------------------------------------------------------------
  // Account fields (12 §6.9): template status / category, phone number quality
  // ---------------------------------------------------------------------------------------------

  private async accountField(channel: ChannelRow, change: Json): Promise<boolean> {
    const v: Json = change?.value ?? {};
    const catalog = (name: unknown) => WA_TEMPLATE_DEFINITIONS.find((d) => d.name === name);
    switch (change?.field) {
      case 'message_template_status_update': {
        const def = catalog(v.message_template_name);
        if (!def) return true;
        const status = templateStatusFromMeta(v.event);
        await this.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO whatsapp_templates (org_id, name, language, category, status, components, meta_template_id, rejection_reason, last_synced_at, created_at, updated_at)
             VALUES ($1, $2, $3, 'UTILITY', $4, $5, $6, $7, $8, $8, $8)
             ON CONFLICT (org_id, name, language) DO UPDATE SET status = EXCLUDED.status,
               meta_template_id = COALESCE(EXCLUDED.meta_template_id, whatsapp_templates.meta_template_id),
               rejection_reason = EXCLUDED.rejection_reason, last_synced_at = EXCLUDED.last_synced_at,
               version = whatsapp_templates.version + CASE WHEN whatsapp_templates.status IS DISTINCT FROM EXCLUDED.status THEN 1 ELSE 0 END`,
            [
              channel.org_id,
              def.name,
              typeof v.message_template_language === 'string' ? v.message_template_language : 'ar',
              status,
              JSON.stringify(def.components),
              v.message_template_id != null ? String(v.message_template_id) : null,
              status === 'rejected' ? String(v.reason ?? 'REJECTED') : null,
              tx.now,
            ],
          );
          if (status !== 'approved' && status !== 'pending') {
            this.logger.error({ template: def.name, status }, 'whatsapp template left approved');
            await setChannelHealth(
              tx,
              channel.id,
              'degraded',
              `template_${def.name}_${status}`,
              'job.wa_process_inbound',
            );
          }
        });
        return true;
      }
      case 'template_category_update': {
        const def = catalog(v.message_template_name);
        if (!def) return true;
        const cat = String(v.new_category ?? v.category ?? 'UTILITY').toUpperCase();
        if (cat === 'UTILITY') return true;
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE whatsapp_templates SET category = $3, version = version + 1 WHERE org_id = $1 AND name = $2`,
            [channel.org_id, def.name, cat === 'MARKETING' || cat === 'AUTHENTICATION' ? cat : 'UTILITY'],
          );
          this.logger.error({ template: def.name, category: cat }, 'whatsapp template recategorized');
          await setChannelHealth(
            tx,
            channel.id,
            'degraded',
            `template_${def.name}_${cat.toLowerCase()}`,
            'job.wa_process_inbound',
          );
        });
        return true;
      }
      case 'phone_number_quality_update': {
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE whatsapp_channel SET messaging_limit_tier = COALESCE($2, messaging_limit_tier) WHERE id = $1`,
            [channel.id, typeof v.current_limit === 'string' ? v.current_limit : null],
          );
          if (v.event === 'FLAGGED' || v.event === 'DOWNGRADE')
            await setChannelHealth(
              tx,
              channel.id,
              'degraded',
              `quality_${String(v.event).toLowerCase()}`,
              'job.wa_process_inbound',
            );
        });
        return true;
      }
      default:
        this.logger.info({ field: change?.field }, 'whatsapp account webhook field recorded');
        return true;
    }
  }
}

export function waProcessInboundHandler(runtime: () => WhatsappRuntime): JobHandler {
  return {
    type: 'job.wa_process_inbound',
    mode: 'external',
    async handle(ctx) {
      const id = ctx.row.payload?.inbound_event_id;
      if (typeof id !== 'string') return;
      await new WhatsappInboundProcessor(runtime(), ctx.db, ctx.logger).run(ctx, id);
    },
  };
}
