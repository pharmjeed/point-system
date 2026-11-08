import { PushPayloadSchema, PUSH_NOTIFICATION_TYPES, type PushNotificationType } from '@point/shared';
import { describe, expect, it } from 'vitest';
import type { PlannerEvent } from '../src/modules/notifications/domain/customer-rules.js';
import {
  buildPushPayload,
  classifyPushResponse,
  nextPushAttemptDelay,
  pushDeadline,
  pushErrorCode,
  pushTtlSeconds,
  PUSH_MAX_PROVIDER_ATTEMPTS,
} from '../src/modules/notifications/domain/push-payload.js';
import { staffPushIntents } from '../src/modules/notifications/domain/push-rules.js';
import {
  MemoryPushSender,
  parsePushRetryAfter,
  selectPushDriver,
} from '../src/modules/notifications/infra/push-transport.js';

const TASK = '0190d2a4-0000-7000-8000-00000000000e';
const TICKET = '0190d2a4-0000-7000-8000-00000000000a';
const OFFER = '0190d2a4-0000-7000-8000-000000000020';
const ALERT = '0190d2a4-0000-7000-8000-000000000030';
const A = '0190d2a4-0000-7000-8000-0000000000a1';
const B = '0190d2a4-0000-7000-8000-0000000000b2';
const C = '0190d2a4-0000-7000-8000-0000000000c3';

const ev = (
  type: string,
  payload: Record<string, unknown>,
  aggregate?: PlannerEvent['aggregate'],
): PlannerEvent => ({
  id: 'ev1',
  type,
  org_id: 'org',
  venue_id: 'venue',
  payload,
  ...(aggregate ? { aggregate } : {}),
});
const taskAgg = (version: number) => ({ type: 'task', id: TASK, version });

