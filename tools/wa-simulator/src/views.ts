import type { SimulatorState } from './store.js';
import type {
  ClaimCodeResult,
  Conversation,
  ConversationItem,
  ConversationSummary,
  OutboundMessage,
  StatusName,
} from './types.js';

// W-05 session-text fallback carries the same content as the template (docs/12 §8.4).
const CODE_IN_TEXT = /رمز التسليم\s*[:：]?\s*([0-9]{4,8})/;
const TICKET_IN_TEXT = /رقم\s+([0-9]+)/;

/** The handover code a customer sees in a W-05 message (template parameter {{2}} or the session-text fallback). */
export function claimCodeOf(msg: OutboundMessage): string | null {
  if (msg.type === 'template' && msg.purpose === 'W-05') return msg.bodyParams[1] ?? null;
  if (msg.type === 'text' && msg.text) return CODE_IN_TEXT.exec(msg.text)?.[1] ?? null;
  return null;
}

export function lastClaimCode(state: SimulatorState, to: string): ClaimCodeResult | null {
  const list = state.findMessages({ to });
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i] as OutboundMessage;
    const code = claimCodeOf(msg);
    if (!code) continue;
    const ticketNumber =
      msg.type === 'template'
        ? (msg.bodyParams[0] ?? null)
        : (TICKET_IN_TEXT.exec(msg.text ?? '')?.[1] ?? null);
    return {
      code,
      wamid: msg.wamid,
      ticketNumber,
      source: msg.type === 'template' ? 'template' : 'text',
      seq: msg.seq,
    };
  }
  return null;
}

const RANK: Record<StatusName, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };

/** What the business sees for the message: highest rank reached; `failed` only if never delivered (docs/12 §6.8). */
export function displayStatus(msg: OutboundMessage): StatusName | null {
  let best: StatusName | null = null;
  let failed = false;
  for (const s of msg.statuses) {
    if (s.status === 'failed') failed = true;
    else if (best === null || RANK[s.status] > RANK[best]) best = s.status;
  }
  if (failed && (best === null || RANK[best] < 2)) return 'failed';
  return best;
}

export function conversations(state: SimulatorState): ConversationSummary[] {
  const map = new Map<string, ConversationSummary>();
  const touch = (
    key: string,
    waId: string | null,
    userId: string | null,
    at: string,
    dir: 'out' | 'in',
  ): void => {
    const c = map.get(key) ?? {
      key,
      waId: null,
      userId: null,
      outbound: 0,
      inbound: 0,
      lastAt: null,
      claimCode: null,
    };
    c.waId ??= waId;
    c.userId ??= userId;
    if (dir === 'out') c.outbound += 1;
    else c.inbound += 1;
    if (c.lastAt === null || at > c.lastAt) c.lastAt = at;
    map.set(key, c);
  };
  for (const m of state.outbound) {
    touch(m.conversation, m.waId, m.userId, m.acceptedAt, 'out');
    const code = claimCodeOf(m);
    const c = map.get(m.conversation);
    if (code && c) c.claimCode = code;
  }
  for (const m of state.inbound) touch(m.conversation, m.from, m.userId, m.at, 'in');
  return [...map.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

export function conversation(state: SimulatorState, id: string): Conversation {
  const ident = state.identify(id);
  const items: ConversationItem[] = [];
  for (const m of state.outbound) {
    if (m.conversation !== ident.key && !(ident.userId && m.userId === ident.userId)) continue;
    items.push({
      direction: 'out',
      seq: m.seq,
      at: m.acceptedAt,
      wamid: m.wamid,
      kind: m.type === 'template' ? `template:${m.templateName}` : m.type,
      text: m.renderedText,
      templateName: m.templateName,
      purpose: m.purpose,
      buttons: m.buttons,
      status: displayStatus(m),
      claimCode: claimCodeOf(m),
    });
  }
  for (const m of state.inbound) {
    if (m.conversation !== ident.key && !(ident.userId && m.userId === ident.userId)) continue;
    items.push({
      direction: 'in',
      seq: m.seq,
      at: m.at,
      wamid: m.wamid,
      kind: m.type,
      text: m.text,
      templateName: null,
      purpose: null,
      buttons: [],
      status: null,
      claimCode: null,
    });
  }
  items.sort((a, b) => a.seq - b.seq);
  const outbound = items.filter((i) => i.direction === 'out').length;
  return {
    key: ident.key,
    waId: ident.waId,
    userId: ident.userId,
    outbound,
    inbound: items.length - outbound,
    lastAt: items.at(-1)?.at ?? null,
    claimCode: items.findLast((i) => i.claimCode !== null)?.claimCode ?? null,
    items,
  };
}
