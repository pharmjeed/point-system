import {
  PUSH_BODIES,
  PUSH_PAYLOAD_VERSION,
  PUSH_TTL_S,
  PUSH_URLS,
  escalationBody,
  pushTag,
  pushTitle,
  type PushClosedVariant,
  type PushNotificationType,
  type PushPayload,
} from '@point/shared';

/** What the payload is built from: the notification and the live rows read at send time (11 §1.6). */
export interface PushFacts {
  kind: PushNotificationType;
  variant: PushClosedVariant | null;
  staffBrandAr: string;
  ticketNo: number | null;
  taskId: string | null;
  offerId: string | null;
  alertId: string | null;
  alertType: string | null;
  /** the single round's end (offer, single reminder) */
  offerExpiresAt: Date | null;
  now: Date;
}

/**
 * The 14 §6.2 payload. The body names the ticket number only (DEC-23); a notification about a ticket
 * whose number is unknown is never built (the caller skips it).
 */
export function buildPushPayload(f: PushFacts): PushPayload {
  const n = f.ticketNo ?? 0;
  let body: string;
  switch (f.kind) {
    case 'offer':
    case 'broadcast':
    case 'reminder':
    case 'next_due':
      body = PUSH_BODIES[f.kind](n);
      break;
    case 'closed':
      body = PUSH_BODIES.closed[f.variant ?? 'ended'](n);
      break;
    case 'escalation':
      body = escalationBody(f.alertType ?? '', f.ticketNo);
      break;
  }
  const quiet = f.kind === 'closed';
  const singleRound = f.kind === 'offer' || f.kind === 'reminder';
  return {
    v: PUSH_PAYLOAD_VERSION,
    kind: f.kind,
    tag: f.kind === 'escalation' ? pushTag({ alertId: f.alertId! }) : pushTag({ taskId: f.taskId! }),
    title: pushTitle(f.kind, f.staffBrandAr),
    body,
    ticket_no: f.ticketNo,
    task_id: f.taskId,
    offer_id: f.kind === 'escalation' || f.kind === 'next_due' ? null : f.offerId,
    url: f.kind === 'escalation' ? PUSH_URLS.alerts : PUSH_URLS.driver,
    renotify: !quiet,
    silent: quiet,
    sent_at: f.now.toISOString(),
    expires_at: singleRound && f.offerExpiresAt ? f.offerExpiresAt.toISOString() : null,
  };
}

/**
 * The instant after which a push for this notification is pointless (14 §6.2 TTL, §6.6 «retries within
 * the TTL»): the round's end for an offer, otherwise creation + the kind's TTL.
 */
export function pushDeadline(kind: PushNotificationType, createdAt: Date, offerExpiresAt: Date | null): Date {
  if (kind === 'offer' && offerExpiresAt) return offerExpiresAt;
  return new Date(createdAt.getTime() + PUSH_TTL_S[kind] * 1000);
}

/** `TTL` header for an attempt now: whole seconds left before the deadline, capped by the kind's TTL. */
export function pushTtlSeconds(kind: PushNotificationType, deadline: Date, now: Date): number {
  const left = Math.floor((deadline.getTime() - now.getTime()) / 1000);
  return Math.max(0, Math.min(left, PUSH_TTL_S[kind]));
}

export type PushResponseClass = 'success' | 'gone' | 'retryable' | 'permanent';

/**
 * 14 §6.6: 2xx success; 404/410 the subscription is gone; 429 and 5xx (and network failures) are retried;
 * any other status (400, 401/403 VAPID, 413 payload) is a permanent failure.
 */
export function classifyPushResponse(r: {
  statusCode: number | null;
  error: string | null;
}): PushResponseClass {
  if (r.statusCode === null) return r.error === 'not_configured' ? 'permanent' : 'retryable';
  if (r.statusCode >= 200 && r.statusCode < 300) return 'success';
  if (r.statusCode === 404 || r.statusCode === 410) return 'gone';
  if (r.statusCode === 429 || r.statusCode >= 500) return 'retryable';
  return 'permanent';
}

/** Provider attempts per notification: the first one plus «up to 3 retries» (14 §6.6). */
export const PUSH_MAX_PROVIDER_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * Delay before the next provider attempt (`attemptNo` attempts made), or null when no attempt is left or
 * the next one would land at or after the deadline. A `Retry-After` of the service is honoured.
 */
export function nextPushAttemptDelay(
  attemptNo: number,
  retryAfterMs: number | null,
  deadline: Date,
  now: Date,
): number | null {
  if (attemptNo >= PUSH_MAX_PROVIDER_ATTEMPTS) return null;
  const delay = Math.max(
    retryAfterMs ?? 0,
    RETRY_DELAYS_MS[Math.min(attemptNo - 1, RETRY_DELAYS_MS.length - 1)]!,
  );
  return now.getTime() + delay < deadline.getTime() ? delay : null;
}

/** `notification_attempts.provider_error_code` for a response: `http_<status>`, `network`, `timeout`. */
export function pushErrorCode(r: { statusCode: number | null; error: string | null }): string | null {
  if (r.statusCode !== null) return r.statusCode >= 200 && r.statusCode < 300 ? null : `http_${r.statusCode}`;
  return r.error ?? 'network';
}
