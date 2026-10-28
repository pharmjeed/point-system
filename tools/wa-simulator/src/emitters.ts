import { brand } from './catalog.js';
import { HttpError } from './http-util.js';
import { newWamid, unixSeconds } from './ids.js';
import type { SimulatorState } from './store.js';
import type {
  EmitResult,
  InboundMessage,
  InboundOptions,
  InteractiveOptions,
  PressOptions,
  RawWebhookOptions,
  StatusName,
  StatusOptions,
  TextOptions,
} from './types.js';
import {
  bodyVariant,
  contactOf,
  deliverCopies,
  emitStatusSequence,
  inboundMessage,
  messagesEnvelope,
  resolveSender,
  type Sender,
  wamidsOf,
  webhookUrlFor,
  type WebhookPayload,
} from './webhook.js';

const MAX_COPIES = 1000;

function count(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_COPIES) {
    throw new HttpError(400, 'invalid_option', `${name} must be an integer between 1 and ${MAX_COPIES}`);
  }
  return value;
}

function delay(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new HttpError(400, 'invalid_option', 'delayMs must be ≥ 0');
  return value;
}

function timestampOf(value: number | string | undefined): string {
  try {
    return unixSeconds(value);
  } catch (err) {
    throw new HttpError(400, 'invalid_option', err instanceof Error ? err.message : String(err));
  }
}

interface Built {
  payload: WebhookPayload;
  record: Omit<InboundMessage, 'seq' | 'at' | 'wamid' | 'timestamp'>;
}

/**
 * Emits one inbound message `copies` times following `duplicateMode`, records it in the conversation
 * and returns what was delivered.
 */
async function emitInbound(
  state: SimulatorState,
  opts: InboundOptions,
  kind: string,
  build: (wamid: string, timestamp: string) => Built,
): Promise<EmitResult> {
  const url = webhookUrlFor(state, opts.webhookUrl);
  const copies = count(opts.copies, 1, 'copies');
  const parallel = count(opts.parallel, 1, 'parallel');
  const delayMs = delay(opts.delayMs);
  const mode = opts.duplicateMode ?? 'same_body';
  const identicalFirst =
    opts.identicalFirst === undefined ? 1 : count(opts.identicalFirst, 1, 'identicalFirst');
  const fixedTs = opts.timestamp !== undefined ? timestampOf(opts.timestamp) : undefined;
  const payloads: unknown[] = [];
  const wamids: string[] = [];

  const record = (wamid: string, timestamp: string, b: Built): void => {
    state.addInbound({ ...b.record, wamid, timestamp, seq: state.nextSeq(), at: new Date().toISOString() });
    payloads.push(b.payload);
    wamids.push(wamid);
  };

  const meta = { kind, wamids, url, ...(opts.signature ? { signature: opts.signature } : {}) };
  if (mode === 'distinct') {
    const deliveries = await deliverCopies(
      state,
      copies,
      parallel,
      delayMs,
      () => {
        const wamid = newWamid();
        const ts = fixedTs ?? unixSeconds();
        const b = build(wamid, ts);
        record(wamid, ts, b);
        return { raw: JSON.stringify(b.payload), wamids: [wamid] };
      },
      meta,
    );
    return { wamids, deliveries, payloads };
  }
  const wamid = newWamid();
  const ts = fixedTs ?? unixSeconds();
  const b = build(wamid, ts);
  record(wamid, ts, b);
  const base = JSON.stringify(b.payload);
  const deliveries = await deliverCopies(
    state,
    copies,
    parallel,
    delayMs,
    (i) =>
      mode === 'same_body' || i < identicalFirst ? base : bodyVariant(b.payload, i - identicalFirst + 1),
    meta,
  );
  return { wamids, deliveries, payloads };
}

function baseRecord(
  s: Sender,
  type: InboundMessage['type'],
): Pick<InboundMessage, 'type' | 'from' | 'userId' | 'conversation' | 'bsuidOnly'> {
  return {
    type,
    from: s.bsuidOnly ? null : s.waId,
    userId: s.userId,
    conversation: s.key,
    bsuidOnly: s.bsuidOnly,
  };
}

/**
 * Presses the quick-reply button of a sent template (W-01 «طلب السيارة»): a `type: "button"` webhook with the
 * stored payload and `context.id` = that message. `from` may differ from the recipient (AC-02).
 */
export function pressButton(state: SimulatorState, opts: PressOptions): Promise<EmitResult> {
  const selector = { ...opts };
  if (!selector.wamid && !selector.to && opts.from) selector.to = opts.from;
  const msg = state.selectMessage(selector, { withButtons: opts.payloadOverride === undefined });
  const index = opts.buttonIndex ?? 0;
  const button = msg.buttons.find((b) => b.index === index);
  if (!button && opts.payloadOverride === undefined) {
    throw new HttpError(
      404,
      'button_not_found',
      `message ${msg.wamid} has no quick-reply button at index ${index}`,
    );
  }
  const text = button?.text ?? brand().requestButtonText;
  // Meta returns the button text as payload when no payload was set at send time.
  const payload = opts.payloadOverride ?? button?.payload ?? text;
  const sender = resolveSender(state, opts, { waId: msg.waId, userId: msg.userId });
  return emitInbound(state, opts, 'button', (wamid, timestamp) => ({
    payload: messagesEnvelope(
      state,
      {
        contacts: [contactOf(state, sender)],
        messages: [
          inboundMessage(
            state,
            sender,
            { wamid, timestamp, type: 'button', contextId: opts.omitContext ? null : msg.wamid },
            { button: { payload, text } },
          ),
        ],
      },
      opts.phoneNumberId ?? msg.phoneNumberId,
    ),
    record: {
      ...baseRecord(sender, 'button'),
      text,
      buttonPayload: payload,
      buttonText: text,
      contextId: opts.omitContext ? null : msg.wamid,
    },
  }));
}

