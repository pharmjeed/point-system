import type { DomainEventType } from '@point/shared';
import type { EventEnvelope, Tx } from '../../../core/db/tx.js';
import { venueSettings } from '../../../core/settings/settings-service.js';

/**
 * Projection of every domain event of canon §7.1 to the properties of its analytics event (15 §7).
 *
 * Inputs, in order of preference: the event payload (11 §8; producers may add the analytics inputs listed
 * in 15 §7 directly), then the entity timestamps stored by the producing command (15 §13.3: durations from
 * the stored stamps, never from the projection time; the end of a duration is the event's `occurred_at`,
 * i.e. the producing transaction's `now`). A value that cannot be derived is `null`. Projections only read.
 */
export interface ProjectionContext {
  tx: Tx;
  env: EventEnvelope<Record<string, any>>;
  /** the domain payload */
  p: Record<string, any>;
  /** `occurred_at` of the envelope */
  at: Date;
}

export interface Projection {
  properties: Record<string, unknown>;
  ticketId?: string | null;
  taskId?: string | null;
  cycleId?: string | null;
}

export type Projector = (ctx: ProjectionContext) => Promise<Projection>;

// ---------------------------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const uuidOrNull = (v: unknown): string | null => (isUuid(v) ? v : null);

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
const toDate = (v: unknown): Date | null => {
  if (v instanceof Date) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
};
/** Whole seconds from `from` to `to` (never negative); null when a stamp is missing. */
const secs = (from: unknown, to: unknown): number | null => {
  const a = toDate(from);
  const b = toDate(to);
  return a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000)) : null;
};
const millis = (from: unknown, to: unknown): number | null => {
  const a = toDate(from);
  const b = toDate(to);
  return a && b ? Math.max(0, b.getTime() - a.getTime()) : null;
};

const ticketIdOf = (ctx: ProjectionContext): string | null =>
  uuidOrNull(ctx.p.ticket?.ticket_id) ??
  uuidOrNull(ctx.p.ticket_id) ??
  (ctx.env.aggregate?.type === 'ticket' ? uuidOrNull(ctx.env.aggregate.id) : null);
const taskIdOf = (ctx: ProjectionContext): string | null =>
  uuidOrNull(ctx.p.task_id) ?? (ctx.env.aggregate?.type === 'task' ? uuidOrNull(ctx.env.aggregate.id) : null);

// ---------------------------------------------------------------------------------------------
// reads (no locks)
// ---------------------------------------------------------------------------------------------

async function first<R>(tx: Tx, text: string, params: unknown[]): Promise<R | null> {
  return ((await tx.rows(text, params))[0] as R | undefined) ?? null;
}
const byId = <R>(tx: Tx, table: string, id: string | null, cols = '*') =>
  id ? first<R>(tx, `SELECT ${cols} FROM ${table} WHERE id = $1`, [id]) : Promise.resolve(null);

const ticket = (tx: Tx, id: string | null) =>
  id
    ? first<Record<string, any>>(
        tx,
        `SELECT t.*, e.pricing_mode AS event_pricing_mode FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1`,
        [id],
      )
    : Promise.resolve(null);
const cycle = (tx: Tx, id: string | null) => byId<Record<string, any>>(tx, 'retrieval_cycles', id);
const task = (tx: Tx, id: string | null) => byId<Record<string, any>>(tx, 'tasks', id);
const offer = (tx: Tx, id: string | null) => byId<Record<string, any>>(tx, 'task_offers', id);

async function userRole(tx: Tx, id: unknown): Promise<string | null> {
  if (!isUuid(id)) return null;
  return (await first<{ role: string }>(tx, `SELECT role FROM users WHERE id = $1`, [id]))?.role ?? null;
}

async function count(tx: Tx, text: string, params: unknown[]): Promise<number> {
  return (await first<{ n: number }>(tx, text, params))?.n ?? 0;
}

const availableDrivers = (tx: Tx, poolId: string | null) =>
  poolId
    ? count(
        tx,
        `SELECT count(*)::int AS n FROM v_driver_state WHERE dispatch_pool_id = $1 AND driver_state = 'available'`,
        [poolId],
      )
    : Promise.resolve(null);

const uploadedPhotos = (tx: Tx, ticketId: string | null, at: Date) =>
  ticketId
    ? count(
        tx,
        `SELECT count(*)::int AS n FROM media_assets
          WHERE ticket_id = $1 AND upload_status = 'uploaded' AND COALESCE(uploaded_at, created_at) <= $2`,
        [ticketId, at],
      )
    : Promise.resolve(null);

async function hasRecordedPayment(tx: Tx, ticketId: string | null): Promise<boolean | null> {
  if (!ticketId) return null;
  return (
    (await count(tx, `SELECT count(*)::int AS n FROM payments WHERE ticket_id = $1 AND status = 'recorded'`, [
      ticketId,
    ])) > 0
  );
}

async function acceptedRound(tx: Tx, taskId: string | null) {
  if (!taskId) return null;
  return first<{ mode: string; round_no: number }>(
    tx,
    `SELECT mode, round_no FROM task_offers WHERE task_id = $1 AND status = 'accepted' ORDER BY round_no DESC LIMIT 1`,
    [taskId],
  );
}

// ---------------------------------------------------------------------------------------------
// enums used by the projections (the shared catalog validates the result)
// ---------------------------------------------------------------------------------------------

