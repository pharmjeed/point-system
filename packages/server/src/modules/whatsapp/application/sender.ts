import {
  WA_TEMPLATE_NAMES,
  WaSendJobPayloadSchema,
  renderWaText,
  waMessageText,
  waTemplateById,
  type ErrorCode,
  type NotificationSkippedReason,
  type OrgSettings,
  type TicketChannel,
  type TicketStatus,
  type WaLinkStatus,
  type WaMessageId,
  type WaSendJobPayload,
} from '@point/shared';
import { raiseAlert } from '../../../core/alerts/alerts.js';
import { killPoint } from '../../../core/chaos/kill-points.js';
import { decrypt } from '../../../core/crypto/crypto.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { metrics } from '../../../core/metrics/metrics.js';
import {
  PermanentJobError,
  RetryableJobError,
  type JobContext,
  type JobHandler,
} from '../../../core/outbox/dispatcher.js';
import { orgSettings } from '../../../core/settings/settings-service.js';
import {
  classifyGraphFailure,
  sanitizeProviderMessage,
  type GraphFailure,
  type WaErrorClassification,
} from '../domain/graph-errors.js';
import {
  failingStreakExceeded,
  orderingGateWaitMs,
  pairBucketWaitMs,
  sendRetryDelayMs,
  temporaryErrorRateExceeded,
  venueShare,
} from '../domain/pacing.js';
import {
  CODE_MASK,
  buildSessionMessage,
  buildTemplateMessage,
  opaqueFor,
  vehicleSummary,
  type BuiltMessage,
  type WaRecipient,
} from '../domain/render.js';
import {
  sendTimeSkipReason,
  sessionWindowOpen,
  w09VariantFor,
  type SendFacts,
} from '../domain/send-rules.js';
import { activeChannel, type ChannelRow } from '../infra/channel.js';
import { phoneFromWaId } from '../infra/customers.js';
import type { GraphSendResponse } from '../infra/graph-client.js';
import type { WhatsappRuntime } from '../runtime.js';
import { setChannelHealth } from './channel-health.js';
import { recordMessageStatusChange } from './message-status.js';
import { actionTokenIssuer, w01OutcomeHandler } from './seams.js';
import { templateStatus } from './templates.js';

type WaSettings = OrgSettings['wa'];

/** 12 §5.13: an attempt without a recorded outcome waits this long for a status webhook before resending. */
export const CRASH_WAIT_MS = 30_000;
/** 12 §5.14: the phone-number probe runs at most once a minute per channel and process. */
export const PROBE_INTERVAL_MS = 60_000;
/** 12 §5.3 `defer(job, 30)` while the channel is down. */
export const CHANNEL_DOWN_DEFER_MS = 30_000;
/** The ordering gate (12 §5.6) is re-checked at this pace so a `delivered` status releases it quickly. */
export const ORDERING_POLL_MS = 2_000;
/** wa_webhook_silent (14 §8): accepted sends but no webhook for 10 minutes. */
export const WEBHOOK_SILENT_MS = 10 * 60_000;

interface NotificationRow {
  id: string;
  org_id: string;
  channel: string;
  purpose: WaMessageId;
  recipient_customer_id: string;
  venue_id: string | null;
  ticket_id: string | null;
  task_id: string | null;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  created_at: Date;
}

interface CustomerFacts {
  id: string;
  phone_e164: string | null;
  wa_id: string | null;
  wa_user_id: string | null;
  last_inbound_at: Date | null;
  wa_opted_out_at: Date | null;
  has_consent: boolean;
}

interface TicketFacts {
  id: string;
  org_id: string;
  venue_id: string;
  event_id: string;
  display_number: number;
  status: TicketStatus;
  channel: TicketChannel;
  customer_id: string | null;
  wa_link_status: WaLinkStatus;
  link_version: number;
  active_cycle_id: string | null;
  pending_retrieval_at: Date | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  plate_digits: string | null;
  venue_name_ar: string;
}

interface MessageRow {
  id: string;
  wa_message_id: string | null;
  status: string;
  status_rank: number;
  queued_at: Date | null;
  created_at: Date;
}

/** A refusal decided before any provider call (template gate, allowlist, unreadable code). */
interface GateFailure {
  internalCode: ErrorCode;
  reason: 'template' | 'allowlist' | 'programming';
  message: string;
  alert: boolean;
}

interface Reservation {
  n: NotificationRow;
  built: BuiltMessage;
  msgId: string;
  attemptNo: number;
  /** attempts counted towards wa.send_max_attempts, this one included */
  counted: number;
  sendKind: 'template' | 'session';
  ticket: TicketFacts | null;
  customerId: string;
  eventId: string | null;
}

type Prepared =
  | { kind: 'done' }
  | { kind: 'wait'; ms: number; reason: string }
  | { kind: 'probe' }
  | { kind: 'accepted'; n: NotificationRow; msg: MessageRow; attemptNo: number | null }
  | { kind: 'fail'; n: NotificationRow; failure: GateFailure; draft: MessageDraft | null }
  | ({ kind: 'send' } & Reservation);

/** What a refused message would have looked like (masked), so S-03 shows the failed row. */
interface MessageDraft {
  kind: 'template' | 'session_text';
  templateName: string | null;
  bodyRedacted: string;
  customerId: string;
  ticket: TicketFacts | null;
}

const isoOrNull = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * `job.wa_send` (12 §5.3, PNT-042). One job per notification; the payload carries ids only (DEC-38).
 * Every check reads the fresh state; nothing is held open during the Graph call: a reservation
 * transaction (lock the notification L9, skip rules, template gate, ordering gate, recipient bucket,
 * global pacing, message + attempt rows, action token, code decryption in memory), then the call, then
 * an outcome transaction. Waits that are not provider attempts give their outbox attempt back.
 */
export class WhatsappSender {
  private readonly payload: WaSendJobPayload;

  constructor(
    private readonly rt: WhatsappRuntime,
    private readonly ctx: JobContext,
  ) {
    const parsed = WaSendJobPayloadSchema.safeParse(ctx.row.payload);
    if (!parsed.success)
      throw new PermanentJobError('job.wa_send payload does not match WaSendJobPayloadSchema');
    this.payload = parsed.data;
  }

  private get db(): Database {
    return this.ctx.db;
  }

  private nowMs(): number {
    return this.ctx.clock.now().getTime();
  }

