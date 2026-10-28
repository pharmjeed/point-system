import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../core/actor-context/actor-context.js';
import type { Database } from '../core/db/database.js';
import { AppError } from '../core/errors/app-error.js';
import { DATABASE } from '../http/tokens.js';
import { INCIDENT_SELECT, incidentView, type IncidentReadRow } from '../modules/incidents/index.js';
import {
  listTicketMedia,
  MediaReadUrlQuery,
  ObjectStorageError,
  type MediaDto,
} from '../modules/media/index.js';
import {
  cycleView,
  loadTicketSummary,
  TASK_SELECT,
  taskView,
  type CycleRow,
  type TaskReadRow,
} from '../modules/tickets-custody/index.js';
import {
  CUSTODY_EVENT_SELECT,
  custodyEventView,
  PAYMENT_SELECT,
  paymentView,
  WA_MESSAGE_COLUMNS,
  waMessageView,
  type CustodyEventRow,
  type PaymentRow,
  type WaMessageRow,
} from './supervisor-views.js';

interface TicketEventRow {
  id: number;
  type: string;
  actor_type: 'user' | 'customer' | 'system';
  actor_id: string | null;
  ticket_version: number;
  data: Record<string, any>;
  occurred_at: Date;
}

/** The messages a driver may follow on his ticket (09 §5.1: W-01 and W-05 status only, sent/failed). */
const DRIVER_MESSAGE_PURPOSES = new Set(['W-01', 'W-05']);

const isoTs = (d: Date) => new Date(d).toISOString();

/**
 * `GET /v1/tickets/{ticketId}/timeline` (PNT-076; S-03, 07 §2.2, 09 §5.1). One consistent read of everything that
 * happened to the ticket, oldest first: `ticket_events`, `custody_events`, retrieval cycles, tasks, WhatsApp
 * messages (text redacted: the handover code is stored masked, and what the customer typed is masked here —
 * phone numbers, codes, link codes), payments, incidents, and the photos with short-lived signed read URLs
 * (`media`, issued by the media module exactly as `GET /v1/media/{mediaId}/url` does).
 *
 * Visibility (`ticket.read_full`): staff in scope see everything. A driver only when he is the assignee of an
 * open task on the ticket or its creator during intake — then only the steps of his own tasks, no customer
 * message bodies (W-01 / W-05 status only), his own collections, no incidents; anyone else gets TICKET_NOT_FOUND.
 */