const CHANNELS = ['whatsapp', 'paper', 'app'] as const;
const PRICING = ['included', 'per_vehicle'] as const;
const OFFER_MODES = ['single', 'broadcast'] as const;
const TASK_TYPES = ['park', 'retrieve', 'repark'] as const;
const VERIFY = ['code', 'paper_stub', 'supervisor_exception'] as const;

const ticketBase = (ctx: ProjectionContext, extra: Partial<Projection> = {}): Partial<Projection> => ({
  ticketId: ticketIdOf(ctx),
  taskId: taskIdOf(ctx),
  cycleId: uuidOrNull(ctx.p.cycle_id),
  ...extra,
});

/** Every domain event type → its projection (15 §13.2: TypeScript enforces the coverage). */
export const PROJECTIONS = {
  // ------------------------------------------------------------------ §7.1 ticket
  'ticket.created': async (ctx) => {
    const t = await ticket(ctx.tx, ticketIdOf(ctx));
    return {
      ...ticketBase(ctx, { taskId: uuidOrNull(ctx.p.park_task_id) }),
      properties: {
        channel: pick(ctx.p.channel ?? t?.channel, CHANNELS),
        pricing_mode: pick(ctx.p.pricing_mode ?? t?.event_pricing_mode, PRICING),
      },
    };
  },
  'ticket.intake_submitted': async (ctx) => {
    const id = ticketIdOf(ctx);
    const t = await ticket(ctx.tx, id);
    const link = ctx.p.wa_link_status ?? t?.wa_link_status;
    return {
      ...ticketBase(ctx),
      properties: {
        channel: pick(ctx.p.channel ?? t?.channel, CHANNELS),
        inspection_status: pick(ctx.p.inspection_status ?? t?.inspection_status, [
          'complete',
          'incomplete',
          'exception_approved',
        ]),
        photos_count: int(ctx.p.photos_count) ?? (await uploadedPhotos(ctx.tx, id, ctx.at)),
        has_customer_phone: bool(ctx.p.has_customer_phone) ?? (t ? t.customer_id !== null : null),
        wa_link_method:
          pick(ctx.p.wa_link_method, ['direct', 'qr', 'none']) ??
          (link === undefined
            ? null
            : link === 'pending_send'
              ? 'direct'
              : link === 'pending_confirmation' || link === 'linked'
                ? 'qr'
                : 'none'),
        intake_duration_s: secs(t?.created_at, t?.submitted_at ?? ctx.at),
      },
    };
  },
  'ticket.parked': async (ctx) => {
    const id = ticketIdOf(ctx);
    const [t, k] = [await ticket(ctx.tx, id), await task(ctx.tx, uuidOrNull(ctx.p.task_id))];
    const type = pick(ctx.p.task_type ?? k?.type, ['park', 'repark']);
    const isRepark = type === null ? null : type === 'repark';
    const early =
      bool(ctx.p.had_pending_retrieval) ??
      (id
        ? (await count(
            ctx.tx,
            `SELECT count(*)::int AS n FROM retrieval_cycles
              WHERE ticket_id = $1 AND requested_early AND requested_at <= $2 AND (closed_at IS NULL OR closed_at >= $2)`,
            [id, ctx.at],
          )) > 0
        : null);
    return {
      ...ticketBase(ctx),
      properties: {
        parking_duration_s: isRepark ? secs(k?.created_at, ctx.at) : secs(t?.submitted_at, ctx.at),
        spot_mode: ctx.p.parking_spot_id
          ? 'spot'
          : ctx.p.has_spot_note === true
            ? 'note'
            : t?.current_spot_id
              ? 'spot'
              : t?.current_spot_note
                ? 'note'
                : null,
        key_slot_used:
          'key_slot_id' in ctx.p ? ctx.p.key_slot_id != null : t ? t.current_key_slot_id !== null : null,
        had_pending_retrieval: early,
        is_repark: isRepark,
      },
    };
  },
  'ticket.retrieval_requested': async (ctx) => {
    const c = await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id));
    const pool = uuidOrNull(ctx.env.dispatch_pool_id);
    const requestedAt = toDate(ctx.p.requested_at) ?? toDate(c?.requested_at) ?? ctx.at;
    return {
      ...ticketBase(ctx),
      properties: {
        request_source: pick(ctx.p.request_source ?? c?.request_source, ['whatsapp', 'staff', 'app']),
        cycle_no: int(ctx.p.cycle_no) ?? int(c?.cycle_no),
        requested_early: bool(ctx.p.requested_early) ?? bool(c?.requested_early),
        queue_depth:
          int(ctx.p.queue_depth) ??
          (pool
            ? await count(
                ctx.tx,
                `SELECT count(*)::int AS n FROM tasks
                  WHERE dispatch_pool_id = $1 AND type = 'retrieve' AND status IN ('queued','offered','broadcast') AND priority_at <= $2`,
                [pool, requestedAt],
              )
            : null),
        available_drivers: int(ctx.p.available_drivers) ?? (await availableDrivers(ctx.tx, pool)),
        ingest_latency_ms: int(ctx.p.ingest_latency_ms),
      },
    };
  },
  'ticket.retrieval_requested_early': async (ctx) => {
    const t = await ticket(ctx.tx, ticketIdOf(ctx));
    return {
      ...ticketBase(ctx),
      properties: {
        request_source: pick(ctx.p.request_source ?? 'whatsapp', ['whatsapp', 'app']),
        status_at_request: pick(ctx.p.status_at_request ?? t?.status, ['received', 'parking', 'reparking']),
      },
    };
  },
  'ticket.assigned': async (ctx) => {
    const taskId = taskIdOf(ctx);
    const [c, round] = [await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id)), await acceptedRound(ctx.tx, taskId)];
    const via = ctx.p.via;
    return {
      ...ticketBase(ctx),
      properties: {
        wait_s: secs(c?.requested_at, ctx.at),
        offer_mode: pick(via, OFFER_MODES) ?? (via === 'promotion' ? pick(round?.mode, OFFER_MODES) : null),
        offer_round_no:
          via === 'single' || via === 'broadcast' || via === 'promotion' ? (round?.round_no ?? null) : null,
      },
    };
  },
  'ticket.assigned_waiting': async (ctx) => {
    const [c, round] = [
      await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id)),
      await acceptedRound(ctx.tx, taskIdOf(ctx)),
    ];
    return {
      ...ticketBase(ctx),
      properties: {
        wait_s: secs(c?.requested_at, ctx.at),
        offer_round_no: ctx.p.via === 'broadcast' ? (round?.round_no ?? null) : null,
      },
    };
  },
  'ticket.retrieving': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    return {
      ...ticketBase(ctx),
      properties: {
        start_after_claim_s: secs(k?.claimed_at, ctx.at),
        from_next_task: k ? k.assigned_waiting_at !== null : null,
      },
    };
  },
  'ticket.ready': async (ctx) => {
    const [c, k] = [await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id)), await task(ctx.tx, taskIdOf(ctx))];
    return {
      ...ticketBase(ctx),
      properties: {
        request_to_ready_s: secs(c?.requested_at, ctx.at),
        retrieval_duration_s: secs(c?.started_at ?? k?.started_at, ctx.at),
      },
    };
  },
  'ticket.delivered': async (ctx) => {
    const [t, c] = [await ticket(ctx.tx, ticketIdOf(ctx)), await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id))];
    return {
      ...ticketBase(ctx),
      properties: {
        ready_to_delivered_s: secs(c?.ready_at, ctx.at),
        request_to_delivered_s: secs(c?.requested_at, ctx.at),
        verification_method: pick(ctx.p.method ?? c?.handover_method, VERIFY),
        payment_status: pick(ctx.p.payment_status ?? t?.payment_status, [
          'not_required',
          'collected',
          'waived',
        ]),
        cycle_no: int(c?.cycle_no),
        ticket_lifetime_s: secs(t?.created_at, ctx.at),
      },
    };
  },
  'ticket.reparking': async (ctx) => {
    const cycleId = uuidOrNull(ctx.p.closed_cycle_id) ?? uuidOrNull(ctx.p.cycle_id);
    const c = await cycle(ctx.tx, cycleId);
    return {
      ...ticketBase(ctx, { cycleId, taskId: uuidOrNull(ctx.p.repark_task_id) }),
      properties: {
        cause: pick(ctx.p.cause, ['customer_absent', 'supervisor_cancel']),
        ready_wait_s: secs(c?.ready_at, ctx.at),
        cycle_no: int(c?.cycle_no),
      },
    };
  },
  'ticket.retrieval_canceled': async (ctx) => {
    const c = await cycle(ctx.tx, uuidOrNull(ctx.p.cycle_id));
    return {
      ...ticketBase(ctx),
      properties: {
        status_at_cancel: pick(ctx.p.previous_status, [
          'requested',
          'assigned',
          'assigned_waiting',
          'retrieving',
          'ready',
        ]),
        canceled_by_role: pick(await userRole(ctx.tx, ctx.p.canceled_by), ['driver', 'supervisor']),
        after_s: secs(c?.requested_at, ctx.at),
      },
    };
  },
  'ticket.voided': async (ctx) => {
    const t = await ticket(ctx.tx, ticketIdOf(ctx));
    const via = ctx.p.via;
    const from =
      ctx.p.voided_from_status ??
      ctx.p.previous_status ??
      (via === 'discard_draft' ? 'received' : t ? (t.submitted_at ? 'parking' : 'received') : null);
    return {
      ...ticketBase(ctx),
      properties: {
        voided_from_status: pick(from, ['received', 'parking']),
        had_data: bool(ctx.p.had_data) ?? (via === 'discard_draft' ? false : via === 'void' ? true : null),
      },
    };
  },
  'ticket.customer_phone_changed': async (ctx) => ({
    ...ticketBase(ctx),
    properties: {
      changed_by_role: pick(await userRole(ctx.tx, ctx.p.changed_by ?? ctx.env.actor?.id), [
        'driver',
        'supervisor',
        'admin',
      ]),
    },
  }),
  'ticket.wa_link_changed': async (ctx) => {
    const statuses = [
      'none',
      'pending_send',
      'pending_confirmation',
      'linked',
      'failed',
      'opted_out',
    ] as const;
    return {
      ...ticketBase(ctx),
      properties: {
        from_status: pick(ctx.p.from, statuses),
        to_status: pick(ctx.p.to, statuses),
        method: pick(ctx.p.method, ['direct', 'qr']),
      },
    };
  },
  'ticket.inspection_completed': async (ctx) => {
    const id = ticketIdOf(ctx);
    const t = await ticket(ctx.tx, id);
    return {
      ...ticketBase(ctx),
      properties: {
        photos_count: int(ctx.p.photos_count) ?? (await uploadedPhotos(ctx.tx, id, ctx.at)),
        after_submit_s: secs(t?.submitted_at, ctx.at),
      },
    };
  },
  'ticket.inspection_exception_approved': async (ctx) => {
    const id = ticketIdOf(ctx);
    let missing = int(ctx.p.missing_photos_count);
    const t = missing === null ? await ticket(ctx.tx, id) : null;
    if (missing === null && t) {
      const required = (await venueSettings(ctx.tx, t.venue_id)).inspection.required_photos;
      const kinds = new Set(
        (
          await ctx.tx.rows<{ kind: string }>(
            `SELECT DISTINCT kind FROM media_assets WHERE ticket_id = $1 AND upload_status = 'uploaded'`,
            [id],
          )
        ).map((r) => r.kind),
      );
      missing = required.filter((k) => !kinds.has(k)).length;
    }
    return { ...ticketBase(ctx), properties: { missing_photos_count: missing } };
  },
  'ticket.manually_reconciled': async (ctx) => {
    const statuses = [
      'received',
      'parking',
      'parked',
      'requested',
      'assigned',
      'assigned_waiting',
      'retrieving',
      'ready',
      'delivered',
      'reparking',
      'voided',
    ] as const;
    return {
      ...ticketBase(ctx),
      properties: {
        target_status: pick(ctx.p.target_status, ['parked', 'delivered', 'voided']),
        from_status: pick(ctx.p.previous_status, statuses),
        had_payment: await hasRecordedPayment(ctx.tx, ticketIdOf(ctx)),
      },
    };
  },

  // ------------------------------------------------------------------ §7.2 task and offer
  'task.created': async (ctx) => {
    const k = ctx.p.type ? null : await task(ctx.tx, taskIdOf(ctx));
    return { ...ticketBase(ctx), properties: { type: pick(ctx.p.type ?? k?.type, TASK_TYPES) } };
  },
  'task.offered': async (ctx) => {
    const o = int(ctx.p.round_no) === null ? await offer(ctx.tx, uuidOrNull(ctx.p.offer_id)) : null;
    return {
      ...ticketBase(ctx),
      properties: {
        round_no: int(ctx.p.round_no) ?? int(o?.round_no),
        available_drivers:
          int(ctx.p.available_drivers) ??
          (await availableDrivers(ctx.tx, uuidOrNull(ctx.env.dispatch_pool_id))),
      },
    };
  },
  'task.broadcast_opened': async (ctx) => {
    let recipients: { eligible_as?: unknown }[] | null = Array.isArray(ctx.p.recipients)
      ? ctx.p.recipients
      : null;
    const offerId = uuidOrNull(ctx.p.offer_id);
    if (!recipients && offerId)
      recipients = await ctx.tx.rows(`SELECT eligible_as FROM offer_recipients WHERE offer_id = $1`, [
        offerId,
      ]);
    const o = int(ctx.p.round_no) === null ? await offer(ctx.tx, offerId) : null;
    const by = (e: string) => (recipients ? recipients.filter((r) => r.eligible_as === e).length : null);
    return {
      ...ticketBase(ctx),
      properties: {
        round_no: int(ctx.p.round_no) ?? int(o?.round_no),
        recipient_count: recipients ? recipients.length : null,
        eligible_accept_count: by('accept'),
        eligible_reserve_count: by('reserve_next'),
        view_only_count: by('view_only'),
      },
    };
  },
  'task.broadcast_extended': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { added_recipients: Array.isArray(ctx.p.added) ? ctx.p.added.length : null },
  }),
  'task.claimed': async (ctx) => {
    const [k, o] = [await task(ctx.tx, taskIdOf(ctx)), await offer(ctx.tx, uuidOrNull(ctx.p.offer_id))];
    const claimedAt = toDate(ctx.p.claimed_at) ?? toDate(k?.claimed_at) ?? ctx.at;
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: {
        mode: pick(ctx.p.mode ?? o?.mode, OFFER_MODES),
        round_no: int(o?.round_no),
        result: pick(ctx.p.result, ['accepted', 'assigned_waiting']),
        claim_latency_s: secs(k?.queued_at, claimedAt),
        offer_latency_s: secs(o?.created_at, claimedAt),
      },
    };
  },
  'task.promoted': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: { waited_as_next_s: secs(k?.assigned_waiting_at, ctx.at) },
    };
  },
  'task.key_picked_up': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: { after_accept_s: secs(k?.accepted_at, ctx.at) },
    };
  },
  'task.started': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    const type = pick(ctx.p.type ?? k?.type, TASK_TYPES);
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: {
        type,
        after_claim_s: type === 'retrieve' ? secs(k?.claimed_at, ctx.p.started_at ?? ctx.at) : null,
      },
    };
  },
  'task.completed': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    const type = pick(ctx.p.type ?? k?.type, TASK_TYPES);
    const from = type === 'retrieve' ? (k?.accepted_at ?? k?.claimed_at) : k?.created_at;
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: { type, duration_s: secs(from, ctx.p.completed_at ?? k?.completed_at ?? ctx.at) },
    };
  },
  'task.canceled': async (ctx) => {
    const k = ctx.p.type ? null : await task(ctx.tx, taskIdOf(ctx));
    return {
      ...ticketBase(ctx),
      properties: {
        type: pick(ctx.p.type ?? k?.type, TASK_TYPES),
        status_at_cancel: pick(ctx.p.previous_status, [
          'queued',
          'offered',
          'broadcast',
          'assigned_waiting',
          'accepted',
          'in_progress',
        ]),
      },
    };
  },
  'task.withdrawn': async (ctx) => {
    const k = await task(ctx.tx, taskIdOf(ctx));
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(k?.cycle_id) }),
      properties: {
        status_at_withdrawal: pick(ctx.p.previous_status, ['assigned_waiting', 'accepted']),
        key_was_picked_up: bool(ctx.p.key_was_picked_up) ?? (k ? k.key_picked_up_at !== null : null),
      },
    };
  },
  'task.reassigned': async (ctx) => {
    const statuses = [
      'queued',
      'offered',
      'broadcast',
      'assigned_waiting',
      'accepted',
      'in_progress',
      'completed',
      'canceled',
    ] as const;
    return {
      ...ticketBase(ctx),
      properties: {
        from_status: pick(ctx.p.from_status ?? ctx.p.previous_status, statuses),
        target:
          pick(ctx.p.target, ['queue', 'driver']) ??
          ('to_assignee_id' in ctx.p ? (ctx.p.to_assignee_id ? 'driver' : 'queue') : null),
      },
    };
  },
  'task.escalated': async (ctx) => {
    const id = taskIdOf(ctx);
    const k = int(ctx.p.waited_s) === null ? await task(ctx.tx, id) : null;
    const active = id
      ? await first<{ mode: string }>(
          ctx.tx,
          `SELECT mode FROM task_offers WHERE task_id = $1 AND status = 'active' LIMIT 1`,
          [id],
        )
      : null;
    return {
      ...ticketBase(ctx, { cycleId: uuidOrNull(ctx.p.cycle_id) }),
      properties: {
        after_s: int(ctx.p.waited_s) ?? secs(ctx.p.queued_at ?? k?.queued_at, ctx.at),
        mode_at_escalation:
          pick(ctx.p.mode_at_escalation, ['none', 'single', 'broadcast']) ??
          (id ? (pick(active?.mode, OFFER_MODES) ?? 'none') : null),
        on_duty_drivers: int(ctx.p.on_duty_count) ?? int(ctx.p.on_duty_drivers),
      },
    };
  },
  'offer.reminded': async (ctx) => {
    const o = await offer(ctx.tx, uuidOrNull(ctx.p.offer_id));
    return {
      ...ticketBase(ctx),
      properties: { mode: pick(ctx.p.mode ?? o?.mode, OFFER_MODES), round_no: int(o?.round_no) },
    };
  },
  'offer.expired': async (ctx) => {
    const o = await offer(ctx.tx, uuidOrNull(ctx.p.offer_id));
    const next = o
      ? await first<{ mode: string }>(
          ctx.tx,
          `SELECT mode FROM task_offers WHERE task_id = $1 AND round_no > $2 ORDER BY round_no LIMIT 1`,
          [o.task_id, o.round_no],
        )
      : null;
    return {
      ...ticketBase(ctx, { taskId: taskIdOf(ctx) ?? uuidOrNull(o?.task_id) }),
      properties: {
        mode: pick(ctx.p.mode ?? o?.mode ?? 'single', OFFER_MODES),
        round_no: int(o?.round_no),
        next_action:
          pick(ctx.p.next_action, ['next_single', 'broadcast']) ??
          (next?.mode === 'single' ? 'next_single' : next?.mode === 'broadcast' ? 'broadcast' : null),
      },
    };
  },
  'offer.revoked': async (ctx) => {
    const o = ctx.p.mode && ctx.p.close_reason ? null : await offer(ctx.tx, uuidOrNull(ctx.p.offer_id));
    return {
      ...ticketBase(ctx),
      properties: {
        mode: pick(ctx.p.mode ?? o?.mode, OFFER_MODES),
        close_reason: pick(ctx.p.close_reason ?? o?.close_reason, [
          'claimed_elsewhere',
          'task_canceled',
          'reassigned',
          'recipient_unavailable',
          'converted_to_broadcast',
          'converted_to_single',
          'transfer',
        ]),
      },
    };
  },

  // ------------------------------------------------------------------ §7.3 driver and custody
  'driver.duty_started': async (ctx) => {
    const user = uuidOrNull(ctx.p.user_id) ?? uuidOrNull(ctx.env.actor?.id);
    const d = user
      ? await first<Record<string, any>>(
          ctx.tx,
          `SELECT audio_test_result, notification_permission, display_mode, platform FROM devices
            WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1`,
          [user],
        )
      : null;
    return {
      properties: {
        audio_test_result: d
          ? (pick(d.audio_test_result, ['heard', 'not_heard', 'blocked']) ?? 'none')
          : null,
        notification_permission: pick(d?.notification_permission, [
          'default',
          'granted',
          'denied',
          'unsupported',
        ]),
        display_mode: pick(d?.display_mode, ['browser', 'standalone']),
        platform: pick(d?.platform, ['ios', 'android', 'desktop', 'other']),
      },
    };
  },
  'driver.break_started': async () => ({ properties: {} }),
  'driver.break_ended': async (ctx) => {
    let duration = int(ctx.p.break_duration_s) ?? secs(ctx.p.break_started_at, ctx.at);
    const user = uuidOrNull(ctx.p.user_id) ?? uuidOrNull(ctx.env.actor?.id);
    if (duration === null && user) {
      const started = await first<{ occurred_at: Date }>(
        ctx.tx,
        `SELECT occurred_at FROM analytics_events
          WHERE name = 'driver_break_started' AND actor_id = $1 AND occurred_at <= $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [user, ctx.at],
      );
      duration = secs(started?.occurred_at, ctx.at);
    }
    return { properties: { break_duration_s: duration } };
  },
  'driver.duty_ended': async (ctx) => {
    const d = await byId<Record<string, any>>(ctx.tx, 'duty_sessions', uuidOrNull(ctx.p.duty_session_id));
    const user = uuidOrNull(ctx.p.user_id) ?? uuidOrNull(d?.user_id);
    const completed =
      d && user
        ? await count(
            ctx.tx,
            `SELECT count(*)::int AS n FROM tasks
              WHERE assignee_id = $1 AND status = 'completed' AND completed_at >= $2 AND completed_at <= $3`,
            [user, d.started_at, d.ended_at ?? ctx.at],
          )
        : null;
    return {
      properties: {
        duty_duration_s: secs(d?.started_at, d?.ended_at ?? ctx.at),
        end_reason: pick(ctx.p.end_reason ?? d?.end_reason, [
          'self',
          'forced',
          'transfer',
          'disabled',
          'shift_closed',
        ]),
        tasks_completed: completed,
      },
    };
  },
  'driver.availability_changed': async (ctx) => {
    const states = [
      'off_duty',
      'on_break',
      'available',
      'intake_parking',
      'retrieving',
      'busy_with_next',
    ] as const;
    return {
      ...ticketBase(ctx, { ticketId: null, taskId: uuidOrNull(ctx.p.active_task_id) }),
      properties: {
        from_state: pick(ctx.p.from_state ?? ctx.p.previous_state, states),
        to_state: pick(ctx.p.to_state ?? ctx.p.driver_state, states),
      },
    };
  },
  'driver.connection_changed': async (ctx) => {
    const states = ['online', 'uncertain', 'offline'] as const;
    const user = uuidOrNull(ctx.p.user_id) ?? uuidOrNull(ctx.env.actor?.id);
    const custody =
      bool(ctx.p.had_custody) ??
      bool(ctx.p.holds_custody) ??
      (user
        ? (await count(
            ctx.tx,
            `SELECT count(*)::int AS n FROM tickets
              WHERE status NOT IN ('delivered','voided')
                AND ((vehicle_holder_type = 'driver' AND vehicle_holder_id = $1) OR (key_holder_type = 'driver' AND key_holder_id = $1))`,
            [user],
          )) > 0
        : null);
    const active =
      bool(ctx.p.had_active_task) ??
      (user
        ? (await count(
            ctx.tx,
            `SELECT count(*)::int AS n FROM tasks WHERE assignee_id = $1 AND status IN ('accepted','in_progress')`,
            [user],
          )) > 0
        : null);
    return {
      properties: {
        from: pick(ctx.p.from, states),
        to: pick(ctx.p.to ?? ctx.p.connection_state, states),
        had_custody: custody,
        had_active_task: active,
      },
    };
  },
  'driver.transfer_requested': async (ctx) => ({
    properties: { scheduled_in_s: secs(ctx.at, ctx.p.scheduled_at) },
  }),
  'driver.transfer_blocked': async (ctx) => {
    const items: { type?: unknown }[] = Array.isArray(ctx.p.items) ? ctx.p.items : [];
    const types = [
      ...new Set(
        items
          .map((i) => (i.type === 'task' ? 'active_task' : i.type))
          .filter((t): t is string => t === 'vehicle' || t === 'key' || t === 'active_task'),
      ),
    ].sort();
    return { properties: { blocker_types: Array.isArray(ctx.p.items) ? types : null } };
  },
  'driver.transferred': async () => ({ properties: {} }),
  'driver.disabled': async () => ({ properties: {} }),
  'driver.enabled': async () => ({ properties: {} }),
  'custody.changed': async (ctx) => {
    const holders = ['customer', 'driver', 'spot', 'key_slot', 'supervisor', 'unknown'] as const;
    return {
      ...ticketBase(ctx),
      properties: {
        subject: pick(ctx.p.subject, ['vehicle', 'key']),
        custody_reason: pick(ctx.p.reason, [
          'intake',
          'parked',
          'key_deposited',
          'key_pickup',
          'retrieval_start',
          'handover',
          'repark',
          'official_transfer',
          'withdrawal_release',
          'manual_reconcile',
          'correction',
        ]),
        from_holder_type: pick(ctx.p.from?.type, holders),
        to_holder_type: pick(ctx.p.to?.type, holders),
      },
    };
  },

  // ------------------------------------------------------------------ §7.4 handover and payment
  'handover.code_issued': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { resend_no: int(ctx.p.resend_no) },
  }),
  'handover.code_attempt_failed': async (ctx) => ({
    ...ticketBase(ctx),
    properties: {
      attempt_no: int(ctx.p.attempts) ?? int(ctx.p.attempt_no),
      attempts_left: int(ctx.p.attempts_left),
    },
  }),
  'handover.code_locked': async (ctx) => ({ ...ticketBase(ctx), properties: {} }),
  'handover.completed': async (ctx) => {
    const cycleId = uuidOrNull(ctx.p.cycle_id);
    const code =
      int(ctx.p.failed_attempts) === null && cycleId
        ? await first<{ attempts: number }>(
            ctx.tx,
            `SELECT attempts FROM claim_codes WHERE cycle_id = $1 ORDER BY issued_at DESC LIMIT 1`,
            [cycleId],
          )
        : null;
    return {
      ...ticketBase(ctx),
      properties: {
        verification_method: pick(ctx.p.method, VERIFY),
        failed_attempts: int(ctx.p.failed_attempts) ?? (code ? int(code.attempts) : null),
      },
    };
  },
  'handover.exception_approved': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { had_payment: await hasRecordedPayment(ctx.tx, ticketIdOf(ctx)) },
  }),
  'payment.recorded': async (ctx) => ({
    ...ticketBase(ctx),
    properties: {
      method: pick(ctx.p.method, ['cash', 'pos']),
      amount_halalas: int(ctx.p.amount_halalas),
      source: pick(ctx.p.source, ['separate', 'handover', 'exception', 'reconcile', 'replacement']),
    },
  }),
  'payment.reversed': async (ctx) => {
    const id =
      uuidOrNull(ctx.p.payment_id) ??
      (ctx.env.aggregate?.type === 'payment' ? uuidOrNull(ctx.env.aggregate.id) : null);
    const pay = await byId<Record<string, any>>(ctx.tx, 'payments', id);
    const replaced =
      bool(ctx.p.with_replacement) ??
      (pay
        ? (await count(
            ctx.tx,
            `SELECT count(*)::int AS n FROM payments WHERE ticket_id = $1 AND id <> $2 AND status = 'recorded'`,
            [pay.ticket_id, pay.id],
          )) > 0
        : null);
    return {
      ...ticketBase(ctx, { ticketId: ticketIdOf(ctx) ?? uuidOrNull(pay?.ticket_id) }),
      properties: {
        method: pick(ctx.p.method ?? pay?.method, ['cash', 'pos']),
        amount_halalas: int(ctx.p.amount_halalas) ?? int(pay?.amount_halalas),
        with_replacement: replaced,
        after_cash_handover: bool(ctx.p.after_cash_handover) ?? (pay ? pay.cash_handover_id !== null : null),
      },
    };
  },
  // V2-022 (DEC-522): the visit paid in the app (POINT's money, no method of the operator's), and its full refund
  'payment.online_paid': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { amount_halalas: int(ctx.p.amount_halalas) },
  }),
  'payment.online_refunded': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { amount_halalas: int(ctx.p.amount_halalas) },
  }),
  'payment.waived': async (ctx) => {
    const t = int(ctx.p.amount_halalas) === null ? await ticket(ctx.tx, ticketIdOf(ctx)) : null;
    return {
      ...ticketBase(ctx),
      properties: { amount_halalas: int(ctx.p.amount_halalas) ?? int(t?.fee_halalas) },
    };
  },
  'cash.handover_recorded': async (ctx) => {
    const id =
      uuidOrNull(ctx.p.cash_handover_id) ??
      (ctx.env.aggregate?.type === 'cash_handover' ? uuidOrNull(ctx.env.aggregate.id) : null);
    const ch = await byId<Record<string, any>>(ctx.tx, 'cash_handovers', id);
    const linked =
      int(ctx.p.linked_payments_count) ??
      (ch
        ? await count(ctx.tx, `SELECT count(*)::int AS n FROM payments WHERE cash_handover_id = $1`, [ch.id])
        : null);
    return {
      properties: {
        amount_halalas: int(ctx.p.amount_halalas) ?? int(ch?.amount_halalas),
        expected_halalas: int(ctx.p.expected_halalas) ?? int(ch?.expected_halalas),
        difference_halalas: int(ctx.p.difference_halalas) ?? int(ch?.difference_halalas),
        linked_payments_count: linked,
      },
    };
  },

  // ------------------------------------------------------------------ §7.5 alerts, incidents, event, shift
  'alert.raised': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { type: ctx.p.type ?? null, severity: ctx.p.severity ?? null },
  }),
  'alert.acknowledged': async (ctx) => {
    const a = await byId<Record<string, any>>(ctx.tx, 'alerts', uuidOrNull(ctx.p.alert_id));
    return {
      ...ticketBase(ctx, { ticketId: uuidOrNull(a?.ticket_id), taskId: uuidOrNull(a?.task_id) }),
      properties: { type: ctx.p.type ?? a?.type ?? null, ack_after_s: secs(a?.raised_at, ctx.at) },
    };
  },
  'alert.resolved': async (ctx) => {
    const a = await byId<Record<string, any>>(ctx.tx, 'alerts', uuidOrNull(ctx.p.alert_id));
    return {
      ...ticketBase(ctx, { ticketId: uuidOrNull(a?.ticket_id), taskId: uuidOrNull(a?.task_id) }),
      properties: {
        type: ctx.p.type ?? a?.type ?? null,
        resolved_by_system: bool(ctx.p.auto),
        open_duration_s: secs(a?.raised_at, ctx.at),
      },
    };
  },
  'incident.opened': async (ctx) => ({
    ...ticketBase(ctx),
    properties: {
      type: ctx.p.type ?? null,
      severity: ctx.p.severity ?? null,
      auto_created: bool(ctx.p.auto_created) ?? ctx.env.actor?.type === 'system',
    },
  }),
  'incident.updated': async (ctx) => ({
    ...ticketBase(ctx),
    properties: { type: ctx.p.type ?? null, status: ctx.p.status ?? null },
  }),
  'incident.resolved': async (ctx) => {
    const i = await byId<Record<string, any>>(ctx.tx, 'incidents', uuidOrNull(ctx.p.incident_id));
    return {
      ...ticketBase(ctx),
      properties: { type: ctx.p.type ?? i?.type ?? null, open_duration_s: secs(i?.created_at, ctx.at) },
    };
  },
  'event.opened': async (ctx) => {
    const e = await byId<Record<string, any>>(ctx.tx, 'events', eventIdOf(ctx));
    return { properties: { pricing_mode: pick(e?.pricing_mode, PRICING) } };
  },
  'event.closing_started': async (ctx) => {
    const id = eventIdOf(ctx);
    return {
      properties: {
        open_tickets: id
          ? await count(
              ctx.tx,
              `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND status NOT IN ('delivered','voided')`,
              [id],
            )
          : null,
      },
    };
  },
  'event.closed': async (ctx) => {
    const id = eventIdOf(ctx);
    const e = await byId<Record<string, any>>(ctx.tx, 'events', id);
    const t = id
      ? await first<{ total: number; delivered: number; voided: number }>(
          ctx.tx,
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
                  count(*) FILTER (WHERE status = 'voided')::int AS voided
             FROM tickets WHERE event_id = $1`,
          [id],
        )
      : null;
    const c = id
      ? await first<{ reparked: number; canceled: number }>(
          ctx.tx,
          `SELECT count(*) FILTER (WHERE rc.outcome = 'reparked')::int AS reparked,
                  count(*) FILTER (WHERE rc.outcome = 'canceled')::int AS canceled
             FROM retrieval_cycles rc JOIN tickets tk ON tk.id = rc.ticket_id WHERE tk.event_id = $1`,
          [id],
        )
      : null;
    return {
      properties: {
        tickets_total: t?.total ?? null,
        delivered: t?.delivered ?? null,
        voided: t?.voided ?? null,
        reparked_cycles: c?.reparked ?? null,
        canceled_cycles: c?.canceled ?? null,
        closing_duration_s: secs(e?.closing_started_at, e?.closed_at ?? ctx.at),
      },
    };
  },
  'shift.opened': async () => ({ properties: {} }),
  'shift.closed': async (ctx) => {
    const id =
      uuidOrNull(ctx.p.shift_id) ??
      (ctx.env.aggregate?.type === 'shift' ? uuidOrNull(ctx.env.aggregate.id) : null);
    return {
      properties: {
        duty_sessions_count: id
          ? await count(ctx.tx, `SELECT count(*)::int AS n FROM duty_sessions WHERE shift_id = $1`, [id])
          : null,
      },
    };
  },

  // ------------------------------------------------------------------ §7.6 WhatsApp
  'wa.inbound_received': async (ctx) => {
    const kinds: Record<string, string> = {
      inbound_text: 'text',
      inbound_button: 'button',
      inbound_interactive: 'interactive',
      inbound_other: 'other',
    };
    return {
      ...ticketBase(ctx),
      properties: {
        kind: typeof ctx.p.kind === 'string' ? (kinds[ctx.p.kind] ?? null) : null,
        matched: pick(ctx.p.matched, ['action_token', 'link_code', 'opt_out', 'none']),
      },
    };
  },
  'wa.button_pressed': async (ctx) => {
    const results = [
      'request_created',
      'status_reply',
      'rejected_sender',
      'rejected_stale',
      'ticket_closed',
    ] as const;
    let result = pick(ctx.p.result, results);
    if (!result) {
      const o = ctx.p.outcome;
      if (o === 'request_created' || o === 'early_request') result = 'request_created';
      else if (o === 'status_reply') result = 'status_reply';
      else if (o === 'rejected')
        result =
          ctx.p.reject_reason === 'sender_mismatch'
            ? 'rejected_sender'
            : ctx.p.reject_reason
              ? 'rejected_stale'
              : null;
    }
    return { ...ticketBase(ctx), properties: { result } };
  },
  'wa.message_status_changed': async (ctx) => {
    const m = await byId<{ queued_at: Date | null }>(
      ctx.tx,
      'whatsapp_messages',
      uuidOrNull(ctx.p.whatsapp_message_id),
      'queued_at',
    );
    return {
      ...ticketBase(ctx),
      properties: {
        purpose: ctx.p.purpose ?? null,
        status: pick(ctx.p.status, ['sent', 'delivered', 'read', 'failed']),
        error_code:
          typeof ctx.p.error_code === 'string' && /^[0-9]{1,10}$/.test(ctx.p.error_code)
            ? ctx.p.error_code
            : typeof ctx.p.error_code === 'number' && Number.isInteger(ctx.p.error_code)
              ? String(ctx.p.error_code)
              : null,
        since_queued_ms: millis(m?.queued_at, ctx.at),
      },
    };
  },
  'wa.channel_health_changed': async (ctx) => {
    const states = ['healthy', 'degraded', 'down'] as const;
    return { properties: { from: pick(ctx.p.from, states), to: pick(ctx.p.to, states) } };
  },
  'wa.customer_opted_out': async () => ({ properties: {} }),
} satisfies Record<DomainEventType, Projector>;

function eventIdOf(ctx: ProjectionContext): string | null {
  return (
    uuidOrNull(ctx.p.event_id) ??
    (ctx.env.aggregate?.type === 'event' ? uuidOrNull(ctx.env.aggregate.id) : null) ??
    uuidOrNull(ctx.env.event_id)
  );
}