/** Customer free text (also link codes and stop keywords). */
export function sendInboundText(state: SimulatorState, opts: TextOptions): Promise<EmitResult> {
  if (typeof opts.body !== 'string' || opts.body.length === 0) {
    throw new HttpError(400, 'body_required', 'text body is required');
  }
  const sender = resolveSender(state, opts);
  const contextId = opts.contextWamid ?? null;
  return emitInbound(state, opts, 'text', (wamid, timestamp) => ({
    payload: messagesEnvelope(
      state,
      {
        contacts: [contactOf(state, sender)],
        messages: [
          inboundMessage(
            state,
            sender,
            { wamid, timestamp, type: 'text', contextId },
            { text: { body: opts.body } },
          ),
        ],
      },
      opts.phoneNumberId,
    ),
    record: {
      ...baseRecord(sender, 'text'),
      text: opts.body,
      buttonPayload: null,
      buttonText: null,
      contextId,
    },
  }));
}

/** The prefilled QR text «ربط تذكرة … CODE» (docs/12 §7.2) sent by the customer. */
export function sendLinkCode(
  state: SimulatorState,
  opts: InboundOptions & { code: string },
): Promise<EmitResult> {
  if (typeof opts.code !== 'string' || opts.code.trim() === '') {
    throw new HttpError(400, 'code_required', 'link code is required');
  }
  return sendInboundText(state, { ...opts, body: `${brand().linkCodePrefix} ${opts.code.trim()}` });
}

export function sendStop(
  state: SimulatorState,
  opts: InboundOptions & { keyword?: string },
): Promise<EmitResult> {
  return sendInboundText(state, { ...opts, body: opts.keyword ?? brand().stopKeyword });
}

/** `type: "interactive"` / `button_reply` (we never send interactive messages; the API treats it as unknown). */
export function sendInteractive(state: SimulatorState, opts: InteractiveOptions): Promise<EmitResult> {
  if (!opts.id || !opts.title) throw new HttpError(400, 'invalid_option', 'id and title are required');
  const sender = resolveSender(state, opts);
  const contextId = opts.contextWamid ?? null;
  return emitInbound(state, opts, 'interactive', (wamid, timestamp) => ({
    payload: messagesEnvelope(
      state,
      {
        contacts: [contactOf(state, sender)],
        messages: [
          inboundMessage(
            state,
            sender,
            { wamid, timestamp, type: 'interactive', contextId },
            { interactive: { type: 'button_reply', button_reply: { id: opts.id, title: opts.title } } },
          ),
        ],
      },
      opts.phoneNumberId,
    ),
    record: {
      ...baseRecord(sender, 'interactive'),
      text: opts.title,
      buttonPayload: opts.id,
      buttonText: opts.title,
      contextId,
    },
  }));
}

const STATUS_NAMES: readonly StatusName[] = ['sent', 'delivered', 'read', 'failed'];

/** Status webhooks for a sent message in natural / reversed / duplicated / reorder / shuffled order. */
export async function emitStatuses(state: SimulatorState, opts: StatusOptions): Promise<EmitResult> {
  const msg = state.selectMessage(opts);
  const statuses = opts.statuses ?? (msg.plannedFailure ? ['failed'] : state.config.statusSequence);
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((s) => !STATUS_NAMES.includes(s))) {
    throw new HttpError(
      400,
      'invalid_option',
      `statuses must be a non-empty list of ${STATUS_NAMES.join(', ')}`,
    );
  }
  const deliveries = await emitStatusSequence(state, msg, {
    statuses,
    order: opts.order ?? 'natural',
    delayMs: delay(opts.delayMs),
    copies: count(opts.copies, 1, 'copies'),
    ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
    ...(opts.timestamp !== undefined ? { timestamp: timestampOf(opts.timestamp) } : {}),
    ...(opts.signature ? { signature: opts.signature } : {}),
    ...(opts.webhookUrl ? { url: opts.webhookUrl } : {}),
    ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
  });
  return { wamids: [msg.wamid], deliveries, payloads: [] };
}

/** Any payload (object or exact raw string), signed or deliberately mis-signed. */
export async function emitRaw(state: SimulatorState, opts: RawWebhookOptions): Promise<EmitResult> {
  if (opts.body === undefined) throw new HttpError(400, 'body_required', 'body is required');
  const raw = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  let parsed: unknown = opts.body;
  if (typeof opts.body === 'string') {
    try {
      parsed = JSON.parse(opts.body);
    } catch {
      parsed = null;
    }
  }
  const wamids = wamidsOf(parsed);
  const deliveries = await deliverCopies(
    state,
    count(opts.copies, 1, 'copies'),
    count(opts.parallel, 1, 'parallel'),
    0,
    () => raw,
    {
      kind: 'raw',
      wamids,
      url: webhookUrlFor(state, opts.webhookUrl),
      ...(opts.signature ? { signature: opts.signature } : {}),
    },
  );
  return { wamids, deliveries, payloads: [parsed] };
}