// 14 §3.2–§3.5 «Push» column as a pure mapping (PNT-072).
describe('staff push intents (14 §3, §6.3)', () => {
  it('task.offered → offer to the recipient, keyed by the round', () => {
    expect(
      staffPushIntents(
        ev('task.offered', {
          task_id: TASK,
          ticket_id: TICKET,
          offer_id: OFFER,
          round_no: 2,
          recipient_id: A,
          expires_at: '2026-10-27T16:00:30.000Z',
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'offer',
        userIds: [A],
        taskId: TASK,
        ticketId: TICKET,
        offerId: OFFER,
        n: '2',
        replaceOnly: false,
        unseenOnly: false,
      }),
    ]);
  });

  it('broadcast opened / extended → broadcast to the recipients (and the added ones)', () => {
    const opened = staffPushIntents(
      ev('task.broadcast_opened', {
        task_id: TASK,
        ticket_id: TICKET,
        offer_id: OFFER,
        round_no: 3,
        recipients: [
          { user_id: A, eligible_as: 'accept' },
          { user_id: B, eligible_as: 'view_only' },
        ],
      }),
    );
    expect(opened).toMatchObject([{ kind: 'broadcast', userIds: [A, B], n: '3' }]);
    expect(
      staffPushIntents(
        ev('task.broadcast_extended', {
          task_id: TASK,
          offer_id: OFFER,
          added: [{ user_id: C, eligible_as: 'accept' }],
        }),
      ),
    ).toMatchObject([{ kind: 'broadcast', userIds: [C], n: null, offerId: OFFER }]);
  });

  it('offer.reminded → reminder, unseen recipients only', () => {
    expect(
      staffPushIntents(
        ev('offer.reminded', { offer_id: OFFER, task_id: TASK, mode: 'single', recipient_ids: [A] }),
      ),
    ).toMatchObject([{ kind: 'reminder', userIds: [A], unseenOnly: true, replaceOnly: false }]);
  });

  it('claimed / expired / revoked → quiet replacement where a request is shown', () => {
    expect(
      staffPushIntents(
        ev('task.claimed', {
          task_id: TASK,
          ticket_id: TICKET,
          offer_id: OFFER,
          mode: 'broadcast',
          claimed_by: A,
          result: 'accepted',
          other_recipient_ids: [B, C],
        }),
      ),
    ).toMatchObject([{ kind: 'closed', variant: 'claimed', userIds: [B, C, A], replaceOnly: true }]);
    expect(
      staffPushIntents(ev('offer.expired', { offer_id: OFFER, task_id: TASK, recipient_id: A })),
    ).toMatchObject([{ kind: 'closed', variant: 'ended', userIds: [A], replaceOnly: true }]);
    expect(
      staffPushIntents(
        ev('offer.revoked', {
          offer_id: OFFER,
          task_id: TASK,
          mode: 'single',
          close_reason: 'recipient_unavailable',
          recipient_ids: [A],
        }),
      ),
    ).toMatchObject([{ kind: 'closed', variant: 'ended', userIds: [A], replaceOnly: true }]);
  });

  it('promoted / reassigned / reparking → next_due; withdrawn and canceled tell the driver', () => {
    expect(
      staffPushIntents(ev('task.promoted', { task_id: TASK, ticket_id: TICKET, assignee_id: A }, taskAgg(5))),
    ).toMatchObject([{ kind: 'next_due', userIds: [A], n: 'v5' }]);
    expect(
      staffPushIntents(
        ev(
          'task.reassigned',
          {
            task_id: TASK,
            ticket_id: TICKET,
            from_assignee_id: A,
            to_assignee_id: B,
            result_status: 'accepted',
          },
          taskAgg(7),
        ),
      ),
    ).toMatchObject([
      { kind: 'closed', variant: 'withdrawn', userIds: [A], n: 'v7' },
      { kind: 'next_due', userIds: [B], n: 'v7' },
    ]);
    // reserved as a next task: next_due comes with the promotion
    expect(
      staffPushIntents(
        ev(
          'task.reassigned',
          { task_id: TASK, from_assignee_id: null, to_assignee_id: B, result_status: 'assigned_waiting' },
          taskAgg(8),
        ),
      ),
    ).toEqual([]);
    expect(
      staffPushIntents(
        ev('ticket.reparking', {
          ticket: { ticket_id: TICKET, display_number: 125, ticket_version: 9 },
          closed_cycle_id: OFFER,
          repark_task_id: TASK,
          assignee_id: A,
          cause: 'customer_absent',
        }),
      ),
    ).toMatchObject([{ kind: 'next_due', userIds: [A], taskId: TASK, ticketId: TICKET, n: '1' }]);
    expect(
      staffPushIntents(
        ev(
          'task.withdrawn',
          { task_id: TASK, ticket_id: TICKET, from_assignee_id: A, trigger: 'supervisor' },
          taskAgg(4),
        ),
      ),
    ).toMatchObject([{ kind: 'closed', variant: 'withdrawn', userIds: [A], replaceOnly: false }]);
    const canceled = (type: string, reason: string) =>
      staffPushIntents(
        ev(
          'task.canceled',
          { task_id: TASK, ticket_id: TICKET, type, assignee_id: A, cancel_reason: reason },
          taskAgg(3),
        ),
      );
    expect(canceled('retrieve', 'supervisor_cancel')).toMatchObject([
      { kind: 'closed', variant: 'canceled' },
    ]);
    expect(canceled('retrieve', 'customer_field_cancel')).toHaveLength(1);
    // no push for a void, a manual reconcile or a repark for an absent customer (14 §3.1)
    expect(canceled('park', 'ticket_voided')).toEqual([]);
    expect(canceled('retrieve', 'manual_reconcile')).toEqual([]);
    expect(canceled('retrieve', 'repark_customer_absent')).toEqual([]);
  });

  it('alerts: escalation for critical ones only (14 §10: no push for info, warning in-page)', () => {
    const raised = (severity: string, type = 'request_unaccepted') =>
      staffPushIntents(
        ev('alert.raised', {
          alert_id: ALERT,
          type,
          severity,
          dedupe_key: `${type}:${TASK}`,
          ticket_id: TICKET,
          task_id: TASK,
          user_id: null,
        }),
      );
    expect(raised('critical')).toMatchObject([
      {
        kind: 'escalation',
        audience: 'venue_supervisors',
        alertId: ALERT,
        alertType: 'request_unaccepted',
        n: '1',
      },
    ]);
    expect(raised('warning', 'next_task_waiting_long')).toEqual([]);
    expect(raised('info', 'push_failed_repeatedly')).toEqual([]);
  });

  it('nothing for other events (task.escalated reaches supervisors through its alert)', () => {
    for (const type of [
      'task.escalated',
      'task.created',
      'task.started',
      'ticket.parked',
      'driver.duty_started',
    ])
      expect(staffPushIntents(ev(type, { task_id: TASK, assignee_id: A }))).toEqual([]);
  });
});

