import { statusErrorEntry } from './graph-errors.js';
import { HttpError, isRecord } from './http-util.js';
import { digitsOnly, mask, sha256Hex, unixSeconds } from './ids.js';
import { signWebhookBody, SIGNATURE_HEADER } from './signature.js';
import type { SimulatorState } from './store.js';
import type { OutboundMessage, SignatureMode, StatusName, StatusOrder, WebhookDelivery } from './types.js';

export interface WebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    time?: number;
    changes: Array<{ value: Record<string, unknown>; field: string }>;
  }>;
}

export interface Sender {
  waId: string | null;
  userId: string | null;
  bsuidOnly: boolean;
  profileName: string;
  key: string;
}

export function isBsuidOnlyNumber(state: SimulatorState, waId: string | null): boolean {
  return state.config.deterministicFaults && waId !== null && waId.endsWith('2222');
}

/** Sender of an inbound message: explicit `from`/`userId`, else the fallback (the recipient of a sent message). */
export function resolveSender(
  state: SimulatorState,
  opts: { from?: string; userId?: string; bsuidOnly?: boolean; profileName?: string },
  fallback?: { waId: string | null; userId: string | null },
): Sender {
  let waId: string | null = null;
  let userId: string | null = opts.userId ?? null;
  if (opts.from) {
    const id = state.identify(opts.from);
    waId = id.waId;
    userId ??= id.userId;
  } else if (fallback) {
    waId = fallback.waId;
    userId ??= fallback.userId;
  } else if (userId) {
    waId = state.identities.get(userId) ?? null;
  }
  if (!waId && !userId)
    throw new HttpError(400, 'sender_required', 'give `from` (phone) or `userId` (BSUID)');
  if (waId && userId) state.identities.set(userId, waId);
  const bsuidOnly = opts.bsuidOnly ?? (waId === null || isBsuidOnlyNumber(state, waId));
  if (bsuidOnly && !userId) throw new HttpError(400, 'sender_required', 'a BSUID-only sender needs a userId');
  return {
    waId,
    userId,
    bsuidOnly,
    profileName: opts.profileName ?? `عميل ${(waId ?? userId ?? '').slice(-4)}`,
    key: waId ?? (userId as string),
  };
}

function metadata(state: SimulatorState, phoneNumberId?: string): Record<string, string> {
  return {
    display_phone_number: digitsOnly(state.config.displayPhoneE164),
    phone_number_id: phoneNumberId ?? state.effectivePhoneNumberId(),
  };
}

export function messagesEnvelope(
  state: SimulatorState,
  value: Record<string, unknown>,
  phoneNumberId?: string,
): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: state.config.wabaId,
        changes: [
          {
            value: { messaging_product: 'whatsapp', metadata: metadata(state, phoneNumberId), ...value },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

export function contactOf(state: SimulatorState, s: Sender): Record<string, unknown> {
  const c: Record<string, unknown> = { profile: { name: s.profileName } };
  if (!s.bsuidOnly && s.waId) c.wa_id = s.waId;
  if (s.userId && (state.config.includeUserIds || s.bsuidOnly)) c.user_id = s.userId;
  return c;
}

/** `messages[]` entry: context, from, from_user_id, id, timestamp, type, then the type object. */
export function inboundMessage(
  state: SimulatorState,
  s: Sender,
  fields: { wamid: string; timestamp: string; type: string; contextId?: string | null },
  content: Record<string, unknown>,
): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (fields.contextId) m.context = { from: digitsOnly(state.config.displayPhoneE164), id: fields.contextId };
  if (!s.bsuidOnly && s.waId) m.from = s.waId;
  if (s.userId && (state.config.includeUserIds || s.bsuidOnly)) m.from_user_id = s.userId;
  m.id = fields.wamid;
  m.timestamp = fields.timestamp;
  m.type = fields.type;
  return { ...m, ...content };
}

export function orderStatuses(seq: readonly StatusName[], order: StatusOrder): StatusName[] {
  switch (order) {
    case 'natural':
      return [...seq];
    case 'reversed':
      return [...seq].reverse();
    case 'duplicated':
      return seq.flatMap((s) => [s, s]);
    case 'reorder': {
      // docs/12 §11.4: `read` before `sent`, and `delivered` after `read`.
      const rest = seq.filter((s) => s !== 'read');
      return seq.includes('read') ? ['read', ...rest] : rest;
    }
    case 'shuffled': {
      const out = [...seq];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j] as StatusName, out[i] as StatusName];
      }
      return out;
    }
  }
}

