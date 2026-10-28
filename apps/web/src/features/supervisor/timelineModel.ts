import type {
  CustodyEvent,
  CustodyHolderType,
  TicketDetail,
  TicketEvent,
  TicketTimeline,
  UserRef,
  WhatsAppMessage,
} from '@/api/types';
import type { TimelineEvent } from '@/components';
import {
  custodyHolder,
  custodyReason,
  mediaKind,
  s03,
  staff,
  ticketEventText,
  waLinkStatus,
  waMessageStatus,
} from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { formatTime } from '@/lib/format';

/**
 * S-03 timeline (02 S-03, 03 §3.16 `Timeline`): ticket events, custody events and WhatsApp messages merged in
 * time order, newest first like the wireframe. Customer message previews keep the server's redaction and are
 * masked again here: a handover code never reaches the screen (PNT-076 acceptance 1, DEC-38).
 */

export const CODE_MASK = '••••••';

/** Masks any standalone 6-digit run (a handover code) in a customer message preview. */
export function maskCodes(text: string): string {
  return text.replace(/(^|[^0-9])([0-9]{6})(?![0-9])/g, (_m, pre: string) => `${pre}${CODE_MASK}`);
}

/** Display names for the people of a ticket, from what the reply carries (no extra request). */
export function peopleIndex(
  detail?: TicketDetail | null,
  timeline?: TicketTimeline | null,
): Map<string, string> {
  const people = new Map<string, string>();
  const add = (u?: UserRef | null) => {
    if (u?.id && u.full_name) people.set(u.id, u.full_name);
  };
  if (detail) {
    add(detail.created_by);
    add(detail.parked_by);
    add(detail.retrieved_by);
    add(detail.delivered_by);
    add(detail.open_task?.assignee);
    add(detail.payment?.collected_by);
    for (const h of [detail.vehicle_holder, detail.key_holder])
      if (h?.id && h.label && (h.type === 'driver' || h.type === 'supervisor')) people.set(h.id, h.label);
  }
  if (timeline) {
    for (const c of timeline.custody) add(c.actor);
    for (const t of timeline.tasks) add(t.assignee);
    for (const p of timeline.payments) add(p.collected_by);
  }
  return people;
}

/** «السائق خالد» / «الخانة 12» / «العميل» — custody holder text (02 §8.2 «الحائز»). */
export function holderText(
  type: CustodyHolderType,
  id: string | null | undefined,
  people: Map<string, string>,
  labels: Map<string, string> = new Map(),
): string {
  const template = custodyHolder[type] ?? custodyHolder.unknown;
  if (type === 'driver' || type === 'supervisor') {
    const name = id ? people.get(id) : undefined;
    return name ? fmt(template, { name }) : template.replace(/\s*\{name\}/, '');
  }
  if (type === 'spot' || type === 'key_slot') {
    const label = id ? labels.get(id) : undefined;
    return label ? fmt(template, { label }) : template.replace(/\s*\{label\}/, '');
  }
  return template;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function ticketEventLine(e: TicketEvent, labels: Map<string, string>): string {
  const data = e.data ?? {};
  const label = (id: unknown) => (typeof id === 'string' ? (labels.get(id) ?? null) : null);
  switch (e.type) {
    case 'ticket.parked': {
      const spot = str(data.spot_label) ?? label(data.parking_spot_id);
      const slot = str(data.key_slot_label) ?? label(data.key_slot_id);
      return spot && slot
        ? fmt(ticketEventText['ticket.parked_at'], { spot, slot })
        : ticketEventText['ticket.parked'];
    }
    case 'ticket.wa_link_changed': {
      const status = str(data.wa_link_status) ?? str(data.to);
      const label = status ? (waLinkStatus as Record<string, string>)[status] : null;
      return label ? fmt(ticketEventText['ticket.wa_link_changed'], { status: label }) : e.type;
    }
    case 'ticket.photo_uploaded': {
      const kind = str(data.kind);
      const label = kind ? (mediaKind as Record<string, string>)[kind] : null;
      return label ? fmt(ticketEventText['ticket.photo_uploaded'], { kind: label }) : e.type;
    }
    default:
      return (ticketEventText as Record<string, string>)[e.type] ?? e.type;
  }
}

function actorText(e: TicketEvent, people: Map<string, string>): string {
  if (e.actor_type === 'system') return staff.system;
  if (e.actor_type === 'customer')
    return e.type === 'ticket.retrieval_requested' ? staff.customerViaWhatsapp : custodyHolder.customer;
  return (e.actor_id && people.get(e.actor_id)) || staff.none;
}

/** Custody chain line: «صف: السائق خالد ← الموقف A-03» (02 S-03 «من ← إلى»). */
export function custodyLine(
  c: CustodyEvent,
  people: Map<string, string>,
  labels?: Map<string, string>,
): string {
  const from = holderText(c.from_holder_type, c.from_holder_id, people, labels);
  const to = holderText(c.to_holder_type, c.to_holder_id, people, labels);
  return `${custodyReason[c.reason] ?? c.reason}: ${fmt(s03.custodyChain, { from, to })}`;
}

export const messageTime = (m: WhatsAppMessage): string | null =>
  m.received_at ?? m.failed_at ?? m.read_at ?? m.delivered_at ?? m.sent_at ?? m.queued_at ?? null;

/** «W-05 — وصلت» */
export function messageLine(m: WhatsAppMessage): string {
  const what = m.purpose ?? m.template_name ?? s03.messageDirection[m.direction];
  return `${what} — ${waMessageStatus[m.status] ?? m.status}`;
}

interface Stamped {
  at: number;
  item: TimelineEvent;
}

/** Spot / key-slot labels the detail carries (current spot and slot), keyed by id. */
export function layoutLabels(detail?: TicketDetail | null): Map<string, string> {
  const labels = new Map<string, string>();
  if (detail?.current_spot) labels.set(detail.current_spot.id, detail.current_spot.label);
  if (detail?.current_key_slot) labels.set(detail.current_key_slot.id, detail.current_key_slot.label);
  for (const h of [detail?.vehicle_holder, detail?.key_holder])
    if (h?.id && h.label && (h.type === 'spot' || h.type === 'key_slot')) labels.set(h.id, h.label);
  return labels;
}

/** Merged timeline for the `Timeline` component, newest first. */
export function buildTimeline(
  timeline: TicketTimeline,
  detail?: TicketDetail | null,
  labels: Map<string, string> = new Map(),
): TimelineEvent[] {
  const people = peopleIndex(detail, timeline);
  const out: Stamped[] = [];
  for (const e of timeline.events)
    out.push({
      at: Date.parse(e.occurred_at),
      item: {
        kind: 'ticket',
        text: ticketEventLine(e, labels),
        actor: actorText(e, people),
        time: formatTime(e.occurred_at),
      },
    });
  for (const c of timeline.custody)
    out.push({
      at: Date.parse(c.occurred_at),
      item: {
        kind: 'custody',
        text: custodyLine(c, people, labels),
        actor: c.actor?.full_name ?? staff.none,
        time: formatTime(c.occurred_at),
      },
    });
  for (const m of timeline.messages) {
    const at = messageTime(m);
    if (!at) continue;
    out.push({
      at: Date.parse(at),
      item: {
        kind: 'whatsapp',
        text: messageLine(m),
        actor: m.error_title ?? s03.messageDirection[m.direction],
        time: formatTime(at),
        message: m.body_redacted ? maskCodes(m.body_redacted) : undefined,
        failed: m.status === 'failed',
      },
    });
  }
  return out.sort((a, b) => b.at - a.at).map((s) => s.item);
}