const NOW = new Date('2026-10-27T16:00:05.000Z');
const facts = (kind: PushNotificationType, extra: Partial<Parameters<typeof buildPushPayload>[0]> = {}) => ({
  kind,
  variant: null,
  staffBrandAr: 'STAFF_AR',
  ticketNo: 125,
  taskId: TASK,
  offerId: OFFER,
  alertId: ALERT,
  alertType: 'request_unaccepted',
  offerExpiresAt: new Date('2026-10-27T16:00:30.000Z'),
  now: NOW,
  ...extra,
});

describe('push payload (14 §6.2–§6.4, DEC-23)', () => {
  it.each(PUSH_NOTIFICATION_TYPES)('%s: schema-valid; the ticket number is the only datum', (kind) => {
    const p = PushPayloadSchema.parse(
      buildPushPayload(facts(kind, kind === 'closed' ? { variant: 'withdrawn' } : {})),
    );
    expect(p.title.startsWith('STAFF_AR')).toBe(true);
    expect(`${p.title} ${p.body}`.replace(/125/g, '')).not.toMatch(/\d/);
    expect(p.ticket_no).toBe(125);
    expect(p.renotify).toBe(kind !== 'closed');
    expect(p.silent).toBe(kind === 'closed');
  });

  it('tags, urls, offer and expiry fields per kind', () => {
    expect(buildPushPayload(facts('offer'))).toMatchObject({
      tag: `task:${TASK}`,
      url: '/d',
      offer_id: OFFER,
      expires_at: '2026-10-27T16:00:30.000Z',
      sent_at: NOW.toISOString(),
      body: 'تذكرة 125 — افتح التطبيق للقبول',
      title: 'STAFF_AR — طلب إحضار',
    });
    expect(buildPushPayload(facts('broadcast', { offerExpiresAt: null }))).toMatchObject({
      expires_at: null,
    });
    expect(buildPushPayload(facts('next_due'))).toMatchObject({ offer_id: null, expires_at: null });
    expect(buildPushPayload(facts('escalation'))).toMatchObject({
      tag: `alert:${ALERT}`,
      url: '/ops/alerts',
      offer_id: null,
      body: 'طلب تذكرة 125 دون قبول',
      title: 'STAFF_AR — تنبيه عاجل',
    });
    expect(buildPushPayload(facts('closed', { variant: 'claimed' }))).toMatchObject({
      title: 'STAFF_AR',
      body: 'تم قبول الطلب',
      silent: true,
      renotify: false,
      expires_at: null,
    });
  });

  it('TTL: the round left for an offer (≤ 30 s), the fixed values otherwise; deadline bounds retries', () => {
    const created = new Date('2026-10-27T16:00:00.000Z');
    const exp = new Date('2026-10-27T16:00:30.000Z');
    expect(pushTtlSeconds('offer', pushDeadline('offer', created, exp), NOW)).toBe(25);
    expect(
      pushTtlSeconds('offer', pushDeadline('offer', created, exp), new Date('2026-10-27T16:00:31Z')),
    ).toBe(0);
    expect(pushTtlSeconds('broadcast', pushDeadline('broadcast', created, null), NOW)).toBe(55);
    expect(pushTtlSeconds('next_due', pushDeadline('next_due', created, null), NOW)).toBe(295);
    expect(pushTtlSeconds('escalation', pushDeadline('escalation', created, null), created)).toBe(600);
  });

  it('responses (14 §6.6) and retries within the TTL, at most 3', () => {
    const r = (statusCode: number | null, error: string | null = null) => ({ statusCode, error });
    expect(classifyPushResponse(r(201))).toBe('success');
    expect(classifyPushResponse(r(200))).toBe('success');
    expect(classifyPushResponse(r(404))).toBe('gone');
    expect(classifyPushResponse(r(410))).toBe('gone');
    expect(classifyPushResponse(r(429))).toBe('retryable');
    expect(classifyPushResponse(r(503))).toBe('retryable');
    expect(classifyPushResponse(r(null, 'network'))).toBe('retryable');
    expect(classifyPushResponse(r(null, 'timeout'))).toBe('retryable');
    expect(classifyPushResponse(r(400))).toBe('permanent');
    expect(classifyPushResponse(r(403))).toBe('permanent');
    expect(classifyPushResponse(r(413))).toBe('permanent');
    expect(classifyPushResponse(r(null, 'not_configured'))).toBe('permanent');
    expect(pushErrorCode(r(410))).toBe('http_410');
    expect(pushErrorCode(r(201))).toBeNull();
    expect(pushErrorCode(r(null, 'timeout'))).toBe('timeout');

    const deadline = new Date(NOW.getTime() + 60_000);
    expect(nextPushAttemptDelay(1, null, deadline, NOW)).toBe(2_000);
    expect(nextPushAttemptDelay(2, null, deadline, NOW)).toBe(5_000);
    expect(nextPushAttemptDelay(3, null, deadline, NOW)).toBe(15_000);
    expect(nextPushAttemptDelay(PUSH_MAX_PROVIDER_ATTEMPTS, null, deadline, NOW)).toBeNull();
    expect(PUSH_MAX_PROVIDER_ATTEMPTS).toBe(4); // the first attempt + up to 3 retries
    expect(nextPushAttemptDelay(1, 20_000, deadline, NOW)).toBe(20_000); // Retry-After honoured
    expect(nextPushAttemptDelay(1, 70_000, deadline, NOW)).toBeNull(); // beyond the TTL
    expect(nextPushAttemptDelay(1, null, new Date(NOW.getTime() + 1_000), NOW)).toBeNull();
  });
});

