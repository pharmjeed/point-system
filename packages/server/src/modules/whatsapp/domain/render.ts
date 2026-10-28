import { renderWaText, waTemplateById, type WaMessageId } from '@point/shared';

/** What `whatsapp_messages.body_redacted` / `payload_redacted` show instead of the handover code (12 §5.10). */
export const CODE_MASK = '••••••';
/** The raw action token never reaches a column, a log or an event (12 §5.11, AC-09). */
export const TOKEN_MASK = '[action_token]';

export interface VehicleFacts {
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  plate_digits: string | null;
}

/** Template parameters may not contain new lines, tabs or more than 4 consecutive spaces (Meta). */
export function cleanParam(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const PLATE_WORD = 'لوحة';

/**
 * W-01 `{{3}}` (14 §4): make + model when present + color + « — لوحة » + the plate digits when present,
 * at most 60 characters; never the plate letters or anything else.
 */
export function vehicleSummary(v: VehicleFacts): string {
  const desc = [v.vehicle_make, v.vehicle_model, v.vehicle_color].map(cleanParam).filter(Boolean).join(' ');
  const digits = cleanParam(v.plate_digits);
  if (!digits) return desc ? desc.slice(0, 60).trim() : '—';
  const plate = `${PLATE_WORD} ${digits}`;
  if (!desc) return plate;
  const room = 60 - plate.length - 3;
  const d = desc.slice(0, Math.max(0, room)).trim();
  return d ? `${d} — ${plate}` : plate;
}

export interface WaRecipient {
  /** E.164 or digits; preferred when known */
  to: string | null;
  /** BSUID when the customer is only known by it (DEC-35) */
  recipient: string | null;
}

export interface BuiltMessage {
  kind: 'template' | 'session_text';
  templateName: string | null;
  /** the Graph body — may hold the code or the token: keep in memory only */
  request: Record<string, unknown>;
  bodyRedacted: string;
  payloadRedacted: Record<string, unknown>;
}

function addressing(r: WaRecipient): Record<string, string> {
  if (r.to) return { to: r.to };
  if (r.recipient) return { recipient: r.recipient };
  throw new Error('a WhatsApp recipient needs a phone/wa_id or a BSUID');
}

interface Secret {
  value: string;
  mask: string;
}

function maskDeep(value: unknown, secrets: readonly Secret[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (s.value) out = out.split(s.value).join(s.mask);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, secrets)]));
  return value;
}

/** Redacted copy of a request: recipient digits removed, secrets masked. */
function redactRequest(
  request: Record<string, unknown>,
  secrets: readonly Secret[],
): Record<string, unknown> {
  const copy = maskDeep(request, secrets) as Record<string, unknown>;
  if (typeof copy.to === 'string') copy.to = `•••${copy.to.slice(-3)}`;
  if (typeof copy.recipient === 'string') copy.recipient = `•••${copy.recipient.slice(-3)}`;
  return copy;
}

/**
 * An approved template (12 §5.11): body parameters, the W-01 quick-reply payload (the action token),
 * and `biz_opaque_callback_data` = our message id so a status can be matched before the wamid is saved.
 */
export function buildTemplateMessage(a: {
  purpose: WaMessageId;
  recipient: WaRecipient;
  params: readonly string[];
  /** values to mask in body_redacted/payload_redacted (handover code) */
  secretParams?: readonly string[];
  buttonPayload?: string | null;
  opaque: string;
}): BuiltMessage {
  const def = waTemplateById(a.purpose);
  if (def.kind !== 'template') throw new Error(`${a.purpose} is not a template`);
  const params = a.params.map(cleanParam);
  const components: Record<string, unknown>[] = [];
  if (params.length) {
    components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) });
  }
  if (def.button) {
    if (!a.buttonPayload) throw new Error(`${a.purpose} needs its quick-reply payload`);
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: a.buttonPayload }],
    });
  }
  const request: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...addressing(a.recipient),
    type: 'template',
    template: { name: def.name, language: { code: def.language }, components },
    biz_opaque_callback_data: a.opaque,
  };
  const secrets: Secret[] = [
    ...(a.secretParams ?? []).map((value) => ({ value, mask: CODE_MASK })),
    ...(a.buttonPayload ? [{ value: a.buttonPayload, mask: TOKEN_MASK }] : []),
  ];
  return {
    kind: 'template',
    templateName: def.name,
    request,
    bodyRedacted: maskDeep(renderWaText(def.body_ar, params), secrets) as string,
    payloadRedacted: redactRequest(request, secrets),
  };
}

/** A free session reply (W-09 … W-12, and the W-05 fallback of 12 §8.4): no buttons, no link previews. */
export function buildSessionMessage(a: {
  recipient: WaRecipient;
  text: string;
  contextWamid?: string | null;
  secrets?: readonly string[];
  opaque: string;
}): BuiltMessage {
  const request: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...addressing(a.recipient),
    type: 'text',
    ...(a.contextWamid ? { context: { message_id: a.contextWamid } } : {}),
    text: { preview_url: false, body: a.text },
    biz_opaque_callback_data: a.opaque,
  };
  const secrets: Secret[] = (a.secrets ?? []).map((value) => ({ value, mask: CODE_MASK }));
  return {
    kind: 'session_text',
    templateName: null,
    request,
    bodyRedacted: maskDeep(a.text, secrets) as string,
    payloadRedacted: redactRequest(request, secrets),
  };
}

/** `biz_opaque_callback_data` value of a whatsapp_messages row (12 §5.11). */
export const opaqueFor = (messageId: string) => `wam:${messageId}`;

export function messageIdFromOpaque(opaque: unknown): string | null {
  if (typeof opaque !== 'string') return null;
  const m = /^wam:([0-9a-f-]{36})$/i.exec(opaque);
  return m ? m[1]! : null;
}
