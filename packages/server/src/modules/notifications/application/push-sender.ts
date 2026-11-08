import {
  PushPayloadSchema,
  pushTopic,
  PUSH_URGENCY,
  type PushClosedVariant,
  type PushNotificationType,
} from '@point/shared';
import { autoResolveAlerts, raiseAlert } from '../../../core/alerts/alerts.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { RetryableJobError, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { orgSettings } from '../../../core/settings/settings-service.js';
import {
  buildPushPayload,
  classifyPushResponse,
  nextPushAttemptDelay,
  pushDeadline,
  pushErrorCode,
  pushTtlSeconds,
} from '../domain/push-payload.js';
import type { PushRuntime } from '../infra/push-runtime.js';
import type { PushSendRequest, PushSendResult } from '../infra/push-transport.js';
import { REPLACEABLE_KINDS, roundPushKeys } from './push-planner.js';

/** A quiet replacement waits this long for the request push it replaces, if that one is in flight. */
const REPLACE_WAIT_MS = 2_000;
const IN_FLIGHT_MS = 60_000;
const REPLACE_GIVE_UP_MS = 120_000;

export const pushFailedDedupeKey = (deviceId: string) => `push_failed_repeatedly:${deviceId}`;

interface NotificationRow {
  id: string;
  org_id: string;
  channel: string;
  purpose: string;
  status: string;
  recipient_user_id: string | null;
  recipient_device_id: string | null;
  venue_id: string | null;
  ticket_id: string | null;
  task_id: string | null;
  attempts: number;
  created_at: Date;
}

interface DeviceRow {
  id: string;
  org_id: string;
  user_id: string;
  push_endpoint: string | null;
  push_p256dh: string | null;
  push_auth: string | null;
  notification_permission: string;
  revoked_at: Date | null;
  user_status: string;
  has_session: boolean;
}

interface JobPayload {
  notification_id?: string;
  offer_id?: string;
  variant?: PushClosedVariant;
  alert_id?: string;
}

type Prepared =
  | { kind: 'done' }
  | { kind: 'wait'; delayMs: number }
  | {
      kind: 'send';
      n: NotificationRow;
      attemptNo: number;
      deadline: Date;
      request: PushSendRequest;
      deviceId: string;
      userId: string;
      orgId: string;
      offerId: string | null;
      pushKind: PushNotificationType;
    };

async function skip(
  tx: Tx,
  id: string,
  reason: 'stale' | 'superseded' | 'no_subscription',
): Promise<Prepared> {
  await tx.query(
    `UPDATE notifications SET status = 'skipped', skipped_reason = $2, next_attempt_at = NULL, updated_at = $3 WHERE id = $1`,
    [id, reason, tx.now],
  );
  metrics.pushSend.inc({ outcome: 'skipped' });
  return { kind: 'done' };
}

async function fail(tx: Tx, id: string, code: string, message: string): Promise<void> {
  await tx.query(
    `UPDATE notifications SET status = 'failed', failed_at = $2, next_attempt_at = NULL,
            last_error_code = $3, last_error_message = $4, updated_at = $2
      WHERE id = $1 AND status = 'pending'`,
    [id, tx.now, code, message],
  );
}

interface OfferRow {
  id: string;
  task_id: string;
  mode: 'single' | 'broadcast';
  round_no: number;
  status: string;
  expires_at: Date | null;
}

/**
 * Fresh read and send-time rules (11 §1.6, §8.11 `job.push_send`): a request push only while its round,
 * task or alert is live; a quiet replacement only over a request push that was sent (waiting a moment for
 * one in flight) and only while no newer request for the task was pushed to the device.
 */