describe('push transport', () => {
  it('Retry-After: seconds or an HTTP date', () => {
    expect(parsePushRetryAfter('7')).toBe(7_000);
    expect(parsePushRetryAfter(null)).toBeNull();
    expect(parsePushRetryAfter('Tue, 27 Oct 2026 16:00:10 GMT', Date.parse('2026-10-27T16:00:05Z'))).toBe(
      5_000,
    );
    expect(parsePushRetryAfter('soon')).toBeNull();
  });

  it('driver selection: memory in test or local without keys, web-push with keys, disabled elsewhere', () => {
    const keys = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    const none = { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' };
    expect(selectPushDriver({ APP_ENV: 'test', ...keys })).toBe('memory');
    expect(selectPushDriver({ APP_ENV: 'local', ...none })).toBe('memory');
    expect(selectPushDriver({ APP_ENV: 'local', ...keys })).toBe('web-push');
    expect(selectPushDriver({ APP_ENV: 'staging', ...keys })).toBe('web-push');
    expect(selectPushDriver({ APP_ENV: 'production', ...none })).toBe('disabled');
    expect(selectPushDriver({ APP_ENV: 'staging', ...none })).toBe('disabled');
  });

  it('the dev/test sender records parsed payloads and plays scripted answers per endpoint', async () => {
    const s = new MemoryPushSender();
    const req = {
      endpoint: 'https://push.test/a',
      p256dh: 'k',
      auth: 'a',
      payload: JSON.stringify({ kind: 'offer' }),
      ttlSeconds: 30,
      urgency: 'high' as const,
      topic: 't',
    };
    s.respond(req.endpoint, { statusCode: 503, retryAfterMs: 1000 }, { statusCode: 410 });
    expect(await s.send(req)).toEqual({ statusCode: 503, retryAfterMs: 1000, error: null });
    expect(await s.send(req)).toEqual({ statusCode: 410, retryAfterMs: null, error: null });
    expect(await s.send(req)).toEqual({ statusCode: 201, retryAfterMs: null, error: null });
    expect(s.sent.map((x) => x.json)).toEqual([{ kind: 'offer' }, { kind: 'offer' }, { kind: 'offer' }]);
  });
});
