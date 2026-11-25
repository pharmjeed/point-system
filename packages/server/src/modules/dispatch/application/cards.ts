import type { DriverState, OfferEligibility, OfferMode } from '@point/shared';
import { plateView, type TicketQueryable } from '../../tickets-custody/index.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The fixed note of a `reserve_next` card: 02 D-09 and 03 §3 word for word (DEC-361). */
export const SAFETY_NOTE_AR = 'احجزه فقط وأنت متوقف. لا تستخدم الجوال أثناء القيادة.';

/**
 * What a recipient can do with a live round now (10 §2.2, §2.6) — the stored `eligible_as` is display-only and
 * the server recomputes at accept time: an available driver accepts; a driver busy with one movement and no next
 * task may reserve a broadcast as his next task; everybody else (busy with a next task, on break, off duty, or a
 * single round addressed to a driver who is no longer available) only sees it.
 */
export function cardEligibility(mode: OfferMode, state: DriverState | null | undefined): OfferEligibility {
  if (state === 'available') return 'accept';
  if (mode === 'broadcast' && (state === 'intake_parking' || state === 'retrieving')) return 'reserve_next';
  return 'view_only';
}

export interface OfferCard {
  offer_id: string;
  task_id: string;
  mode: OfferMode;
  eligible_as: OfferEligibility;
  expires_at: string | null;
  reminder_at: string | null;
  server_time: string;
  ticket: {
    display_number: number;
    event_name_ar: string;
    plate: ReturnType<typeof plateView>;
    vehicle: { make: string | null; color: string | null; type: string | null };
  };
  requested_at: string;
  waiting_seconds: number;
  can_accept: boolean;
  can_reserve_next: boolean;
  safety_note_ar: string | null;
}

interface OfferCardRow {
  offer_id: string;
  mode: OfferMode;
  status: string;
  expires_at: Date | null;
  reminder_at: Date | null;
  task_id: string;
  requested_at: Date | null;
  display_number: number;
  event_name_ar: string;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_color: string | null;
  vehicle_type: string | null;
}

/**
 * OfferCard (07; D-09) of one round for each of the given recipients, with the eligibility of each driver's live
 * state. Recipients who are not on the round are left out. Two queries whatever the number of recipients.
 */