  async run(): Promise<void> {
    const n = (
      await this.db.query<NotificationRow>(`SELECT * FROM notifications WHERE id = $1`, [
        this.payload.notification_id,
      ])
    ).rows[0];
    if (!n) return;
    if (n.channel !== 'whatsapp') throw new PermanentJobError('job.wa_send for a non-WhatsApp notification');
    if (n.status !== 'pending') return this.afterFinal(n);

    const settings = (
      await orgSettings(
        { maybeOne: async (sql, p) => (await this.db.query(sql, p as unknown[])).rows[0] ?? null },
        n.org_id,
      )
    ).wa;
    const ch = await activeChannel(this.db, n.org_id);
    if (!ch) {
      this.ctx.logger.warn({ notification_id: n.id }, 'whatsapp send waiting: no active channel');
      return this.defer(n.id, 60_000, 'no_active_channel');
    }
    if (ch.mode !== this.rt.env.WA_MODE) {
      // never send through a channel configured for the other mode (live vs simulator, 12 §3.2)
      this.ctx.logger.error(
        { channel_id: ch.id, channel_mode: ch.mode, wa_mode: this.rt.env.WA_MODE },
        'whatsapp channel mode differs from WA_MODE',
      );
      return this.defer(n.id, 60_000, 'channel_mode_mismatch');
    }
    const token = await this.rt.secrets.resolve(ch.access_token_secret_ref).catch(() => null);
    if (!token && ch.health_status !== 'down') {
      this.ctx.logger.error({ channel_id: ch.id }, 'whatsapp access token reference cannot be resolved');
      await this.db.transaction((tx) =>
        setChannelHealth(tx, ch.id, 'down', 'access_token_unavailable', 'job.wa_send'),
      );
      ch.health_status = 'down';
    }
    if (token && ch.health_status === 'degraded') await this.probeIfStale(ch, token);

    for (let round = 0; round < 2; round++) {
      const p = await this.db.transaction((tx) => this.prepare(tx, n.id, ch, settings));
      switch (p.kind) {
        case 'done':
          return;
        case 'wait':
          return this.defer(n.id, p.ms, p.reason);
        case 'probe':
          if (token && (await this.probe(ch, token))) continue; // a fresh good probe: one real send decides
          return this.defer(n.id, CHANNEL_DOWN_DEFER_MS, 'channel_down');
        case 'accepted':
          await this.db.transaction((tx) =>
            this.recordAccepted(tx, ch, p.n, p.msg.id, p.msg.wa_message_id!, p.attemptNo, null, null, null),
          );
          return;
        case 'fail':
          await this.db.transaction((tx) => this.failBeforeSend(tx, ch, p.n, p.failure, p.draft));
          return;
        case 'send':
          return this.send(ch, token!, settings, p);
      }
    }
    return this.defer(n.id, CHANNEL_DOWN_DEFER_MS, 'channel_down');
  }

  // ---------------------------------------------------------------------------------------------
  // Reservation (one short transaction, no network)
  // ---------------------------------------------------------------------------------------------

