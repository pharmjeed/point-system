import { describe, expect, it } from 'vitest';
import { PUSH_BODIES, pushTitle } from '@shared/canon/push';
import { subscriptionBody, urlBase64ToBytes } from '@/lib/push';
import { clickMessage, planNotification, UNKNOWN_TAG } from '@/sw/pushLogic';

/**
 * PNT-072 web part: what the Service Worker shows for a push (14 §6.4, notifications-staff.md §4) and the
 * subscription body sent with `PUT /v1/me/devices/{deviceId}`.
 */
const BRAND = 'العلامة';
const TASK = '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c';
const OFFER = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f';
const NOW = Date.parse('2026-10-29T18:00:10.000Z');

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: 'offer',
    tag: `task:${TASK}`,
    title: pushTitle('offer', BRAND),
    body: PUSH_BODIES.offer(125),
    ticket_no: 125,
    task_id: TASK,
    offer_id: OFFER,
    url: '/d',
    renotify: true,
    silent: false,
    sent_at: '2026-10-29T18:00:05.000Z',
    expires_at: '2026-10-29T18:00:35.000Z',
    ...over,
  };
}

const plan = (body: unknown, focusedVisible = false) =>
  planNotification(typeof body === 'string' ? body : JSON.stringify(body), {
    now: NOW,
    brand: BRAND,
    focusedVisible,
  });

describe('Service Worker push → notification (14 §6.4)', () => {
  it('shows the payload with its tag, renotify, silent, the brand icon and badge; data for the click; no actions', () => {
    const p = plan(payload());
    expect(p.title).toBe(`${BRAND} — طلب إحضار`);
    expect(p.options).toEqual({
      body: 'تذكرة 125 — افتح التطبيق للقبول',
      tag: `task:${TASK}`,
      renotify: true,
      silent: false,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      dir: 'rtl',
      lang: 'ar',
      data: {
        url: '/d',
        kind: 'offer',
        task_id: TASK,
        offer_id: OFFER,
        ticket_no: 125,
        sent_at: '2026-10-29T18:00:05.000Z',
      },
    });
    expect(p.closeTag).toBeNull();
    expect(p.options).not.toHaveProperty('actions');
  });

  it('an expired round arrives as the quiet closed notification under the same tag', () => {
    const p = plan(payload({ expires_at: '2026-10-29T18:00:09.000Z' }));
    expect(p.title).toBe(BRAND);
    expect(p.options).toMatchObject({
      body: PUSH_BODIES.closed.ended(),
      tag: `task:${TASK}`,
      silent: true,
      renotify: false,
    });
    expect(p.closeTag).toBe(`task:${TASK}`);
  });

  it('kind closed replaces the request quietly: close the tag, then show', () => {
    const p = plan(
      payload({
        kind: 'closed',
        title: pushTitle('closed', BRAND),
        body: PUSH_BODIES.closed.claimed(),
        renotify: false,
        silent: true,
        expires_at: null,
      }),
    );
    expect(p.closeTag).toBe(`task:${TASK}`);
    expect(p.options).toMatchObject({ body: 'تم قبول الطلب', silent: true, renotify: false });
  });

  it('a focused, visible window plays its own sound: the notification is silent', () => {
    expect(plan(payload(), true).options.silent).toBe(true);
  });

  it('a payload outside the strict schema (a plate, a phone) or garbage shows the quiet ended text', () => {
    for (const bad of [
      payload({ plate: '1234 ب ح د' }),
      payload({ phone: '+966500000000' }),
      'not json',
      null,
    ]) {
      const p = plan(bad);
      expect(p.options.tag).toBe(UNKNOWN_TAG);
      expect(p.options.body).toBe(PUSH_BODIES.closed.ended());
      expect(p.options.silent).toBe(true);
      expect(JSON.stringify(p)).not.toContain('1234');
    }
  });

  it('escalation for supervisors opens S-04', () => {
    const p = plan(
      payload({
        kind: 'escalation',
        tag: `alert:${TASK}`,
        title: pushTitle('escalation', BRAND),
        body: 'طلب تذكرة 125 دون قبول',
        offer_id: null,
        url: '/ops/alerts',
        expires_at: null,
      }),
    );
    expect(p.options.data.url).toBe('/ops/alerts');
    expect(p.options.tag).toBe(`alert:${TASK}`);
  });

  it('the click message: url (same-origin path only), kind and age_ms', () => {
    expect(clickMessage({ url: '/d', kind: 'offer', sent_at: '2026-10-29T18:00:05.000Z' }, NOW)).toEqual({
      type: 'push.click',
      url: '/d',
      kind: 'offer',
      age_ms: 5000,
    });
    expect(clickMessage({ url: 'https://evil.example/', kind: 'offer' }, NOW).url).toBe('/d');
    expect(clickMessage(null, NOW)).toMatchObject({ url: '/d', age_ms: null });
  });
});

describe('the subscription body (07 PUT /v1/me/devices/{deviceId})', () => {
  it('takes the endpoint and both keys; refuses an incomplete one', () => {
    expect(
      subscriptionBody({ endpoint: 'https://push.example/x', keys: { p256dh: 'BPk', auth: 'YXV0aA' } }),
    ).toEqual({ endpoint: 'https://push.example/x', keys: { p256dh: 'BPk', auth: 'YXV0aA' } });
    expect(subscriptionBody({ endpoint: 'https://push.example/x', keys: { p256dh: 'BPk' } })).toBeNull();
    expect(subscriptionBody(null)).toBeNull();
  });

  it('decodes the VAPID public key from URL-safe base64 without padding', () => {
    const bytes = urlBase64ToBytes('BAEC_-8');
    expect([...bytes]).toEqual([4, 1, 2, 255, 239]);
  });
});
