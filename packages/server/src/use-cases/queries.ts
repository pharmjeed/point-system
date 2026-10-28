import { Inject, Injectable } from '@nestjs/common';
import { TICKET_STATUSES, type TicketStatus } from '@point/shared';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import type { Database } from '../core/db/database.js';
import { AppError } from '../core/errors/app-error.js';
import { DATABASE, CLOCK } from '../http/tokens.js';
import type { Clock } from '../core/clock/clock.js';
import { driverStateOf, dutySessionView, type DutyRow } from '../modules/dispatch/index.js';
import {
  latinDigits,
  loadTicketDetail,
  plateView,
  SUMMARY_SELECT,
  ticketSummary,
  type TicketSummaryRow,
} from '../modules/tickets-custody/index.js';
import {
  findDefaultDispatchPool,
  findOpenShiftForPool,
  listVenueEventsByStatus,
} from '../modules/venues-events/index.js';
import { loadTaskCard } from './views.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface ListTicketsQuery {
  event_id?: string;
  venue_id?: string;
  status?: string;
  q?: string;
  open_only?: 'true' | 'false';
  limit: number;
  cursor?: string;
}

function encodeCursor(v: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ k: 'tickets', ...v })).toString('base64url');
}

function decodeCursor(c: string): { created_at: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (v?.k !== 'tickets' || typeof v.created_at !== 'string' || typeof v.id !== 'string') throw new Error();
    if (Number.isNaN(Date.parse(v.created_at)) || !/^[0-9a-f-]{36}$/i.test(v.id)) throw new Error();
    return { created_at: v.created_at, id: v.id };
  } catch {
    throw new AppError('PAGINATION_CURSOR_INVALID');
  }
}