  private async prepare(tx: Tx, notificationId: string, ch: ChannelRow, s: WaSettings): Promise<Prepared> {
    const n = await tx.maybeOne<NotificationRow>(
      `SELECT * FROM notifications WHERE id = $1 FOR NO KEY UPDATE`,
      [notificationId],
    );
    if (!n || n.status !== 'pending') return { kind: 'done' };
    const now = tx.now;

    // 12 §5.13: acceptance proven by a status webhook, or an attempt that never recorded its outcome
    const last = await tx.maybeOne<MessageRow>(
      `SELECT id, wa_message_id, status, status_rank, queued_at, created_at FROM whatsapp_messages
        WHERE notification_id = $1 AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [n.id],
    );
    const open = await tx.maybeOne<{ attempt_no: number; started_at: Date }>(
      `SELECT attempt_no, started_at FROM notification_attempts WHERE notification_id = $1 AND finished_at IS NULL
        ORDER BY attempt_no DESC LIMIT 1`,
      [n.id],
    );
    if (last?.wa_message_id && last.status !== 'failed')
      return { kind: 'accepted', n, msg: last, attemptNo: open?.attempt_no ?? null };
    if (open) {
      const age = now.getTime() - new Date(open.started_at).getTime();
      if (age < CRASH_WAIT_MS)
        return { kind: 'wait', ms: CRASH_WAIT_MS - age, reason: 'awaiting_outcome_of_previous_attempt' };
      await tx.query(
        `UPDATE notification_attempts SET finished_at = $3, outcome = 'retryable_error', provider_error_code = 'unknown',
                provider_error_message = 'no outcome recorded for this attempt'
          WHERE notification_id = $1 AND attempt_no = $2`,
        [n.id, open.attempt_no, now],
      );
    }

    // fresh state (12 §5.5)
    const customer = await tx.one<CustomerFacts>(
      `SELECT c.id, c.phone_e164, c.wa_id, c.wa_user_id, c.last_inbound_at, c.wa_opted_out_at,
              EXISTS (SELECT 1 FROM customer_consents k WHERE k.customer_id = c.id AND k.revoked_at IS NULL) AS has_consent
         FROM customers c WHERE c.id = $1`,
      [n.recipient_customer_id],
    );
    const ticket = n.ticket_id
      ? await tx.maybeOne<TicketFacts>(
          `SELECT t.id, t.org_id, t.venue_id, t.event_id, t.display_number, t.status, t.channel, t.customer_id,
                  t.wa_link_status, t.link_version, t.active_cycle_id, t.pending_retrieval_at, t.vehicle_make,
                  t.vehicle_model, t.vehicle_color, t.plate_digits, v.name_ar AS venue_name_ar
             FROM tickets t JOIN venues v ON v.id = t.venue_id WHERE t.id = $1`,
          [n.ticket_id],
        )
      : null;
    const facts = await this.facts(tx, n, customer, ticket);
    const skip = sendTimeSkipReason(facts);
    if (skip) return this.skip(tx, n, skip);

    // template gate (12 §5.4) with the W-05 session fallback of 12 §8.4
    const def = waTemplateById(n.purpose);
    let sendKind: 'template' | 'session' = def.kind;
    if (def.kind === 'template') {
      const status = await templateStatus(tx, n.org_id, def.name);
      if (status !== 'approved') {
        if (n.purpose === 'W-05' && sessionWindowOpen(customer.last_inbound_at, now)) sendKind = 'session';
        else
          return {
            kind: 'fail',
            n,
            failure: {
              internalCode: 'WA_TEMPLATE_NOT_APPROVED',
              reason: 'template',
              message: `template ${def.name} is ${status ?? 'not synced'}`,
              alert: true,
            },
            draft: await this.draft(n, customer.id, ticket, 'template'),
          };
      }
    }

    // channel health (12 §5.14): session replies are not kept for later; templates wait for the probe
    const health = (
      await tx.one<{ health_status: string }>(`SELECT health_status FROM whatsapp_channel WHERE id = $1`, [
        ch.id,
      ])
    ).health_status;
    if (health === 'down') {
      if (sendKind === 'session') return this.skip(tx, n, 'channel_down');
      const probe = this.rt.probes.get(ch.id);
      if (!probe || this.nowMs() - probe.at >= PROBE_INTERVAL_MS) return { kind: 'probe' };
      if (!probe.ok) return { kind: 'wait', ms: CHANNEL_DOWN_DEFER_MS, reason: 'channel_down' };
    }

    // staging guard (05 §8 WA_TEST_RECIPIENT_ALLOWLIST)
    const phone = customer.phone_e164 ?? phoneFromWaId(customer.wa_id);
    if (!this.rt.recipientAllowed(phone))
      return {
        kind: 'fail',
        n,
        failure: {
          internalCode: 'WA_SEND_FAILED',
          reason: 'allowlist',
          message: 'recipient is not in WA_TEST_RECIPIENT_ALLOWLIST',
          alert: false,
        },
        draft: await this.draft(n, customer.id, ticket, sendKind),
      };
    const recipient: WaRecipient = { to: phone, recipient: phone ? null : customer.wa_user_id };

    // per-ticket ordering gate (12 §5.6)
    if (n.ticket_id) {
      const prev = await tx.maybeOne<{ queued_at: Date; status: string; status_rank: number }>(
        `SELECT queued_at, status, status_rank FROM whatsapp_messages
          WHERE ticket_id = $1 AND direction = 'outbound' AND queued_at IS NOT NULL AND notification_id IS DISTINCT FROM $2
          ORDER BY queued_at DESC LIMIT 1`,
        [n.ticket_id, n.id],
      );
      const wait = orderingGateWaitMs(
        prev
          ? { acceptedAt: new Date(prev.queued_at), status: prev.status, statusRank: prev.status_rank }
          : null,
        now,
        s.ordering_gate_max_wait_s,
      );
      if (wait > 0) return { kind: 'wait', ms: Math.min(wait, ORDERING_POLL_MS), reason: 'ordering_gate' };
    }

    // per-recipient bucket (12 §5.7), serialized per customer across workers
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wa_pair:${customer.id}`]);
    const recent = await tx.rows<{ created_at: Date }>(
      `SELECT created_at FROM whatsapp_messages
        WHERE customer_id = $1 AND direction = 'outbound' AND created_at > $2 AND notification_id IS DISTINCT FROM $3
        ORDER BY created_at DESC LIMIT 64`,
      [customer.id, new Date(now.getTime() - 3_600_000), n.id],
    );
    const pairWait = pairBucketWaitMs(
      recent.map((r) => new Date(r.created_at)),
      now,
      s.pair_bucket_capacity,
      s.pair_refill_s,
    );
    if (pairWait > 0) return { kind: 'wait', ms: pairWait, reason: 'recipient_bucket' };

    // global ceiling and venue fairness (12 §5.8)
    const pacer = this.rt.pacer(ch.id);
    const nowMs = this.nowMs();
    let dueVenues = 1;
    if (pacer.inWindow(nowMs) >= venueShare(pacer.mps(s.global_mps, nowMs), 2)) {
      const r = await tx.one<{ n: number }>(
        `SELECT count(DISTINCT venue_id)::int AS n FROM outbox_events
          WHERE status = 'pending' AND type = 'job.wa_send' AND available_at <= $1 AND org_id = $2
            AND venue_id IS NOT NULL AND venue_id IS DISTINCT FROM $3`,
        [now, n.org_id, n.venue_id],
      );
      dueVenues = r.n + 1;
    }
    const globalWait = pacer.waitMs(nowMs, s.global_mps, n.venue_id, dueVenues);
    if (globalWait > 0) return { kind: 'wait', ms: globalWait, reason: 'global_rate' };