@Injectable()
export class TicketTimelineQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mediaUrls: MediaReadUrlQuery,
  ) {}

  async execute(actor: ActorContext, ticketId: string, requestId: string) {
    const read = await this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const head = await tx.maybeOne<{
        org_id: string;
        venue_id: string;
        status: string;
        created_by: string;
      }>(`SELECT org_id, venue_id, status, created_by FROM tickets WHERE id = $1`, [ticketId]);
      if (!head || head.org_id !== actor.orgId || !actor.venueIds.has(head.venue_id))
        throw new AppError('TICKET_NOT_FOUND');
      const staff = actor.role !== 'driver';
      const me = actor.userId;
      let myTasks = new Set<string>();
      if (!staff) {
        const open = await tx.maybeOne<{ assignee_id: string | null }>(
          `SELECT assignee_id FROM tasks WHERE ticket_id = $1 AND status NOT IN ('completed','canceled')`,
          [ticketId],
        );
        const creatorIntake =
          head.created_by === me && (head.status === 'received' || head.status === 'parking');
        if (open?.assignee_id !== me && !creatorIntake) throw new AppError('TICKET_NOT_FOUND');
        myTasks = new Set(
          (
            await tx.rows<{ id: string }>(`SELECT id FROM tasks WHERE ticket_id = $1 AND assignee_id = $2`, [
              ticketId,
              me,
            ])
          ).map((r) => r.id),
        );
      }

      const events = await tx.rows<TicketEventRow>(
        `SELECT id, type, actor_type, actor_id, ticket_version, data, occurred_at FROM ticket_events
          WHERE ticket_id = $1 ORDER BY occurred_at, id`,
        [ticketId],
      );
      // custody_events ids are random: within one instant the timeline row of each change gives the order
      const custody = await tx.rows<CustodyEventRow>(
        `${CUSTODY_EVENT_SELECT}
           LEFT JOIN ticket_events te ON te.ticket_id = ce.ticket_id AND te.type = 'custody.changed'
                                     AND te.data->>'custody_event_id' = ce.id::text
          WHERE ce.ticket_id = $1 ORDER BY ce.occurred_at, te.id NULLS LAST, ce.id`,
        [ticketId],
      );
      const cycles = await tx.rows<CycleRow>(
        `SELECT * FROM retrieval_cycles WHERE ticket_id = $1 ORDER BY cycle_no`,
        [ticketId],
      );
      const tasks = await tx.rows<TaskReadRow>(
        `${TASK_SELECT} WHERE k.ticket_id = $1 ORDER BY k.created_at, k.seq`,
        [ticketId],
      );
      const messages = await tx.rows<WaMessageRow>(
        `SELECT ${WA_MESSAGE_COLUMNS} FROM whatsapp_messages m WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
        [ticketId],
      );
      const payments = await tx.rows<PaymentRow>(
        `${PAYMENT_SELECT} WHERE p.ticket_id = $1 ORDER BY p.collected_at, p.id`,
        [ticketId],
      );
      const incidents = staff
        ? await tx.rows<IncidentReadRow>(
            `${INCIDENT_SELECT} WHERE i.ticket_id = $1 ORDER BY i.created_at, i.id`,
            [ticketId],
          )
        : [];
      const media = await listTicketMedia(tx, ticketId);

      const myCycles = new Set(tasks.filter((k) => myTasks.has(k.id) && k.cycle_id).map((k) => k.cycle_id!));
      const mine = (e: TicketEventRow) => {
        if (e.type.startsWith('wa.')) return false; // «دون رسائل العميل»
        const d = e.data ?? {};
        if (e.actor_type === 'user' && e.actor_id === me) return true;
        if (typeof d.task_id === 'string' && myTasks.has(d.task_id)) return true;
        if (typeof d.cycle_id === 'string' && myCycles.has(d.cycle_id)) return true;
        return [
          d.assignee_id,
          d.claimed_by,
          d.to_assignee_id,
          d.from_assignee_id,
          d.from?.id,
          d.to?.id,
        ].includes(me);
      };
      return {
        ticket: (await loadTicketSummary(tx, ticketId))!,
        events: (staff ? events : events.filter(mine)).map((e) => ({
          id: Number(e.id),
          type: e.type,
          actor_type: e.actor_type,
          actor_id: e.actor_id,
          ticket_version: e.ticket_version,
          data: e.data ?? {},
          occurred_at: isoTs(e.occurred_at),
        })),
        custody: (staff
          ? custody
          : custody.filter(
              (c) =>
                c.from_holder_id === me ||
                c.to_holder_id === me ||
                c.actor_id === me ||
                (c.task_id !== null && myTasks.has(c.task_id)),
            )
        ).map(custodyEventView),
        cycles: (staff ? cycles : cycles.filter((c) => myCycles.has(c.id))).map(cycleView),
        tasks: (staff ? tasks : tasks.filter((k) => myTasks.has(k.id))).map((k) =>
          taskView(k, { showAssignee: staff || k.assignee_id === me }),
        ),
        messages: staff
          ? messages.map((m) => waMessageView(m))
          : messages
              .filter(
                (m) => m.direction === 'outbound' && m.purpose && DRIVER_MESSAGE_PURPOSES.has(m.purpose),
              )
              .map((m) => waMessageView(m, { body: false })),
        payments: (staff ? payments : payments.filter((p) => p.collected_by === me)).map((p) =>
          paymentView(p, { staff: true }),
        ),
        incidents: incidents.map(incidentView),
        media,
      };
    });
    return { ...read, media: await this.withReadUrls(actor, read.media, requestId) };
  }

  /** Signed read URLs (≤ 300 s, 09 §6.3) for uploaded photos; issued and logged by the media module. */
  private async withReadUrls(actor: ActorContext, media: MediaDto[], requestId: string) {
    const out = [];
    for (const m of media) {
      let readUrl: { url: string; expires_at: string } | null = null;
      if (m.upload_status === 'uploaded') {
        try {
          readUrl = await this.mediaUrls.execute(actor, m.id, requestId);
        } catch (e) {
          // a photo the media rules do not let this reader open, or a storage hiccup: listed without a link
          if (!(e instanceof AppError) && !(e instanceof ObjectStorageError)) throw e;
        }
      }
      out.push({ ...m, read_url: readUrl });
    }
    return out;
  }
}