export async function loadOfferCards(
  q: TicketQueryable,
  offerId: string,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, OfferCard>> {
  const out = new Map<string, OfferCard>();
  if (!userIds.length) return out;
  const o = (
    await q.query<OfferCardRow>(
      `SELECT o.id AS offer_id, o.mode, o.status, o.expires_at, o.reminder_at, t.id AS task_id, c.requested_at,
              k.display_number, e.name_ar AS event_name_ar, k.plate_country, k.plate_digits, k.plate_letters_ar,
              k.plate_letters_en, k.plate_raw, k.vehicle_make, k.vehicle_color, k.vehicle_type
         FROM task_offers o
         JOIN tasks t ON t.id = o.task_id
         JOIN tickets k ON k.id = t.ticket_id
         JOIN events e ON e.id = k.event_id
         LEFT JOIN retrieval_cycles c ON c.id = t.cycle_id
        WHERE o.id = $1`,
      [offerId],
    )
  ).rows[0];
  if (!o) return out;
  const recipients = (
    await q.query<{ user_id: string; driver_state: DriverState | null }>(
      `SELECT r.user_id, s.driver_state
         FROM offer_recipients r
         LEFT JOIN v_driver_state s ON s.user_id = r.user_id
        WHERE r.offer_id = $1 AND r.user_id = ANY($2::uuid[])`,
      [offerId, [...new Set(userIds)]],
    )
  ).rows;
  const requestedAt = o.requested_at ? new Date(o.requested_at) : now;
  for (const r of recipients) {
    const eligibleAs = cardEligibility(o.mode, r.driver_state);
    out.set(r.user_id, {
      offer_id: o.offer_id,
      task_id: o.task_id,
      mode: o.mode,
      eligible_as: eligibleAs,
      expires_at: iso(o.expires_at),
      reminder_at: iso(o.reminder_at),
      server_time: now.toISOString(),
      ticket: {
        display_number: o.display_number,
        event_name_ar: o.event_name_ar,
        plate: plateView(o),
        vehicle: { make: o.vehicle_make, color: o.vehicle_color, type: o.vehicle_type },
      },
      requested_at: requestedAt.toISOString(),
      waiting_seconds: Math.max(0, Math.floor((now.getTime() - requestedAt.getTime()) / 1000)),
      can_accept: eligibleAs === 'accept',
      can_reserve_next: eligibleAs === 'reserve_next',
      safety_note_ar: eligibleAs === 'reserve_next' ? SAFETY_NOTE_AR : null,
    });
  }
  return out;
}

/** The head card of GET /v1/me/home (10 §2.6): the oldest live round of the pool on which the driver is a recipient. */
export async function loadHeadOfferCard(
  q: TicketQueryable,
  userId: string,
  poolId: string,
  now: Date,
): Promise<OfferCard | null> {
  const head = (
    await q.query<{ offer_id: string }>(
      `SELECT o.id AS offer_id
         FROM task_offers o
         JOIN offer_recipients r ON r.offer_id = o.id AND r.user_id = $1
         JOIN tasks t ON t.id = o.task_id
        WHERE o.status = 'active' AND t.dispatch_pool_id = $2
        ORDER BY t.priority_at, t.seq
        LIMIT 1`,
      [userId, poolId],
    )
  ).rows[0];
  if (!head) return null;
  return (await loadOfferCards(q, head.offer_id, [userId], now)).get(userId) ?? null;
}

/** DriverLive (07) plus where the driver works now (for the supervisors' rooms). */
export interface DriverLive {
  driver: { id: string; full_name: string; employee_code: string };
  driver_state: DriverState;
  connection_state: 'online' | 'uncertain' | 'offline' | null;
  last_heartbeat_at: string | null;
  available_since: string | null;
  active_task_id: string | null;
  next_task_id: string | null;
  duty_started_at: string | null;
  /** addition to 07 DriverLive (DEC-PROPOSED): the open duty session, the path id of force-end */
  duty_session_id: string | null;
}

export interface DriverWhere {
  live: DriverLive;
  /** venue of the open duty session, else of the active assignment */
  venue_id: string | null;
  dispatch_pool_id: string | null;
}

/** DriverLive of each user (off duty → `off_duty`, nulls); one query. */
export async function loadDriverLives(
  q: TicketQueryable,
  userIds: readonly string[],
): Promise<Map<string, DriverWhere>> {
  const out = new Map<string, DriverWhere>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = (
    await q.query<{
      id: string;
      full_name: string;
      employee_code: string;
      driver_state: DriverState | null;
      connection_state: 'online' | 'uncertain' | 'offline' | null;
      last_heartbeat_at: Date | null;
      available_since: Date | null;
      active_task_id: string | null;
      next_task_id: string | null;
      duty_started_at: Date | null;
      duty_session_id: string | null;
      duty_venue_id: string | null;
      dispatch_pool_id: string | null;
      assignment_venue_id: string | null;
    }>(
      `SELECT u.id, u.full_name, u.employee_code, s.driver_state, s.connection_state, s.last_heartbeat_at,
              s.available_since, s.active_task_id, s.next_task_id, d.started_at AS duty_started_at,
              d.id AS duty_session_id, d.venue_id AS duty_venue_id, d.dispatch_pool_id, a.venue_id AS assignment_venue_id
         FROM users u
         LEFT JOIN v_driver_state s ON s.user_id = u.id
         LEFT JOIN duty_sessions d ON d.id = s.duty_session_id
         LEFT JOIN driver_assignments a ON a.driver_id = u.id AND a.status = 'active'
        WHERE u.id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  for (const r of rows) {
    out.set(r.id, {
      live: {
        driver: { id: r.id, full_name: r.full_name, employee_code: r.employee_code },
        driver_state: r.driver_state ?? 'off_duty',
        connection_state: r.driver_state ? r.connection_state : null,
        last_heartbeat_at: r.driver_state ? iso(r.last_heartbeat_at) : null,
        available_since: iso(r.available_since),
        active_task_id: r.active_task_id,
        next_task_id: r.next_task_id,
        duty_started_at: iso(r.duty_started_at),
        duty_session_id: r.duty_session_id,
      },
      venue_id: r.duty_venue_id ?? r.assignment_venue_id,
      dispatch_pool_id: r.dispatch_pool_id,
    });
  }
  return out;
}
