import type { AlertType, PushNotificationType } from '@point/shared';
import { MULTI_VENUE_ALERTS } from '../../../core/alerts/alerts.js';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { registerTxPlanner, unregisterTxPlanner, type TxPlanner } from '../../../core/db/tx-planners.js';
import { staffPushIntents, type StaffPushIntent } from '../domain/push-rules.js';
import { insertNotification } from './planner.js';

/**
 * Outbox attempts of a `job.push_send` row: provider attempts are bounded per notification (14 §6.6,
 * `PUSH_MAX_PROVIDER_ATTEMPTS`); a quiet replacement may also wait a few rounds for the push it replaces.
 */
export const PUSH_SEND_JOB_MAX_ATTEMPTS = 20;

/** Actionable kinds a quiet `closed` replaces (the request is still shown under the tag). */
export const REPLACEABLE_KINDS: readonly PushNotificationType[] = ['offer', 'broadcast', 'reminder'];

/** `notifications.dedupe_key` of 14 §6.1: `push:{kind}:{entity_id}:{round_or_n}:{device_id}`. */
export const pushDedupeKey = (kind: string, entity: string, n: string, deviceId: string) =>
  `push:${kind}:${entity}:${n}:${deviceId}`;

/** Keys of the actionable pushes of one round on one device (what a `closed` of that round replaces). */
export function roundPushKeys(taskId: string, round: number | string, deviceId: string): string[] {
  return REPLACEABLE_KINDS.map((k) => pushDedupeKey(k, taskId, String(round), deviceId));
}

interface Item {
  ev: EventEnvelope;
  i: StaffPushIntent;
  users: string[];
}

interface Candidate {
  ev: EventEnvelope;
  i: StaffPushIntent;
  deviceId: string;
  userId: string;
  dedupeKey: string;
  round: number | null;
  taskId: string | null;
  ticketId: string | null;
  venueId: string | null;
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** 14 §6.1 condition 1 (+ a live session on that device, DEC-PROPOSED): who can be pushed at all. */
async function pushableDevices(tx: Tx, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!userIds.length) return out;
  const rows = await tx.rows<{ id: string; user_id: string }>(
    `SELECT d.id, d.user_id FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ANY($1::uuid[]) AND d.revoked_at IS NULL AND d.notification_permission = 'granted'
        AND d.push_endpoint IS NOT NULL AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.device_id = d.id AND s.user_id = d.user_id
                     AND s.revoked_at IS NULL AND s.expires_at > $2)
      ORDER BY d.id`,
    [userIds, tx.now],
  );
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.id]);
  return out;
}

const isMultiVenue = (alertType: string | null): boolean =>
  !!alertType && MULTI_VENUE_ALERTS.has(alertType as AlertType);