export function statusEntry(
  state: SimulatorState,
  msg: OutboundMessage,
  status: StatusName,
  opts: { timestamp?: number | string; errorCode?: number; pricing?: boolean } = {},
): Record<string, unknown> {
  const e: Record<string, unknown> = { id: msg.wamid, status, timestamp: unixSeconds(opts.timestamp) };
  const bsuidOnly = msg.waId === null || isBsuidOnlyNumber(state, msg.waId);
  if (!bsuidOnly && msg.waId) e.recipient_id = msg.waId;
  if (msg.userId && (state.config.includeUserIds || bsuidOnly)) e.recipient_user_id = msg.userId;
  if (msg.bizOpaqueCallbackData !== null) e.biz_opaque_callback_data = msg.bizOpaqueCallbackData;
  // docs/12 F-11: pricing appears in `sent` (or in delivered/read, never both); the simulator puts it on `sent`.
  if (status === 'sent' && opts.pricing !== false) {
    const template = msg.type === 'template';
    e.pricing = {
      billable: template,
      pricing_model: 'PMP',
      category: template ? 'utility' : 'service',
      type: template ? 'regular' : 'free_customer_service',
    };
  }
  if (status === 'failed')
    e.errors = [statusErrorEntry(opts.errorCode ?? msg.plannedFailure?.code ?? 131026)];
  return e;
}

/** Message ids carried by a payload (messages[].id and statuses[].id). */
export function wamidsOf(payload: unknown): string[] {
  const ids: string[] = [];
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return ids;
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      for (const key of ['messages', 'statuses'] as const) {
        const list = change.value[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) if (isRecord(item) && typeof item.id === 'string') ids.push(item.id);
      }
    }
  }
  return ids;
}

export function webhookUrlFor(state: SimulatorState, override?: string): string {
  const url = override ?? state.config.webhookUrl;
  if (!url) {
    throw new HttpError(
      409,
      'webhook_url_not_configured',
      'no webhook target: set WEBHOOK_URL, PATCH /_sim/config {"webhookUrl"}, or pass webhookUrl',
    );
  }
  return url;
}

/** `TypeError: fetch failed (ECONNREFUSED)` — undici hides the useful part in `cause`. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const detail =
    typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : null;
  return `${err.name}: ${err.message}${detail ? ` (${detail})` : ''}`;
}

export interface DeliverMeta {
  kind: string;
  wamids: string[];
  signature?: SignatureMode;
  url?: string;
}

/** Signs the exact raw bytes and POSTs them like Meta does; retries non-2xx answers when configured. */
export async function deliver(
  state: SimulatorState,
  raw: string,
  meta: DeliverMeta,
): Promise<WebhookDelivery> {
  const url = webhookUrlFor(state, meta.url);
  const signature = meta.signature ?? 'valid';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'facebookexternalua',
  };
  if (signature === 'valid') headers[SIGNATURE_HEADER] = signWebhookBody(state.config.appSecret, raw);
  if (signature === 'invalid')
    headers[SIGNATURE_HEADER] = signWebhookBody(`${state.config.appSecret}:wrong`, raw);

  const epoch = state.epoch;
  const started = Date.now();
  const delivery: WebhookDelivery = {
    id: state.nextDeliveryId(),
    kind: meta.kind,
    url,
    at: new Date(started).toISOString(),
    signature,
    bodySha256: sha256Hex(raw),
    wamids: meta.wamids,
    attempts: 0,
    httpStatus: null,
    ok: false,
    error: null,
    durationMs: 0,
  };
  const maxAttempts = 1 + Math.max(0, state.config.webhookRetries);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    delivery.attempts = attempt;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(state.config.webhookTimeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);
      delivery.httpStatus = res.status;
      delivery.ok = res.ok;
      delivery.error = res.ok ? null : `HTTP ${res.status}`;
    } catch (err) {
      delivery.httpStatus = null;
      delivery.ok = false;
      delivery.error = describeFetchError(err);
    }
    if (delivery.ok || attempt === maxAttempts) break;
    if (!(await state.sleep(state.config.webhookRetryDelayMs * 2 ** (attempt - 1), epoch))) break;
  }
  delivery.durationMs = Date.now() - started;
  if (epoch === state.epoch) state.addDelivery(delivery); // not into the log of a later reset
  state.log(
    `webhook ${meta.kind} → ${delivery.httpStatus ?? delivery.error} (sig=${signature}, attempts=${delivery.attempts}, ids=${meta.wamids.length})`,
  );
  return delivery;
}

