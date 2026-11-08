import { PUSH_BODIES, PushPayloadSchema, type PushPayload } from '@shared/canon/push';

/**
 * What the Service Worker shows for one Web Push message (14 §6.4; the contract of
 * docs/progress/notes/notifications-staff.md §4; PNT-072), as a pure function:
 *
 * 1. every push shows a notification (no silent push) with the payload's `tag`, `renotify`, `silent` and `body`,
 *    the brand icon and badge, and `data = {url, kind, task_id, offer_id, ticket_no, sent_at}` — no actions;
 * 2. a payload whose `expires_at` already passed shows the quiet `closed` text instead (brand title, «انتهى العرض
 *    — افتح التطبيق لمعرفة الجديد», silent, no renotify, same tag);
 * 3. `kind = closed`: the shown notifications of the tag are closed first, then the quiet one is shown;
 * 4. a focused, visible window of the app plays its own sound: the notification is shown silent (DEC-PROPOSED-2
 *    of the notifications notes);
 * 5. an unknown or invalid payload shows the quiet ended text with tag `push:unknown`.
 *
 * The lock screen only ever gets the ticket number (DEC-23): the payload is validated with the strict canon
 * schema, so nothing else can be displayed.
 */
export const PUSH_ICON = '/icons/icon-192.png';
export const PUSH_BADGE = '/icons/badge-96.png';
export const UNKNOWN_TAG = 'push:unknown';

export interface PushData {
  url: string;
  kind: string;
  task_id: string | null;
  offer_id: string | null;
  ticket_no: number | null;
  sent_at: string | null;
}

export interface NotificationPlan {
  title: string;
  options: {
    body: string;
    tag: string;
    renotify: boolean;
    silent: boolean;
    icon: string;
    badge: string;
    dir: 'rtl';
    lang: 'ar';
    data: PushData;
  };
  /** Close the notifications already shown with this tag before showing the new one (`closed`). */
  closeTag: string | null;
}

function quietEnded(brand: string, tag: string, data: PushData): NotificationPlan {
  return {
    title: brand,
    options: {
      body: PUSH_BODIES.closed.ended(),
      tag,
      renotify: false,
      silent: true,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      dir: 'rtl',
      lang: 'ar',
      data,
    },
    closeTag: tag,
  };
}

function dataOf(p: PushPayload): PushData {
  return {
    url: p.url,
    kind: p.kind,
    task_id: p.task_id,
    offer_id: p.offer_id,
    ticket_no: p.ticket_no,
    sent_at: p.sent_at,
  };
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Parses the push body (text) and plans the notification. */
export function planNotification(
  text: string | null,
  options: { now: number; brand: string; focusedVisible: boolean },
): NotificationPlan {
  const parsed = PushPayloadSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    return quietEnded(options.brand, UNKNOWN_TAG, {
      url: '/d',
      kind: 'closed',
      task_id: null,
      offer_id: null,
      ticket_no: null,
      sent_at: null,
    });
  }
  const p = parsed.data;
  const data = dataOf(p);
  if (p.kind !== 'closed' && p.expires_at && Date.parse(p.expires_at) <= options.now)
    return quietEnded(options.brand, p.tag, { ...data, kind: 'closed' });
  return {
    title: p.title,
    options: {
      body: p.body,
      tag: p.tag,
      renotify: p.renotify,
      silent: p.silent || options.focusedVisible,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      dir: 'rtl',
      lang: 'ar',
      data,
    },
    closeTag: p.kind === 'closed' ? p.tag : null,
  };
}

/** The message a focused window receives on a notification click; the app syncs before any button. */
export interface PushClickMessage {
  type: 'push.click';
  url: string;
  kind: string;
  /** now − `sent_at` (15: `push_notification_clicked.age_ms`), null when unknown. */
  age_ms: number | null;
}

export function clickMessage(data: Partial<PushData> | null | undefined, now: number): PushClickMessage {
  const sent = data?.sent_at ? Date.parse(data.sent_at) : NaN;
  const url = typeof data?.url === 'string' && data.url.startsWith('/') ? data.url : '/d';
  return {
    type: 'push.click',
    url,
    kind: typeof data?.kind === 'string' ? data.kind : 'closed',
    age_ms: Number.isNaN(sent) ? null : Math.max(0, now - sent),
  };
}