/** Supervisors of the venue; for the multi-venue types (DEC-46) also admins and the owner. */
async function escalationRecipients(
  tx: Tx,
  orgId: string,
  venueId: string,
  alertType: string | null,
): Promise<{ supervisors: string[]; admins: string[] }> {
  const supervisors = await tx.rows<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.org_id = $1 AND u.status = 'active' AND u.role = 'supervisor'
        AND EXISTS (SELECT 1 FROM role_scopes rs WHERE rs.user_id = u.id AND rs.revoked_at IS NULL
                     AND rs.scope_type = 'venue' AND rs.venue_id = $2)
      ORDER BY u.id`,
    [orgId, venueId],
  );
  const admins = isMultiVenue(alertType)
    ? await tx.rows<{ id: string }>(
        `SELECT id FROM users WHERE org_id = $1 AND status = 'active' AND role IN ('admin','owner') ORDER BY id`,
        [orgId],
      )
    : [];
  return { supervisors: supervisors.map((r) => r.id), admins: admins.map((r) => r.id) };
}

/**
 * Staff push planner (DEC-41 for staff, 14 §3 «Push», §6.1): a TxPlanner over the transaction's domain
 * events. It writes one `notifications` row (`channel = push`, `recipient_device_id`) and one
 * `job.push_send` per device and tag. Within one transaction the last request per device and tag wins (a
 * round revoked and reopened for the same driver sends the new request only); a quiet `closed` that only
 * replaces goes to devices whose request push of that round exists (pending or sent). No network here.
 */
export const staffPushPlanner: TxPlanner = {
  name: 'staff-push-planner',
  async plan(tx, events) {
    const items: Item[] = [];
    for (const ev of events) for (const i of staffPushIntents(ev)) items.push({ ev, i, users: i.userIds });
    if (!items.length) return;

    const offerIds = uniq(items.map((x) => x.i.offerId));
    const offers = new Map(
      (offerIds.length
        ? await tx.rows<{ id: string; task_id: string; round_no: number }>(
            `SELECT id, task_id, round_no FROM task_offers WHERE id = ANY($1::uuid[])`,
            [offerIds],
          )
        : []
      ).map((o) => [o.id, o]),
    );
    const taskIds = uniq(
      items.map((x) => x.i.taskId ?? (x.i.offerId ? offers.get(x.i.offerId)?.task_id : null)),
    );
    const tasks = new Map(
      (taskIds.length
        ? await tx.rows<{ id: string; ticket_id: string; venue_id: string }>(
            `SELECT id, ticket_id, venue_id FROM tasks WHERE id = ANY($1::uuid[])`,
            [taskIds],
          )
        : []
      ).map((t) => [t.id, t]),
    );

    // recipients that need the database: unseen reminder recipients, a venue's supervisors
    const adminItems: Item[] = [];
    for (const x of items) {
      if (x.i.unseenOnly && x.i.offerId) {
        const r = await tx.rows<{ user_id: string }>(
          `SELECT user_id FROM offer_recipients
            WHERE offer_id = $1 AND seen_at IS NULL AND eligible_as IN ('accept','reserve_next')
              AND (cardinality($2::uuid[]) = 0 OR user_id = ANY($2::uuid[]))
            ORDER BY user_id`,
          [x.i.offerId, x.i.userIds],
        );
        x.users = r.map((u) => u.user_id);
      } else if (x.i.audience === 'venue_supervisors' && x.ev.venue_id) {
        const r = await escalationRecipients(tx, x.ev.org_id, x.ev.venue_id, x.i.alertType);
        x.users = r.supervisors;
        if (r.admins.length) adminItems.push({ ev: x.ev, i: x.i, users: r.admins });
      }
    }

    const devices = await pushableDevices(tx, uniq([...items, ...adminItems].flatMap((x) => x.users)));
    if (!devices.size) return;

    // last request per device and tag wins inside the transaction (event order)
    const final = new Map<string, Candidate>();
    const put = (x: Item) => {
      const offer = x.i.offerId ? offers.get(x.i.offerId) : undefined;
      const taskId = x.i.taskId ?? offer?.task_id ?? null;
      const task = taskId ? tasks.get(taskId) : undefined;
      const round = offer?.round_no ?? (x.i.n && /^\d+$/.test(x.i.n) ? Number(x.i.n) : null);
      // a multi-venue type is raised as one row per venue (DEC-46): one push per raise for each device
      const perRaise = x.i.kind === 'escalation' && isMultiVenue(x.i.alertType);
      const slot = x.i.kind === 'escalation' ? `alert:${perRaise ? x.i.alertType : x.i.alertId}` : taskId;
      if (!slot) return;
      for (const userId of x.users) {
        for (const deviceId of devices.get(userId) ?? []) {
          let dedupeKey: string;
          if (x.i.kind === 'escalation') {
            const epoch = Math.floor(new Date(x.ev.occurred_at).getTime() / 1000);
            dedupeKey = perRaise
              ? pushDedupeKey('escalation', x.i.alertType!, String(epoch), deviceId)
              : pushDedupeKey('escalation', x.i.alertId!, '1', deviceId);
          } else {
            const n = x.i.n ?? (offer ? String(offer.round_no) : x.ev.id);
            dedupeKey = pushDedupeKey(x.i.kind, taskId!, n, deviceId);
          }
          const key = `${deviceId}|${slot}`;
          final.delete(key);
          final.set(key, {
            ev: x.ev,
            i: x.i,
            deviceId,
            userId,
            dedupeKey,
            round,
            taskId,
            ticketId: x.i.ticketId ?? task?.ticket_id ?? null,
            venueId: x.ev.venue_id ?? task?.venue_id ?? null,
          });
        }
      }
    };
    for (const x of [...items, ...adminItems]) put(x);

    // a pure replacement needs the request push of that round on that device (pending or sent)
    const replace = [...final.values()].filter((c) => c.i.replaceOnly);
    if (replace.length) {
      const keys = replace.flatMap((c) =>
        c.taskId && c.round !== null ? roundPushKeys(c.taskId, c.round, c.deviceId) : [],
      );
      const live = new Set(
        (keys.length
          ? await tx.rows<{ dedupe_key: string }>(
              `SELECT dedupe_key FROM notifications WHERE dedupe_key = ANY($1::text[]) AND status IN ('pending','sent')`,
              [keys],
            )
          : []
        ).map((r) => r.dedupe_key),
      );
      for (const [k, c] of final) {
        if (!c.i.replaceOnly) continue;
        const shown =
          c.taskId !== null &&
          c.round !== null &&
          roundPushKeys(c.taskId, c.round, c.deviceId).some((x) => live.has(x));
        if (!shown) final.delete(k);
      }
    }

    for (const c of final.values()) {
      const payload: Record<string, unknown> = {};
      if (c.i.offerId) payload.offer_id = c.i.offerId;
      if (c.i.variant) payload.variant = c.i.variant;
      if (c.i.alertId) payload.alert_id = c.i.alertId;
      await insertNotification(tx, {
        channel: 'push',
        purpose: c.i.kind,
        orgId: c.ev.org_id,
        venueId: c.venueId,
        ticketId: c.ticketId,
        taskId: c.taskId,
        recipientCustomerId: null,
        recipientUserId: c.userId,
        recipientDeviceId: c.deviceId,
        dedupeKey: c.dedupeKey,
        sourceEventId: c.ev.id,
        job: {
          type: 'job.push_send',
          orderingKey: null, // 04 §6: push jobs are never ordered behind a slow message
          payload,
          maxAttempts: PUSH_SEND_JOB_MAX_ATTEMPTS,
        },
      });
    }
  },
};

export function startStaffPushPlanner(): void {
  registerTxPlanner(staffPushPlanner);
}

export function stopStaffPushPlanner(): void {
  unregisterTxPlanner(staffPushPlanner.name);
}
