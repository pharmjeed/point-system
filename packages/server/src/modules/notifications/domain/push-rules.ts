import type { PushClosedVariant, PushNotificationType } from '@point/shared';
import type { PlannerEvent } from './customer-rules.js';

/**
 * One staff Web Push the domain event asks for (14 §3.2, §3.4, §3.5, §6.3; 11 §8.3–§8.8). The planner
 * resolves the recipients to their devices (14 §6.1) and writes `notifications` + `job.push_send`.
 */
export interface StaffPushIntent {
  kind: PushNotificationType;
  /** `closed` only: the quiet replacement text */
  variant: PushClosedVariant | null;
  /** `users`: the listed users; `venue_supervisors`: the event venue's supervisors (+ admins, see below) */
  audience: 'users' | 'venue_supervisors';
  userIds: string[];
  taskId: string | null;
  ticketId: string | null;
  offerId: string | null;
  alertId: string | null;
  alertType: string | null;
  /** `{round_or_n}` of the dedupe key (14 §6.1); null → the offer's round number, read by the planner */
  n: string | null;
  /**
   * A pure replacement (claim, expiry, revocation): only devices whose latest push for the task is still
   * an actionable notification get it — a device that never showed the request gets nothing to replace.
   */
  replaceOnly: boolean;
  /** reminders: recipients that may act (accept / reserve_next) and sent no `client.offer_seen` */
  unseenOnly: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x : str(x?.user_id))).filter((x): x is string => !!x)
    : [];
const uniq = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/** Task-driven keys use the task version of the event (`v<n>`), offer-driven keys the round number. */
const taskVersion = (ev: PlannerEvent): string | null =>
  ev.aggregate?.type === 'task' && typeof ev.aggregate.version === 'number'
    ? `v${ev.aggregate.version}`
    : null;

const base = (o: Partial<StaffPushIntent> & Pick<StaffPushIntent, 'kind'>): StaffPushIntent => ({
  variant: null,
  audience: 'users',
  userIds: [],
  taskId: null,
  ticketId: null,
  offerId: null,
  alertId: null,
  alertType: null,
  n: null,
  replaceOnly: false,
  unseenOnly: false,
  ...o,
});

/** Retrieval cancellations that tell the driver «أُلغي طلب تذكرة …» (14 §3.1 `ticket.retrieval_canceled`). */
const FIELD_CANCEL_REASONS = new Set(['customer_field_cancel', 'supervisor_cancel']);

/**
 * The «Push» column of 14 §3 as a pure function of one domain event (payloads of 11 §8). Only the kinds of
 * canon §5.7. Supervisors are pushed only for `critical` alerts (`escalation`, 14 §3.5, §10); `info` and
 * `warning` alerts never reach a lock screen.
 */