/** Runs `copies` deliveries, `parallel` at a time, waiting `delayMs` between batches. */
export async function deliverCopies(
  state: SimulatorState,
  copies: number,
  parallel: number,
  delayMs: number,
  makeBody: (i: number) => string | { raw: string; wamids: string[] },
  meta: DeliverMeta,
): Promise<WebhookDelivery[]> {
  const out: WebhookDelivery[] = [];
  const width = Math.max(1, parallel);
  const epoch = state.epoch;
  for (let i = 0; i < copies; i += width) {
    if (i > 0 && !(await state.sleep(delayMs, epoch))) break;
    const batch: Promise<WebhookDelivery>[] = [];
    for (let j = i; j < Math.min(i + width, copies); j++) {
      const body = makeBody(j);
      const raw = typeof body === 'string' ? body : body.raw;
      const wamids = typeof body === 'string' ? meta.wamids : body.wamids;
      batch.push(deliver(state, raw, { ...meta, wamids: [...wamids] }));
    }
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

/**
 * The same JSON in a different raw form (copy 0 is compact): parsed content and wamid stay identical
 * while `body_sha256` differs — "same wamid, different bodies" (docs/12 §11.4 dup10).
 */
export function bodyVariant(payload: unknown, i: number): string {
  if (i === 0) return JSON.stringify(payload);
  if (i <= 10) return JSON.stringify(payload, null, i);
  return JSON.stringify(payload) + ' '.repeat(i - 10);
}

export function statusPayload(
  state: SimulatorState,
  msg: OutboundMessage,
  status: StatusName,
  opts: { timestamp?: number | string; errorCode?: number; pricing?: boolean } = {},
): WebhookPayload {
  return messagesEnvelope(state, { statuses: [statusEntry(state, msg, status, opts)] }, msg.phoneNumberId);
}

function recordStatus(msg: OutboundMessage, status: StatusName, errorCode?: number): void {
  msg.statuses.push({
    status,
    at: new Date().toISOString(),
    ...(status === 'failed' ? { errorCode: errorCode ?? msg.plannedFailure?.code ?? 131026 } : {}),
  });
}

export interface StatusEmission {
  statuses: StatusName[];
  order: StatusOrder;
  delayMs: number;
  copies?: number;
  errorCode?: number;
  timestamp?: number | string;
  signature?: SignatureMode;
  url?: string;
  pricing?: boolean;
  /** Wait `delayMs` before the first status too (auto statuses). */
  leadingDelay?: boolean;
}

/** Emits a status sequence for one message; `duplicated` (and copies) repeat byte-identical bodies. */
export async function emitStatusSequence(
  state: SimulatorState,
  msg: OutboundMessage,
  e: StatusEmission,
): Promise<WebhookDelivery[]> {
  const url = webhookUrlFor(state, e.url);
  const ordered = orderStatuses(e.statuses, e.order);
  const bodies = new Map<StatusName, string>();
  const deliveries: WebhookDelivery[] = [];
  const epoch = state.epoch;
  let first = true;
  for (const status of ordered) {
    let raw = bodies.get(status);
    if (raw === undefined) {
      raw = JSON.stringify(
        statusPayload(state, msg, status, {
          ...(e.timestamp !== undefined ? { timestamp: e.timestamp } : {}),
          ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}),
          ...(e.pricing !== undefined ? { pricing: e.pricing } : {}),
        }),
      );
      bodies.set(status, raw);
    }
    for (let c = 0; c < Math.max(1, e.copies ?? 1); c++) {
      if ((!first || e.leadingDelay) && !(await state.sleep(e.delayMs, epoch))) return deliveries;
      first = false;
      recordStatus(msg, status, e.errorCode);
      deliveries.push(
        await deliver(state, raw, {
          kind: `status:${status}`,
          wamids: [msg.wamid],
          url,
          ...(e.signature ? { signature: e.signature } : {}),
        }),
      );
    }
  }
  return deliveries;
}

/** After an accepted send: sent → delivered → read (or `failed` when a failure is planned), in the background. */
export function scheduleAutoStatuses(state: SimulatorState, msg: OutboundMessage): void {
  const c = state.config;
  if (!c.autoStatuses || !c.webhookUrl) return;
  let delayMs = c.statusDelayMs;
  const override = state.statusDelayOverride;
  if (override && override.remaining > 0) {
    delayMs = override.delayMs;
    override.remaining -= 1;
    if (override.remaining === 0) state.statusDelayOverride = null;
  }
  const statuses: StatusName[] = msg.plannedFailure ? ['failed'] : [...c.statusSequence];
  const order: StatusOrder = msg.plannedFailure ? 'natural' : c.statusOrder;
  void emitStatusSequence(state, msg, { statuses, order, delayMs, leadingDelay: true }).catch(
    (err: unknown) => {
      state.log(
        `auto statuses for ${mask(msg.wamid)} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}