    // reservation: message row (reused across attempts so the opaque id stays stable), attempt row
    const reuse = last && !last.wa_message_id && last.status === 'queued' ? last : null;
    const msgId = reuse?.id ?? newId();
    let token: string | null = null;
    if (n.purpose === 'W-01' && sendKind === 'template') {
      token = (
        await actionTokenIssuer()(tx, {
          orgId: n.org_id,
          ticketId: ticket!.id,
          customerId: customer.id,
          linkVersion: ticket!.link_version,
          ttlHours: s.action_token_ttl_h,
        })
      ).token;
    }
    let code: string | null = null;
    if (n.purpose === 'W-05') {
      const c = await tx.maybeOne<{ code_ciphertext: string | null }>(
        `SELECT code_ciphertext FROM claim_codes WHERE id = $1`,
        [this.payload.claim_code_id ?? null],
      );
      if (!c?.code_ciphertext) return this.skip(tx, n, 'stale');
      try {
        code = decrypt(c.code_ciphertext, this.rt.encryptionKeys); // memory only (DEC-38)
      } catch {
        return {
          kind: 'fail',
          n,
          failure: {
            internalCode: 'WA_SEND_FAILED',
            reason: 'programming',
            message: 'handover code could not be decrypted with DATA_ENCRYPTION_KEY',
            alert: true,
          },
          draft: await this.draft(n, customer.id, ticket, sendKind),
        };
      }
    }
    const content = await this.content(tx, n, sendKind, ticket, code);
    const opaque = opaqueFor(msgId);
    const built =
      content.kind === 'template'
        ? buildTemplateMessage({
            purpose: n.purpose,
            recipient,
            params: content.params,
            secretParams: code ? [code] : [],
            buttonPayload: token,
            opaque,
          })
        : buildSessionMessage({
            recipient,
            text: content.text,
            contextWamid: content.contextWamid,
            secrets: code ? [code] : [],
            opaque,
          });
    if (reuse) {
      await tx.query(
        `UPDATE whatsapp_messages SET channel_id = $2, kind = $3, template_name = $4, body_redacted = $5,
                payload_redacted = $6, recipient_user_id = COALESCE($7, recipient_user_id)
          WHERE id = $1`,
        [
          msgId,
          ch.id,
          built.kind,
          built.templateName,
          built.bodyRedacted,
          JSON.stringify(built.payloadRedacted),
          recipient.recipient,
        ],
      );
    } else {
      await tx.query(
        `INSERT INTO whatsapp_messages (id, org_id, channel_id, direction, notification_id, customer_id, recipient_user_id,
                ticket_id, venue_id, event_id, kind, template_name, purpose, body_redacted, payload_redacted,
                status, status_rank, ordering_key, created_at, updated_at)
         VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'queued', 0, $7::uuid::text, $15, $15)`,
        [
          msgId,
          n.org_id,
          ch.id,
          n.id,
          customer.id,
          recipient.recipient,
          n.ticket_id,
          n.venue_id ?? ticket?.venue_id ?? null,
          ticket?.event_id ?? null,
          built.kind,
          built.templateName,
          n.purpose,
          built.bodyRedacted,
          JSON.stringify(built.payloadRedacted),
          now,
        ],
      );
    }
    const attemptNo = (
      await tx.one<{ n: number }>(
        `SELECT COALESCE(max(attempt_no), 0)::int + 1 AS n FROM notification_attempts WHERE notification_id = $1`,
        [n.id],
      )
    ).n;
    await tx.query(
      `INSERT INTO notification_attempts (notification_id, attempt_no, started_at) VALUES ($1, $2, $3)`,
      [n.id, attemptNo, now],
    );
    const counted = (
      await tx.one<{ attempts: number }>(
        `UPDATE notifications SET attempts = attempts + 1, next_attempt_at = NULL WHERE id = $1 RETURNING attempts`,
        [n.id],
      )
    ).attempts;
    pacer.take(nowMs, n.venue_id);
    return {
      kind: 'send',
      n,
      built,
      msgId,
      attemptNo,
      counted,
      sendKind,
      ticket,
      customerId: customer.id,
      eventId: ticket?.event_id ?? null,
    };
  }

  private async facts(
    tx: Tx,
    n: NotificationRow,
    c: CustomerFacts,
    t: TicketFacts | null,
  ): Promise<SendFacts> {
    const refs = this.payload;
    const cycle = refs.cycle_id
      ? await tx.maybeOne<{
          closed_at: Date | null;
          outcome: string | null;
          requested_early: boolean;
          newer_exists: boolean;
        }>(
          `SELECT c.closed_at, c.outcome, c.requested_early,
                  EXISTS (SELECT 1 FROM retrieval_cycles x WHERE x.ticket_id = c.ticket_id AND x.cycle_no > c.cycle_no) AS newer_exists
             FROM retrieval_cycles c WHERE c.id = $1`,
          [refs.cycle_id],
        )
      : null;
    const activeCycle = t?.active_cycle_id
      ? await tx.maybeOne<{ closed_at: Date | null; requested_early: boolean }>(
          `SELECT closed_at, requested_early FROM retrieval_cycles WHERE id = $1`,
          [t.active_cycle_id],
        )
      : null;
    let task: { status: string } | null = null;
    if (n.purpose === 'W-03') {
      task = n.task_id
        ? await tx.maybeOne<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [n.task_id])
        : refs.cycle_id
          ? await tx.maybeOne<{ status: string }>(
              `SELECT status FROM tasks WHERE cycle_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [refs.cycle_id],
            )
          : null;
    }
    const claim =
      n.purpose === 'W-05' && refs.claim_code_id
        ? await tx.maybeOne<{
            consumed_at: Date | null;
            revoked_at: Date | null;
            expires_at: Date;
            has_ciphertext: boolean;
          }>(
            `SELECT consumed_at, revoked_at, expires_at, code_ciphertext IS NOT NULL AS has_ciphertext FROM claim_codes WHERE id = $1`,
            [refs.claim_code_id],
          )
        : null;
    return {
      now: tx.now,
      purpose: n.purpose,
      kind: waTemplateById(n.purpose).kind,
      customer: {
        id: c.id,
        optedOut: c.wa_opted_out_at !== null,
        hasConsent: c.has_consent,
        lastInboundAt: c.last_inbound_at ? new Date(c.last_inbound_at) : null,
      },
      ticket: t
        ? {
            status: t.status,
            channel: t.channel,
            customerId: t.customer_id,
            waLinkStatus: t.wa_link_status,
            linkVersion: t.link_version,
            activeCycleId: t.active_cycle_id,
            pendingRetrievalAt: t.pending_retrieval_at ? new Date(t.pending_retrieval_at) : null,
          }
        : null,
      refs: {
        linkVersion: refs.link_version ?? null,
        cycleId: refs.cycle_id ?? null,
        claimCodeId: refs.claim_code_id ?? null,
        variant: refs.variant ?? null,
        early: refs.early ?? null,
      },
      cycle: cycle
        ? {
            closedAt: cycle.closed_at,
            outcome: cycle.outcome,
            requestedEarly: cycle.requested_early,
            newerExists: cycle.newer_exists,
          }
        : null,
      activeCycle: activeCycle
        ? { closedAt: activeCycle.closed_at, requestedEarly: activeCycle.requested_early }
        : null,
      task,
      claimCode: claim
        ? {
            consumedAt: claim.consumed_at,
            revokedAt: claim.revoked_at,
            expiresAt: new Date(claim.expires_at),
            hasCiphertext: claim.has_ciphertext,
          }
        : null,
    };
  }

  /**
   * Template parameters or session text of each purpose (14 §4). `code` is the decrypted handover code
   * (memory only) or the mask for a refused draft.
   */
  private async content(
    q: Pick<Tx, 'maybeOne'> | null,
    n: NotificationRow,
    sendKind: 'template' | 'session',
    t: TicketFacts | null,
    code: string | null,
  ): Promise<
    { kind: 'template'; params: string[] } | { kind: 'session'; text: string; contextWamid: string | null }
  > {
    const display = t ? String(t.display_number) : '';
    if (sendKind === 'template') {
      const params =
        n.purpose === 'W-01' && t
          ? [t.venue_name_ar, display, vehicleSummary(t)]
          : n.purpose === 'W-05'
            ? [display, code ?? '']
            : [display];
      return { kind: 'template', params };
    }
    let text: string;
    switch (n.purpose) {
      case 'W-05': // 12 §8.4 fallback: the same content as a session text
        text = renderWaText(waMessageText('W-05'), [display, code ?? '']);
        break;
      case 'W-09': {
        const variant =
          this.payload.variant === 'inactive' || !t
            ? 'inactive'
            : (w09VariantFor({ status: t.status, pendingRetrievalAt: t.pending_retrieval_at }) ?? 'inactive');
        text = renderWaText(waMessageText('W-09', variant), [display]);
        break;
      }
      case 'W-11':
        text = waMessageText('W-11', this.payload.variant === 'received' ? 'received' : 'invalid');
        break;
      default:
        text = waMessageText(n.purpose);
    }
    const contextWamid =
      q && this.payload.inbound_message_id
        ? ((
            await q.maybeOne<{ wa_message_id: string | null }>(
              `SELECT wa_message_id FROM whatsapp_messages WHERE id = $1`,
              [this.payload.inbound_message_id],
            )
          )?.wa_message_id ?? null)
        : null;
    return { kind: 'session', text, contextWamid };
  }

  /** The masked text of a message refused before the provider (no code decrypted, no token issued). */
  private async draft(
    n: NotificationRow,
    customerId: string,
    t: TicketFacts | null,
    sendKind: 'template' | 'session',
  ): Promise<MessageDraft> {
    const def = waTemplateById(n.purpose);
    const c = await this.content(null, n, sendKind, t, n.purpose === 'W-05' ? CODE_MASK : null);
    return {
      kind: c.kind === 'template' ? 'template' : 'session_text',
      templateName: c.kind === 'template' ? def.name : null,
      bodyRedacted: c.kind === 'template' ? renderWaText(def.body_ar, c.params) : c.text,
      customerId,
      ticket: t,
    };
  }

  private async skip(tx: Tx, n: NotificationRow, reason: NotificationSkippedReason): Promise<Prepared> {
    await tx.query(
      `UPDATE notifications SET status = 'skipped', skipped_reason = $2, next_attempt_at = NULL WHERE id = $1 AND status = 'pending'`,
      [n.id, reason],
    );
    await tx.query(
      `UPDATE whatsapp_messages SET status = 'skipped' WHERE notification_id = $1 AND direction = 'outbound'
          AND wa_message_id IS NULL AND status = 'queued'`,
      [n.id],
    );
    await this.purgeCode(tx, n);
    metrics.waSkipped.inc({ reason });
    this.ctx.logger.info(
      { notification_id: n.id, purpose: n.purpose, reason },
      'whatsapp notification skipped',
    );
    return { kind: 'done' };
  }

  /** 12 §5.10.4: the encrypted copy goes once nothing will send it any more. */
  private async purgeCode(tx: Tx, n: NotificationRow): Promise<void> {
    if (n.purpose !== 'W-05' || !this.payload.claim_code_id) return;
    await tx.query(
      `UPDATE claim_codes SET code_ciphertext = NULL WHERE id = $1 AND code_ciphertext IS NOT NULL`,
      [this.payload.claim_code_id],
    );
  }

  private async afterFinal(n: NotificationRow): Promise<void> {
    if (n.purpose === 'W-05' && this.payload.claim_code_id)
      await this.db.query(
        `UPDATE claim_codes SET code_ciphertext = NULL WHERE id = $1 AND code_ciphertext IS NOT NULL`,
        [this.payload.claim_code_id],
      );
  }

  // ---------------------------------------------------------------------------------------------
  // The call and its outcome (12 §5.9, §5.12)
  // ---------------------------------------------------------------------------------------------

  private async send(ch: ChannelRow, token: string, s: WaSettings, r: Reservation): Promise<void> {
    await this.ctx.renewLease();
    const res = await this.rt.graph.sendMessage(ch, token, r.built.request);
    r.built.request = {}; // the code and the action token are forgotten here
    if (res.ok) {
      const body = res.body as GraphSendResponse;
      const wamid = body.messages?.[0]?.id;
      if (wamid) {
        // 17 H-03 KP-4: accepted by the provider, nothing recorded yet — the status webhooks (matched by
        // biz_opaque_callback_data) or the CRASH_WAIT_MS retry decide; one duplicate at most (TC-016)
        killPoint('wa_send_after_provider_ok_before_done');
        const contact = body.contacts?.[0];
        await this.db.transaction((tx) =>
          this.recordAccepted(
            tx,
            ch,
            r.n,
            r.msgId,
            wamid,
            r.attemptNo,
            res.status,
            contact?.wa_id ?? null,
            contact?.user_id ?? null,
          ),
        );
        return;
      }
    }
    const failure: GraphFailure = res.ok
      ? { kind: 'http', status: res.status, code: null, message: 'accepted without a message id' }
      : res;
    const c: WaErrorClassification = res.ok
      ? {
          cls: 'temporary',
          retryable: true,
          channel: null,
          internalCode: 'WA_SEND_FAILED',
          templateStatus: null,
          providerCode: 'no_message_id',
        }
      : classifyGraphFailure(failure);
    const next = await this.db.transaction((tx) => this.recordFailure(tx, ch, s, r, failure, c));
    if (next.kind === 'retry')
      throw new RetryableJobError(`whatsapp send retry (${c.providerCode})`, next.delayMs);
    if (next.kind === 'defer') return this.defer(r.n.id, next.delayMs, 'channel_down');
  }

  /** Locks the ticket (L5) before the notification (L9) for outcome transactions (canon §14ب). */
  private async lockForOutcome(tx: Tx, n: NotificationRow): Promise<NotificationRow | null> {
    if (n.ticket_id) await lockTickets(tx, [n.ticket_id]);
    const fresh = await tx.maybeOne<NotificationRow>(
      `SELECT * FROM notifications WHERE id = $1 FOR NO KEY UPDATE`,
      [n.id],
    );
    return fresh && fresh.status === 'pending' ? fresh : null;
  }

  private async recordAccepted(
    tx: Tx,
    ch: ChannelRow,
    n0: NotificationRow,
    msgId: string,
    wamid: string,
    attemptNo: number | null,
    httpStatus: number | null,
    contactWaId: string | null,
    contactUserId: string | null,
  ): Promise<void> {
    const n = await this.lockForOutcome(tx, n0);
    if (!n) return;
    if (n.purpose === 'W-01' && n.ticket_id) {
      await w01OutcomeHandler()(tx, {
        ticketId: n.ticket_id,
        notificationId: n.id,
        linkVersion: this.payload.link_version ?? null,
        outcome: 'accepted',
        errorCode: null,
        action: 'job.wa_send',
      });
    }
    await tx.query(
      `UPDATE whatsapp_messages SET wa_message_id = COALESCE(wa_message_id, $2), recipient_wa_id = COALESCE($3, recipient_wa_id),
              recipient_user_id = COALESCE(recipient_user_id, $4), queued_at = COALESCE(queued_at, $5)
        WHERE id = $1`,
      [msgId, wamid, contactWaId, contactUserId, tx.now],
    );
    if (attemptNo !== null)
      await tx.query(
        `UPDATE notification_attempts SET finished_at = $3, outcome = 'success', http_status = $4
          WHERE notification_id = $1 AND attempt_no = $2 AND finished_at IS NULL`,
        [n.id, attemptNo, tx.now, httpStatus],
      );
    await tx.query(
      `UPDATE notifications SET status = 'sent', sent_at = $2, last_error_code = NULL, last_error_message = NULL, next_attempt_at = NULL
        WHERE id = $1 AND status = 'pending'`,
      [n.id, tx.now],
    );
    if (contactWaId)
      await tx.query(
        `UPDATE customers c SET wa_id = $2 WHERE c.id = $1 AND c.wa_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.org_id = c.org_id AND o.wa_id = $2)`,
        [n.recipient_customer_id, contactWaId],
      );
    if (n.purpose === 'W-05' && this.payload.claim_code_id)
      await tx.query(`UPDATE claim_codes SET code_ciphertext = NULL, sent_message_id = $2 WHERE id = $1`, [
        this.payload.claim_code_id,
        msgId,
      ]);
    await this.recoverHealth(tx, ch);
    await this.webhookSilentCheck(tx, n.org_id);
    metrics.waSend.inc({ outcome: 'success', error_code: '' });
    metrics.waSendDuration.observe(Math.max(0, (tx.now.getTime() - new Date(n.created_at).getTime()) / 1000));
    this.ctx.logger.info(
      { notification_id: n.id, purpose: n.purpose, whatsapp_message_id: msgId },
      'whatsapp message accepted',
    );
  }

  private async recordFailure(
    tx: Tx,
    ch: ChannelRow,
    s: WaSettings,
    r: Reservation,
    f: GraphFailure,
    c: WaErrorClassification,
  ): Promise<{ kind: 'retry' | 'defer'; delayMs: number } | { kind: 'final' }> {
    type Verdict =
      | { kind: 'defer' }
      | { kind: 'skip'; reason: NotificationSkippedReason }
      | { kind: 'retry'; delayMs: number }
      | { kind: 'fail'; exhausted: boolean };
    const verdict: Verdict =
      c.cls === 'channel'
        ? r.sendKind === 'session'
          ? { kind: 'skip', reason: 'channel_down' }
          : { kind: 'defer' }
        : c.cls === 'outside_window' && r.sendKind === 'session'
          ? { kind: 'skip', reason: 'stale' }
          : c.retryable
            ? r.counted >= s.send_max_attempts
              ? { kind: 'fail', exhausted: true }
              : { kind: 'retry', delayMs: sendRetryDelayMs(r.counted) }
            : { kind: 'fail', exhausted: false };
    const message = sanitizeProviderMessage(f.message);
    const n = await this.lockForOutcome(tx, r.n);
    await tx.query(
      `UPDATE notification_attempts SET finished_at = $3, outcome = $4, http_status = $5, provider_error_code = $6, provider_error_message = $7
        WHERE notification_id = $1 AND attempt_no = $2`,
      [
        r.n.id,
        r.attemptNo,
        tx.now,
        verdict.kind === 'fail' && !verdict.exhausted ? 'permanent_error' : 'retryable_error',
        f.status,
        c.providerCode,
        message,
      ],
    );
    metrics.waSend.inc({
      outcome: verdict.kind === 'fail' && !verdict.exhausted ? 'permanent_error' : 'retryable_error',
      error_code: c.providerCode,
    });
    if (!n) return { kind: 'final' }; // finalized meanwhile (a status webhook)
    const log = { notification_id: n.id, purpose: n.purpose, provider_error: c.providerCode, class: c.cls };

    if (c.cls === 'throughput') this.rt.pacer(ch.id).throttle(this.nowMs());
    if (c.channel === 'down') {
      this.rt.probes.set(ch.id, { at: this.nowMs(), ok: false, quality: null });
      await setChannelHealth(tx, ch.id, 'down', `send_${c.providerCode}`, 'job.wa_send');
    } else if (c.channel === 'degraded' && c.cls !== 'template') {
      await setChannelHealth(tx, ch.id, 'degraded', `send_${c.providerCode}`, 'job.wa_send');
    }

    switch (verdict.kind) {
      case 'defer':
        // channel errors stop sending; the notification stays pending and the attempt does not count (12 §5.9)
        await tx.query(
          `UPDATE notifications SET attempts = GREATEST(attempts - 1, 0), last_error_code = $2, last_error_message = $3,
                  next_attempt_at = $4 WHERE id = $1`,
          [
            n.id,
            c.internalCode,
            `provider ${c.providerCode}`,
            new Date(tx.now.getTime() + CHANNEL_DOWN_DEFER_MS),
          ],
        );
        this.ctx.logger.error(log, 'whatsapp channel error: sending stopped until the channel is healthy');
        return { kind: 'defer', delayMs: CHANNEL_DOWN_DEFER_MS };
      case 'skip':
        await this.skip(tx, n, verdict.reason);
        return { kind: 'final' };
      case 'retry':
        await tx.query(
          `UPDATE notifications SET last_error_code = $2, last_error_message = $3, next_attempt_at = $4 WHERE id = $1`,
          [n.id, c.internalCode, `provider ${c.providerCode}`, new Date(tx.now.getTime() + verdict.delayMs)],
        );
        if (c.cls !== 'pair_limit') await this.temporaryHealthRules(tx, ch, n.org_id);
        this.ctx.logger.warn({ ...log, retry_in_ms: verdict.delayMs }, 'whatsapp send will be retried');
        return { kind: 'retry', delayMs: verdict.delayMs };
      case 'fail':
        if (c.cls === 'template' && c.templateStatus) {
          const def = waTemplateById(n.purpose);
          await tx.query(
            `UPDATE whatsapp_templates SET status = $3, version = version + 1, last_synced_at = $4
              WHERE org_id = $1 AND name = $2 AND language = 'ar' AND status IS DISTINCT FROM $3`,
            [n.org_id, def.name, c.templateStatus, tx.now],
          );
          await setChannelHealth(
            tx,
            ch.id,
            'degraded',
            `template_${def.name}_${c.templateStatus}`,
            'job.wa_send',
          );
        }
        if (verdict.exhausted) await this.temporaryHealthRules(tx, ch, n.org_id);
        await this.finalFailure(tx, n, {
          internalCode: c.internalCode,
          providerCode: c.providerCode,
          reason: verdict.exhausted ? 'attempts_exhausted' : c.cls,
          message: message ?? `provider ${c.providerCode}`,
          alert: true,
          msgId: r.msgId,
        });
        if (c.cls === 'programming' || c.cls === 'template' || c.cls === 'outside_window')
          this.ctx.logger.error(log, 'whatsapp send refused permanently');
        else this.ctx.logger.warn(log, 'whatsapp send failed permanently');
        return { kind: 'final' };
    }
  }

  /** Permanent failure decided before the provider call (template gate, allowlist, unreadable code). */
  private async failBeforeSend(
    tx: Tx,
    ch: ChannelRow,
    n0: NotificationRow,
    failure: GateFailure,
    draft: MessageDraft | null,
  ): Promise<void> {
    const n = await this.lockForOutcome(tx, n0);
    if (!n) return;
    let msgId: string | null = null;
    if (draft) {
      msgId = newId();
      await tx.query(
        `INSERT INTO whatsapp_messages (id, org_id, channel_id, direction, notification_id, customer_id, ticket_id, venue_id, event_id,
                kind, template_name, purpose, body_redacted, payload_redacted, status, status_rank, ordering_key, created_at, updated_at)
         VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, '{}'::jsonb, 'queued', 0, $6::uuid::text, $13, $13)`,
        [
          msgId,
          n.org_id,
          ch.id,
          n.id,
          draft.customerId,
          n.ticket_id,
          n.venue_id ?? draft.ticket?.venue_id ?? null,
          draft.ticket?.event_id ?? null,
          draft.kind,
          draft.templateName,
          n.purpose,
          draft.bodyRedacted,
          tx.now,
        ],
      );
    }
    metrics.waSend.inc({ outcome: 'permanent_error', error_code: failure.internalCode });
    await this.finalFailure(tx, n, {
      internalCode: failure.internalCode,
      providerCode: null,
      reason: failure.reason,
      message: failure.message,
      alert: failure.alert,
      msgId,
    });
    this.ctx.logger.error(
      { notification_id: n.id, purpose: n.purpose, reason: failure.reason, error_code: failure.internalCode },
      'whatsapp notification refused before sending',
    );
  }

  /** `failed` + W-01 outcome + message row + `wa_send_failed` (12 §5.9); the ticket and notification are locked. */
  private async finalFailure(
    tx: Tx,
    n: NotificationRow,
    f: {
      internalCode: ErrorCode;
      providerCode: string | null;
      reason: string;
      message: string;
      alert: boolean;
      msgId: string | null;
    },
  ): Promise<void> {
    if (n.purpose === 'W-01' && n.ticket_id) {
      await w01OutcomeHandler()(tx, {
        ticketId: n.ticket_id,
        notificationId: n.id,
        linkVersion: this.payload.link_version ?? null,
        outcome: 'failed',
        errorCode: f.providerCode ?? f.internalCode,
        action: 'job.wa_send',
      });
    }
    await tx.query(
      `UPDATE notifications SET status = 'failed', failed_at = $2, last_error_code = $3, last_error_message = $4, next_attempt_at = NULL
        WHERE id = $1 AND status = 'pending'`,
      [n.id, tx.now, f.internalCode, f.message.slice(0, 300)],
    );
    await this.purgeCode(tx, n);
    if (f.msgId) {
      const row = await tx.maybeOne<{
        id: string;
        org_id: string;
        notification_id: string | null;
        ticket_id: string | null;
        venue_id: string | null;
        event_id: string | null;
        purpose: string | null;
        status_rank: number;
      }>(
        `UPDATE whatsapp_messages SET status = 'failed', failed_at = $2, error_code = $3, error_title = $4,
                error_details = $5
          WHERE id = $1 AND status = 'queued'
          RETURNING id, org_id, notification_id, ticket_id, venue_id, event_id, purpose, status_rank`,
        [
          f.msgId,
          tx.now,
          f.providerCode ?? f.internalCode,
          f.message.slice(0, 200),
          JSON.stringify({ internal_code: f.internalCode, reason: f.reason }),
        ],
      );
      if (row)
        await recordMessageStatusChange(tx, row, 'failed', row.status_rank, f.providerCode ?? f.internalCode);
    }
    const venueId = n.venue_id;
    if (f.alert && n.ticket_id && venueId) {
      const t = await tx.maybeOne<{ event_id: string }>(`SELECT event_id FROM tickets WHERE id = $1`, [
        n.ticket_id,
      ]);
      await raiseAlert(tx, {
        orgId: n.org_id,
        venueId,
        type: 'wa_send_failed',
        dedupeKey: `wa_send_failed:${n.ticket_id}:${n.purpose}`,
        ticketId: n.ticket_id,
        eventId: t?.event_id ?? null,
        details: {
          purpose: n.purpose,
          notification_id: n.id,
          error_code: f.internalCode,
          provider_error_code: f.providerCode,
          reason: f.reason,
        },
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Channel health (12 §5.14) and the webhook silence check (14 §8)
  // ---------------------------------------------------------------------------------------------

  /** GET /{phone_number_id}; the result is kept per process for a minute. */
  private async probe(ch: ChannelRow, token: string): Promise<boolean> {
    const res = await this.rt.graph.phoneNumber(ch, token);
    const ok = res.ok && res.body.health_status?.can_send_message !== 'BLOCKED';
    const quality = res.ok ? (res.body.quality_rating ?? null) : null;
    this.rt.probes.set(ch.id, { at: this.nowMs(), ok, quality });
    this.ctx.logger.info({ channel_id: ch.id, ok, quality }, 'whatsapp channel probe');
    return ok;
  }

  private async probeIfStale(ch: ChannelRow, token: string): Promise<void> {
    const p = this.rt.probes.get(ch.id);
    if (!p || this.nowMs() - p.at >= PROBE_INTERVAL_MS) await this.probe(ch, token);
  }

  /** down/degraded → healthy after a good probe and a real accepted send (12 §5.14). */
  private async recoverHealth(tx: Tx, ch: ChannelRow): Promise<void> {
    const cur = await tx.maybeOne<{ health_status: string }>(
      `SELECT health_status FROM whatsapp_channel WHERE id = $1`,
      [ch.id],
    );
    if (!cur || cur.health_status === 'healthy') return;
    const p = this.rt.probes.get(ch.id);
    if (!p?.ok || this.nowMs() - p.at >= 2 * PROBE_INTERVAL_MS) return;
    if (cur.health_status === 'degraded') {
      if (p.quality === 'YELLOW' || p.quality === 'RED') return;
      const approved = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM whatsapp_templates
          WHERE org_id = $1 AND language = 'ar' AND name = ANY($2::text[]) AND status = 'approved' AND category = 'UTILITY'`,
        [ch.org_id, [...WA_TEMPLATE_NAMES]],
      );
      if (approved.n < WA_TEMPLATE_NAMES.length) return;
    }
    await setChannelHealth(tx, ch.id, 'healthy', 'probe_and_send_ok', 'job.wa_send');
  }

  /** Temporary error rate > 20 % in 5 min → degraded; every attempt failing for 2 min → down. */
  private async temporaryHealthRules(tx: Tx, ch: ChannelRow, orgId: string): Promise<void> {
    const now = tx.now.getTime();
    const s = await tx.one<{ total: number; temporary: number; last_success: Date | null }>(
      `SELECT count(*) FILTER (WHERE a.started_at > $2)::int AS total,
              count(*) FILTER (WHERE a.started_at > $2 AND a.outcome = 'retryable_error')::int AS temporary,
              max(a.started_at) FILTER (WHERE a.outcome = 'success') AS last_success
         FROM notification_attempts a JOIN notifications n ON n.id = a.notification_id
        WHERE n.org_id = $1 AND n.channel = 'whatsapp' AND a.started_at > $3 AND a.finished_at IS NOT NULL
          AND a.provider_error_code IS DISTINCT FROM '131056'`,
      [orgId, new Date(now - 5 * 60_000), new Date(now - 15 * 60_000)],
    );
    const first = await tx.one<{ first: Date | null }>(
      `SELECT min(a.started_at) AS first
         FROM notification_attempts a JOIN notifications n ON n.id = a.notification_id
        WHERE n.org_id = $1 AND n.channel = 'whatsapp' AND a.outcome = 'retryable_error' AND a.started_at > $2
          AND a.provider_error_code IS DISTINCT FROM '131056'`,
      [orgId, s.last_success ?? new Date(now - 15 * 60_000)],
    );
    if (failingStreakExceeded(first.first ? new Date(first.first) : null, tx.now))
      await setChannelHealth(tx, ch.id, 'down', 'temporary_errors_2min', 'job.wa_send');
    else if (temporaryErrorRateExceeded(s.total, s.temporary))
      await setChannelHealth(tx, ch.id, 'degraded', 'temporary_error_rate', 'job.wa_send');
  }

  /** `wa_webhook_silent:{venue_id}` (14 §8): sends accepted 10+ minutes ago and no webhook since. */
  private async webhookSilentCheck(tx: Tx, orgId: string): Promise<void> {
    const now = tx.now.getTime();
    if (Math.abs(now - this.rt.lastSilentCheckAt) < 60_000) return;
    this.rt.lastSilentCheckAt = now;
    const dayAgo = new Date(now - 24 * 3_600_000);
    const last = await tx.one<{ at: Date | null }>(
      `SELECT max(received_at) AS at FROM whatsapp_inbound_events WHERE org_id = $1 AND received_at > $2`,
      [orgId, dayAgo],
    );
    const from = last.at ? new Date(last.at) : dayAgo;
    if (now - from.getTime() < WEBHOOK_SILENT_MS) return;
    const unanswered = await tx.maybeOne<{ one: number }>(
      `SELECT 1 AS one FROM whatsapp_messages WHERE org_id = $1 AND direction = 'outbound'
          AND queued_at > $2 AND queued_at <= $3 LIMIT 1`,
      [orgId, from, new Date(now - WEBHOOK_SILENT_MS)],
    );
    if (!unanswered) return;
    const venues = await tx.rows<{ venue_id: string }>(
      `SELECT DISTINCT venue_id FROM events WHERE org_id = $1 AND status IN ('open','closing') ORDER BY venue_id`,
      [orgId],
    );
    for (const v of venues)
      await raiseAlert(tx, {
        orgId,
        venueId: v.venue_id,
        type: 'wa_webhook_silent',
        dedupeKey: `wa_webhook_silent:${v.venue_id}`,
        details: { last_webhook_at: isoOrNull(last.at), silent_since: from.toISOString() },
      });
    if (venues.length)
      this.ctx.logger.error({ last_webhook_at: isoOrNull(last.at) }, 'whatsapp webhooks silent');
  }

  // ---------------------------------------------------------------------------------------------

  /** Waiting is not an attempt: the outbox attempt is given back (12 §5.3 «defer»). */
  private async defer(notificationId: string, ms: number, reason: string): Promise<never> {
    const delay = Math.max(1, Math.ceil(ms));
    await this.db.query(
      `UPDATE outbox_events SET attempts = GREATEST(attempts - 1, 0) WHERE id = $1 AND status = 'processing'`,
      [this.ctx.row.id],
    );
    this.ctx.row.attempts = Math.max(0, this.ctx.row.attempts - 1);
    await this.db.query(
      `UPDATE notifications SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`,
      [notificationId, new Date(this.nowMs() + delay)],
    );
    throw new RetryableJobError(`deferred: ${reason}`, delay);
  }
}

/** `job.wa_send` handler (mode external: the Graph call is never inside a transaction). */
export function waSendHandler(runtime: () => WhatsappRuntime): JobHandler {
  return {
    type: 'job.wa_send',
    mode: 'external',
    async handle(ctx) {
      // 17 H-03 KP-3: the outbox row is leased (`processing`, locked_until) and nothing else happened (TC-015)
      killPoint('outbox_after_lock_before_send');
      await new WhatsappSender(runtime(), ctx).run();
    },
  };
}