export function staffPushIntents(ev: PlannerEvent): StaffPushIntent[] {
  const p = ev.payload ?? {};
  const taskId = str(p.task_id) ?? (ev.aggregate?.type === 'task' ? ev.aggregate.id : null);
  const ticketId = str(p.ticket_id) ?? str(p.ticket?.ticket_id);
  const offerId = str(p.offer_id) ?? (ev.aggregate?.type === 'task_offer' ? ev.aggregate.id : null);
  const round = typeof p.round_no === 'number' ? String(p.round_no) : null;

  switch (ev.type) {
    // a single offer (round TTL 30 s) and the broadcast to every on-duty driver who is not on a break
    case 'task.offered': {
      const to = str(p.recipient_id);
      if (!taskId || !to) return [];
      return [base({ kind: 'offer', userIds: [to], taskId, ticketId, offerId, n: round })];
    }
    case 'task.broadcast_opened': {
      const to = ids(p.recipients);
      if (!taskId || !to.length) return [];
      return [base({ kind: 'broadcast', userIds: to, taskId, ticketId, offerId, n: round })];
    }
    case 'task.broadcast_extended': {
      const to = ids(p.added);
      if (!taskId || !to.length) return [];
      return [base({ kind: 'broadcast', userIds: to, taskId, ticketId, offerId })];
    }
    // one reminder per round, only to those who have not seen the card (14 §10)
    case 'offer.reminded':
      if (!taskId || !offerId) return [];
      return [base({ kind: 'reminder', userIds: ids(p.recipient_ids), taskId, offerId, unseenOnly: true })];

    // quiet replacements under the same tag (DEC-23): claimed, expired, revoked
    case 'task.claimed': {
      if (!taskId) return [];
      const to = uniq([...ids(p.other_recipient_ids), str(p.claimed_by)]);
      if (!to.length) return [];
      return [
        base({
          kind: 'closed',
          variant: 'claimed',
          userIds: to,
          taskId,
          ticketId,
          offerId,
          replaceOnly: true,
        }),
      ];
    }
    case 'offer.expired': {
      const to = str(p.recipient_id);
      if (!taskId || !to) return [];
      return [base({ kind: 'closed', variant: 'ended', userIds: [to], taskId, offerId, replaceOnly: true })];
    }
    case 'offer.revoked': {
      const to = ids(p.recipient_ids);
      if (!taskId || !to.length) return [];
      return [base({ kind: 'closed', variant: 'ended', userIds: to, taskId, offerId, replaceOnly: true })];
    }

    // the next task becomes current / a direct assignment / a repark for the holder
    case 'task.promoted': {
      const to = str(p.assignee_id);
      if (!taskId || !to) return [];
      return [base({ kind: 'next_due', userIds: [to], taskId, ticketId, n: taskVersion(ev) })];
    }
    case 'task.reassigned': {
      if (!taskId) return [];
      const out: StaffPushIntent[] = [];
      const from = str(p.from_assignee_id);
      const to = str(p.to_assignee_id);
      if (from && from !== to)
        out.push(
          base({
            kind: 'closed',
            variant: 'withdrawn',
            userIds: [from],
            taskId,
            ticketId,
            n: taskVersion(ev),
          }),
        );
      if (to && (p.result_status === 'accepted' || p.result_status === 'in_progress'))
        out.push(base({ kind: 'next_due', userIds: [to], taskId, ticketId, n: taskVersion(ev) }));
      return out;
    }
    case 'ticket.reparking': {
      const to = str(p.assignee_id);
      const repark = str(p.repark_task_id);
      if (!to || !repark) return [];
      return [base({ kind: 'next_due', userIds: [to], taskId: repark, ticketId, n: '1' })];
    }

    // the driver must not move the car (14 §3.2): sent even when no request notification is shown
    case 'task.withdrawn': {
      const from = str(p.from_assignee_id);
      if (!taskId || !from) return [];
      return [
        base({
          kind: 'closed',
          variant: 'withdrawn',
          userIds: [from],
          taskId,
          ticketId,
          n: taskVersion(ev),
        }),
      ];
    }
    case 'task.canceled': {
      const to = str(p.assignee_id);
      if (!taskId || !to || p.type !== 'retrieve' || !FIELD_CANCEL_REASONS.has(p.cancel_reason)) return [];
      return [
        base({
          kind: 'closed',
          variant: 'canceled',
          userIds: [to],
          taskId,
          ticketId,
          n: taskVersion(ev),
        }),
      ];
    }

    // supervisors: critical alerts only (escalation; 14 §8 «escalation / Push»)
    case 'alert.raised': {
      const alertId = str(p.alert_id) ?? (ev.aggregate?.type === 'alert' ? ev.aggregate.id : null);
      if (!alertId || p.severity !== 'critical' || !ev.venue_id) return [];
      return [
        base({
          kind: 'escalation',
          audience: 'venue_supervisors',
          alertId,
          alertType: str(p.type),
          taskId: str(p.task_id),
          ticketId: str(p.ticket_id),
          n: '1',
        }),
      ];
    }
    default:
      return [];
  }
}