async function prepare(tx: Tx, rt: PushRuntime, job: JobPayload): Promise<Prepared> {
  const n = await tx.maybeOne<NotificationRow>(
    `SELECT id, org_id, channel, purpose, status, recipient_user_id, recipient_device_id, venue_id, ticket_id, task_id,
            attempts, created_at
       FROM notifications WHERE id = $1 FOR NO KEY UPDATE`,
    [job.notification_id],
  );
  if (!n || n.channel !== 'push' || n.status !== 'pending' || !n.recipient_device_id) return { kind: 'done' };
  const kind = n.purpose as PushNotificationType;

  const d = await tx.maybeOne<DeviceRow>(
    `SELECT d.id, d.org_id, d.user_id, d.push_endpoint, d.push_p256dh, d.push_auth, d.notification_permission,
            d.revoked_at, u.status AS user_status,
            EXISTS (SELECT 1 FROM auth_sessions s WHERE s.device_id = d.id AND s.user_id = d.user_id
                     AND s.revoked_at IS NULL AND s.expires_at > $2) AS has_session
       FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [n.recipient_device_id, tx.now],
  );
  if (
    !d ||
    d.revoked_at ||
    d.notification_permission !== 'granted' ||
    !d.push_endpoint ||
    !d.push_p256dh ||
    !d.push_auth ||
    d.user_status !== 'active' ||
    !d.has_session
  )
    return skip(tx, n.id, 'no_subscription');

  const offer = job.offer_id
    ? await tx.maybeOne<OfferRow>(
        `SELECT id, task_id, mode, round_no, status, expires_at FROM task_offers WHERE id = $1`,
        [job.offer_id],
      )
    : null;
  let alertType: string | null = null;

  switch (kind) {
    case 'offer':
    case 'broadcast':
    case 'reminder': {
      const r = offer
        ? await tx.maybeOne<{ seen_at: Date | null }>(
            `SELECT seen_at FROM offer_recipients WHERE offer_id = $1 AND user_id = $2`,
            [offer.id, d.user_id],
          )
        : null;
      const live =
        !!offer &&
        !!r &&
        offer.status === 'active' &&
        (kind !== 'offer' || (offer.mode === 'single' && !!offer.expires_at && offer.expires_at > tx.now));
      if (!live) return skip(tx, n.id, 'stale');
      if (kind === 'reminder' && r!.seen_at) return skip(tx, n.id, 'superseded'); // the card was seen (14 §10)
      break;
    }
    case 'next_due': {
      const t = await tx.maybeOne<{ status: string; assignee_id: string | null }>(
        `SELECT status, assignee_id FROM tasks WHERE id = $1`,
        [n.task_id],
      );
      if (!t || t.assignee_id !== d.user_id || (t.status !== 'accepted' && t.status !== 'in_progress'))
        return skip(tx, n.id, 'stale');
      break;
    }
    case 'escalation': {
      const a = await tx.maybeOne<{ status: string; type: string }>(
        `SELECT status, type FROM alerts WHERE id = $1`,
        [job.alert_id],
      );
      if (!a || a.status !== 'open') return skip(tx, n.id, 'stale'); // acknowledged or resolved meanwhile
      alertType = a.type;
      break;
    }
    case 'closed': {
      const variant = job.variant ?? 'ended';
      if (variant === 'claimed' || variant === 'ended') {
        if (!offer || !n.task_id) return skip(tx, n.id, 'stale');
        // a newer round already pushed to this device replaces the request: nothing to quiet
        const later = await tx.rows<{ round_no: number }>(
          `SELECT round_no FROM task_offers WHERE task_id = $1 AND round_no > $2`,
          [n.task_id, offer.round_no],
        );
        if (later.length) {
          const newer = await tx.maybeOne(
            `SELECT 1 AS one FROM notifications WHERE dedupe_key = ANY($1::text[]) AND status IN ('pending','sent') LIMIT 1`,
            [later.flatMap((l) => roundPushKeys(n.task_id!, l.round_no, d.id))],
          );
          if (newer) return skip(tx, n.id, 'superseded');
        }
        // the request push of this round: lock it first, so a job still preparing it commits its attempt;
        // the next statement (a new READ COMMITTED snapshot) then sees that attempt
        const keys = roundPushKeys(n.task_id, offer.round_no, d.id);
        await tx.query(
          `SELECT id FROM notifications WHERE dedupe_key = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`,
          [keys],
        );
        const shown = await tx.rows<{ id: string; status: string; in_flight: boolean }>(
          `SELECT n.id, n.status,
                  EXISTS (SELECT 1 FROM notification_attempts a WHERE a.notification_id = n.id
                           AND a.finished_at IS NULL AND a.started_at > $2) AS in_flight
             FROM notifications n WHERE n.dedupe_key = ANY($1::text[])`,
          [keys, new Date(tx.now.getTime() - IN_FLIGHT_MS)],
        );
        if (!shown.some((s) => s.status === 'sent')) {
          const waiting = shown.some((s) => s.status === 'pending' && s.in_flight);
          if (waiting && tx.now.getTime() - new Date(n.created_at).getTime() < REPLACE_GIVE_UP_MS)
            return { kind: 'wait', delayMs: REPLACE_WAIT_MS };
          return skip(tx, n.id, 'stale'); // nothing was shown under the tag
        }
      } else if (variant === 'withdrawn') {
        // the task came back to the same driver: his new task notification is the current one
        const t = await tx.maybeOne<{ status: string; assignee_id: string | null }>(
          `SELECT status, assignee_id FROM tasks WHERE id = $1`,
          [n.task_id],
        );
        if (
          t &&
          t.assignee_id === d.user_id &&
          ['accepted', 'assigned_waiting', 'in_progress'].includes(t.status)
        )
          return skip(tx, n.id, 'superseded');
      }
      break;
    }
  }

  const ticket = n.ticket_id
    ? await tx.maybeOne<{ display_number: number }>(`SELECT display_number FROM tickets WHERE id = $1`, [
        n.ticket_id,
      ])
    : null;
  if (kind !== 'escalation' && (!ticket || !n.task_id)) return skip(tx, n.id, 'stale');

  const offerExpiresAt = offer?.mode === 'single' && offer.expires_at ? new Date(offer.expires_at) : null;
  const deadline = pushDeadline(kind, new Date(n.created_at), offerExpiresAt);
  const ttlSeconds = pushTtlSeconds(kind, deadline, tx.now);
  if (ttlSeconds <= 0) {
    if (n.attempts === 0) return skip(tx, n.id, 'stale');
    await fail(tx, n.id, 'ttl_exceeded', 'push window elapsed before a successful attempt');
    metrics.pushSend.inc({ outcome: 'permanent' });
    return { kind: 'done' };
  }

  const payload = PushPayloadSchema.parse(
    buildPushPayload({
      kind,
      variant: job.variant ?? null,
      staffBrandAr: rt.staffBrandAr,
      ticketNo: ticket?.display_number ?? null,
      taskId: n.task_id,
      offerId: offer?.id ?? null,
      alertId: job.alert_id ?? null,
      alertType,
      offerExpiresAt,
      now: tx.now,
    }),
  );
  const attemptNo = n.attempts + 1;
  await tx.query(
    `INSERT INTO notification_attempts (notification_id, attempt_no, started_at) VALUES ($1, $2, $3)`,
    [n.id, attemptNo, tx.now],
  );
  await tx.query(
    `UPDATE notifications SET attempts = $2, next_attempt_at = NULL, updated_at = $3 WHERE id = $1`,
    [n.id, attemptNo, tx.now],
  );
  return {
    kind: 'send',
    n,
    attemptNo,
    deadline,
    deviceId: d.id,
    userId: d.user_id,
    orgId: n.org_id,
    offerId: offer?.id ?? null,
    pushKind: kind,
    request: {
      endpoint: d.push_endpoint,
      p256dh: d.push_p256dh,
      auth: d.push_auth,
      payload: JSON.stringify(payload),
      ttlSeconds,
      urgency: PUSH_URGENCY,
      topic: pushTopic(kind === 'escalation' ? job.alert_id! : n.task_id!),
    },
  };
}

/** The venue an alert about the user's device belongs to: his open duty session, else his assignment. */
async function deviceVenue(tx: Tx, userId: string): Promise<string | null> {
  const r = await tx.maybeOne<{ venue_id: string }>(
    `SELECT venue_id FROM (
        SELECT venue_id, 0 AS rank FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'
        UNION ALL
        SELECT venue_id, 1 FROM driver_assignments WHERE driver_id = $1 AND status = 'active') v
      ORDER BY rank LIMIT 1`,
    [userId],
  );
  return r?.venue_id ?? null;
}

const MESSAGES: Record<string, string> = {
  gone: 'push subscription expired or unsubscribed',
  retryable: 'push service unavailable or rate limited',
  permanent: 'push service rejected the request',
};

/**
 * Records the outcome (14 §6.6): 2xx resets the device's consecutive failures; 404/410 clears the
 * subscription; 429/5xx/network are retried within the TTL; `push.max_consecutive_failures` consecutive
 * failures raise `push_failed_repeatedly` (info) for the device user's venue. Returns the retry delay.
 */
async function record(
  tx: Tx,
  p: Extract<Prepared, { kind: 'send' }>,
  result: PushSendResult,
): Promise<number | null> {
  const cls = classifyPushResponse(result);
  const code = pushErrorCode(result);
  metrics.pushSend.inc({ outcome: cls });
  if (cls === 'success' && p.offerId && REPLACEABLE_KINDS.includes(p.pushKind)) {
    // descriptive column (10 §2: no version bump), first in the transaction (L7 before L9)
    await tx.query(
      `UPDATE offer_recipients SET notified_push_at = COALESCE(notified_push_at, $3) WHERE offer_id = $1 AND user_id = $2`,
      [p.offerId, p.userId, tx.now],
    );
  }
  await tx.query(
    `UPDATE notification_attempts SET finished_at = $3, outcome = $4, http_status = $5, provider_error_code = $6,
            provider_error_message = $7
      WHERE notification_id = $1 AND attempt_no = $2`,
    [
      p.n.id,
      p.attemptNo,
      tx.now,
      cls === 'success' ? 'success' : cls === 'retryable' ? 'retryable_error' : 'permanent_error',
      result.statusCode,
      code,
      cls === 'success' ? null : (MESSAGES[cls] ?? null),
    ],
  );

  if (cls === 'success') {
    await tx.query(
      `UPDATE notifications SET status = 'sent', sent_at = $2, last_error_code = NULL, last_error_message = NULL,
              updated_at = $2 WHERE id = $1 AND status = 'pending'`,
      [p.n.id, tx.now],
    );
    const prev = await tx.maybeOne<{ push_failed_count: number }>(
      `SELECT push_failed_count FROM devices WHERE id = $1 FOR NO KEY UPDATE`,
      [p.deviceId],
    );
    if (prev && prev.push_failed_count > 0) {
      await tx.query(`UPDATE devices SET push_failed_count = 0, updated_at = $2 WHERE id = $1`, [
        p.deviceId,
        tx.now,
      ]);
      await autoResolveAlerts(tx, {
        orgId: p.orgId,
        dedupeKeys: [pushFailedDedupeKey(p.deviceId)],
        note: 'push delivered',
      });
    }
    return null;
  }

  if (result.error === 'not_configured') {
    // a server configuration problem, not the device's: no failure counted against it
    await fail(tx, p.n.id, 'push_not_configured', 'VAPID keys are not configured');
    return null;
  }

  // one more consecutive failure of the device; an expired subscription is cleared (14 §6.6)
  const dev =
    cls === 'gone'
      ? await tx.maybeOne<{ push_failed_count: number }>(
          `UPDATE devices SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL, push_subscribed_at = NULL,
                  push_failed_count = push_failed_count + 1, updated_at = $3
            WHERE id = $1 AND push_endpoint = $2 RETURNING push_failed_count`,
          [p.deviceId, p.request.endpoint, tx.now],
        )
      : await tx.maybeOne<{ push_failed_count: number }>(
          `UPDATE devices SET push_failed_count = push_failed_count + 1, updated_at = $3
            WHERE id = $1 AND push_endpoint = $2 RETURNING push_failed_count`,
          [p.deviceId, p.request.endpoint, tx.now],
        );

  let retryInMs: number | null = null;
  if (cls === 'retryable') {
    retryInMs = nextPushAttemptDelay(p.attemptNo, result.retryAfterMs, p.deadline, tx.now);
    if (retryInMs !== null) {
      await tx.query(
        `UPDATE notifications SET next_attempt_at = $2, last_error_code = $3, last_error_message = $4, updated_at = $5
          WHERE id = $1`,
        [p.n.id, new Date(tx.now.getTime() + retryInMs), code, MESSAGES.retryable, tx.now],
      );
    }
  }
  if (retryInMs === null) await fail(tx, p.n.id, code ?? 'push_failed', MESSAGES[cls] ?? 'push failed');

  if (dev) {
    const threshold = (await orgSettings(tx, p.orgId)).push.max_consecutive_failures;
    if (dev.push_failed_count >= threshold) {
      const venueId = await deviceVenue(tx, p.userId);
      if (venueId)
        await raiseAlert(tx, {
          orgId: p.orgId,
          venueId,
          type: 'push_failed_repeatedly',
          dedupeKey: pushFailedDedupeKey(p.deviceId),
          userId: p.userId,
          details: { device_id: p.deviceId, consecutive_failures: dev.push_failed_count, last_error: code },
        });
    }
  }
  return retryInMs;
}

/** Runs one `job.push_send`: fresh read in a short transaction, the network call, the outcome in another. */
export async function runPushSend(db: Database, rt: PushRuntime, job: JobPayload): Promise<void> {
  const prepared = await db.transaction((tx) => prepare(tx, rt, job));
  if (prepared.kind === 'done') return;
  if (prepared.kind === 'wait')
    throw new RetryableJobError('quiet replacement waits for the push it replaces', prepared.delayMs);
  const result = await rt.sender.send(prepared.request);
  const retryInMs = await db.transaction((tx) => record(tx, prepared, result));
  if (retryInMs !== null)
    throw new RetryableJobError(
      `push attempt ${prepared.attemptNo} failed (${pushErrorCode(result)})`,
      retryInMs,
    );
}

/** `job.push_send` (canon §7.2; `mode: external` — never a network call inside a transaction). */
export function pushSendHandler(runtime: () => PushRuntime): JobHandler {
  return {
    type: 'job.push_send',
    mode: 'external',
    async handle({ row, db }) {
      await runPushSend(db, runtime(), row.payload as JobPayload);
    },
  };
}