/** Reads of the S2 slice: GET /v1/me/home, GET /v1/tickets, GET /v1/tickets/{ticketId}. */
@Injectable()
export class TicketQueries {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 07 GET /v1/tickets: newest first; a driver sees the open tickets of his venue only (minimal projection). */
  async list(actor: ActorContext, f: ListTicketsQuery) {
    const isDriver = actor.role === 'driver';
    if (isDriver && !actor.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
    if (f.venue_id && !actor.venueIds.has(f.venue_id))
      throw new AppError('SCOPE_VENUE_DENIED', { venue_id: f.venue_id });
    let statuses: TicketStatus[] | null = null;
    if (f.status) {
      const parts = f.status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = parts.filter((p) => !(TICKET_STATUSES as readonly string[]).includes(p));
      if (bad.length)
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ field: 'status', issue: 'invalid_enum_value' }],
        });
      statuses = parts as TicketStatus[];
    }
    const openOnly = isDriver || f.open_only !== 'false';
    const venues = f.venue_id ? [f.venue_id] : [...actor.venueIds];
    const params: unknown[] = [actor.orgId, venues];
    const where = [`t.org_id = $1`, `t.venue_id = ANY($2::uuid[])`];
    const add = (sql: (n: number) => string, v: unknown) => {
      params.push(v);
      where.push(sql(params.length));
    };
    if (f.event_id) add((n) => `t.event_id = $${n}`, f.event_id);
    if (statuses) add((n) => `t.status = ANY($${n}::text[])`, statuses);
    if (openOnly) where.push(`t.status NOT IN ('delivered','voided')`);
    if (f.q) {
      const digits = latinDigits(f.q).replace(/\D/g, '');
      if (!digits) return { data: [], next_cursor: null };
      params.push(digits);
      const p = params.length;
      where.push(`(t.plate_digits LIKE '%' || $${p} || '%' OR t.display_number::text = $${p})`);
    }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      params.push(c.created_at, c.id);
      where.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(f.limit + 1);
    const rows = (
      await this.db.query<TicketSummaryRow>(
        `${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      data: page.map(ticketSummary),
      next_cursor:
        rows.length > f.limit && last
          ? encodeCursor({ created_at: new Date(last.created_at).toISOString(), id: last.id })
          : null,
    };
  }

  /**
   * 07 GET /v1/tickets/{ticketId}: full for the assignee, the creator during intake and staff in scope; a
   * driver never reads a closed ticket or one of another venue (TICKET_NOT_FOUND, 08).
   */
  async detail(actor: ActorContext, ticketId: string) {
    const t = await this.db.query<{ venue_id: string; status: string; org_id: string }>(
      `SELECT venue_id, status, org_id FROM tickets WHERE id = $1`,
      [ticketId],
    );
    const row = t.rows[0];
    if (!row || row.org_id !== actor.orgId || !actor.venueIds.has(row.venue_id))
      throw new AppError('TICKET_NOT_FOUND');
    if (actor.role === 'driver' && (row.status === 'delivered' || row.status === 'voided'))
      throw new AppError('TICKET_NOT_FOUND');
    const detail = await loadTicketDetail(this.db, ticketId, { userId: actor.userId, role: actor.role });
    if (!detail) throw new AppError('TICKET_NOT_FOUND');
    return detail;
  }

  /** 07 GET /v1/me/home (DriverHome): the full sync snapshot of the driver (10 §2.6 head card). */
  async home(actor: ActorContext) {
    if (actor.role === 'driver' && !actor.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
    const now = this.clock.now();
    const viewer = { userId: actor.userId, role: actor.role };
    const dutyRow = (
      await this.db.query<DutyRow>(`SELECT * FROM duty_sessions WHERE user_id = $1 AND status <> 'ended'`, [
        actor.userId,
      ])
    ).rows[0];
    const venueId =
      dutyRow?.venue_id ??
      actor.assignment?.venueId ??
      (actor.venueIds.size === 1 ? [...actor.venueIds][0]! : null);
    const venue = venueId
      ? ((
          await this.db.query<{ id: string; code: string; name_ar: string }>(
            `SELECT id, code, name_ar FROM venues WHERE id = $1`,
            [venueId],
          )
        ).rows[0] ?? null)
      : null;
    const events = venueId
      ? (await listVenueEventsByStatus(this.db, venueId, ['open', 'closing'])).map((e) => ({
          id: e.id,
          name_ar: e.name_ar,
          status: e.status,
        }))
      : [];
    const assignment = actor.assignment
      ? (
          await this.db.query(
            `SELECT a.*, v.name_ar AS venue_name_ar FROM driver_assignments a JOIN venues v ON v.id = a.venue_id WHERE a.id = $1`,
            [actor.assignment.id],
          )
        ).rows[0]
      : null;
    const poolId =
      dutyRow?.dispatch_pool_id ??
      (venueId ? ((await findDefaultDispatchPool(this.db, venueId))?.id ?? null) : null);
    const shiftOpen = poolId ? !!(await findOpenShiftForPool(this.db, poolId)) : false;
    const state = await driverStateOf(this.db, actor.userId);
    const current = state?.active_task_id
      ? await loadTaskCard(this.db, state.active_task_id, viewer, now)
      : null;
    const next = state?.next_task_id ? await loadTaskCard(this.db, state.next_task_id, viewer, now) : null;

    // head card (10 §2.6): the oldest live round on which the driver is a recipient
    let offer: Record<string, unknown> | null = null;
    if (dutyRow && state) {
      const head = (
        await this.db.query<{
          offer_id: string;
          mode: 'single' | 'broadcast';
          expires_at: Date | null;
          reminder_at: Date | null;
          task_id: string;
          eligible_as: string;
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
        }>(
          `SELECT o.id AS offer_id, o.mode, o.expires_at, o.reminder_at, t.id AS task_id, r.eligible_as,
                  c.requested_at, k.display_number, e.name_ar AS event_name_ar, k.plate_country, k.plate_digits,
                  k.plate_letters_ar, k.plate_letters_en, k.plate_raw, k.vehicle_make, k.vehicle_color
             FROM task_offers o
             JOIN offer_recipients r ON r.offer_id = o.id AND r.user_id = $1
             JOIN tasks t ON t.id = o.task_id
             JOIN tickets k ON k.id = t.ticket_id
             JOIN events e ON e.id = k.event_id
             LEFT JOIN retrieval_cycles c ON c.id = t.cycle_id
            WHERE o.status = 'active' AND t.dispatch_pool_id = $2
            ORDER BY t.priority_at, t.seq
            LIMIT 1`,
          [actor.userId, dutyRow.dispatch_pool_id],
        )
      ).rows[0];
      if (head) {
        // eligibility is recomputed from the live state (10 §2.2): the stored eligible_as is display-only
        const eligibleAs =
          state.driver_state === 'available'
            ? 'accept'
            : state.driver_state === 'busy_with_next'
              ? 'view_only'
              : head.mode === 'broadcast'
                ? 'reserve_next'
                : 'view_only';
        const requestedAt = head.requested_at ? new Date(head.requested_at) : now;
        offer = {
          offer_id: head.offer_id,
          task_id: head.task_id,
          mode: head.mode,
          eligible_as: eligibleAs,
          expires_at: iso(head.expires_at),
          reminder_at: iso(head.reminder_at),
          server_time: now.toISOString(),
          ticket: {
            display_number: head.display_number,
            event_name_ar: head.event_name_ar,
            plate: plateView(head),
            vehicle: { make: head.vehicle_make, color: head.vehicle_color },
          },
          requested_at: requestedAt.toISOString(),
          waiting_seconds: Math.max(0, Math.floor((now.getTime() - requestedAt.getTime()) / 1000)),
          can_accept: eligibleAs === 'accept',
          can_reserve_next: eligibleAs === 'reserve_next',
          safety_note_ar:
            eligibleAs === 'reserve_next' ? 'احجز فقط وأنت متوقف؛ لا تستخدم الجوال أثناء القيادة' : null,
        };
      }
    }
    const draft = (
      await this.db.query<{ id: string }>(
        `SELECT t.id FROM tickets t JOIN tasks k ON k.ticket_id = t.id AND k.type = 'park' AND k.status = 'in_progress'
          WHERE t.created_by = $1 AND k.assignee_id = $1 AND t.status = 'received' ORDER BY t.created_at DESC LIMIT 1`,
        [actor.userId],
      )
    ).rows[0];
    const cash = (
      await this.db.query<{ n: number }>(
        `SELECT COALESCE(sum(p.amount_halalas), 0)::bigint AS n FROM payments p JOIN events e ON e.id = p.event_id
          WHERE p.collected_by = $1 AND p.method = 'cash' AND p.status = 'recorded' AND p.cash_handover_id IS NULL
            AND e.status IN ('open','closing')`,
        [actor.userId],
      )
    ).rows[0];
    const device = (
      await this.db.query<{
        audio_test_result: string | null;
        push_endpoint: string | null;
        display_mode: string;
      }>(
        `SELECT audio_test_result, push_endpoint, display_mode FROM devices
          WHERE id = (SELECT device_id FROM auth_sessions WHERE id = $1) AND revoked_at IS NULL`,
        [actor.sessionId],
      )
    ).rows[0];
    const channel = (
      await this.db.query<{ health_status: string }>(
        `SELECT health_status FROM whatsapp_channel WHERE org_id = $1 AND is_active LIMIT 1`,
        [actor.orgId],
      )
    ).rows[0];
    return {
      server_time: now.toISOString(),
      user: { id: actor.userId, full_name: actor.fullName, employee_code: actor.employeeCode },
      venue,
      open_events: events,
      active_assignment: assignment
        ? {
            id: assignment.id,
            driver_id: assignment.driver_id,
            venue_id: assignment.venue_id,
            venue_name_ar: assignment.venue_name_ar,
            status: assignment.status,
            starts_at: iso(assignment.starts_at),
            ends_at: iso(assignment.ends_at),
            reason: assignment.reason,
            transfer_id: assignment.transfer_id,
          }
        : null,
      shift_open: shiftOpen,
      duty_session: dutyRow ? dutySessionView(dutyRow) : null,
      driver_state: state?.driver_state ?? 'off_duty',
      connection_state: dutyRow?.connection_state ?? null,
      current_task: current,
      next_task: next,
      offer,
      draft_ticket_id: draft?.id ?? null,
      cash_outstanding_halalas: Number(cash?.n ?? 0),
      checks: {
        audio_tested: device?.audio_test_result === 'heard',
        push_enabled: !!device?.push_endpoint,
        pwa_installed: device?.display_mode === 'standalone',
      },
      channel_health: channel?.health_status ?? 'healthy',
    };
  }
}
