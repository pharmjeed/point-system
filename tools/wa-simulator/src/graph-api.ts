import type { IncomingMessage, ServerResponse } from 'node:http';
import { brand, countBodyParams, graphTemplateView, purposeOf, renderBody, templateKey } from './catalog.js';
import { bareHttpErrorBody, graphErrorBody, graphErrorInfo } from './graph-errors.js';
import { isRecord, sendJson, type Params } from './http-util.js';
import { bsuidFor, digitsOnly, mask, newWamid, sha256Hex } from './ids.js';
import type { SimulatorState } from './store.js';
import type { OutboundMessage, SendAttempt, SentButton, TemplateInfo, TemplateStatus } from './types.js';
import { deliver, scheduleAutoStatuses } from './webhook.js';

export interface GraphContext {
  req: IncomingMessage;
  res: ServerResponse;
  state: SimulatorState;
  url: URL;
  raw: Buffer;
}

const MESSAGE_TYPES = [
  'audio',
  'contacts',
  'document',
  'image',
  'interactive',
  'location',
  'reaction',
  'sticker',
  'template',
  'text',
  'video',
];

class GraphReject extends Error {
  constructor(
    readonly code: number,
    readonly details?: string,
    readonly opts: { message?: string; subcode?: number; httpStatus?: number; cause?: string } = {},
  ) {
    super(`graph error ${code}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function hang(ctx: GraphContext, attempt: SendAttempt | null): Promise<void> {
  if (attempt) attempt.cause = 'timeout';
  ctx.state.log(`graph ${ctx.url.pathname} → held (timeout mode)`);
  return ctx.state.sleep(ctx.state.config.hangMs).then(() => {
    ctx.req.socket.destroy();
  });
}

function reply(ctx: GraphContext, attempt: SendAttempt | null, e: GraphReject): void {
  const info = graphErrorInfo(e.code);
  const status = e.opts.httpStatus ?? info.httpStatus;
  if (attempt) {
    attempt.httpStatus = status;
    attempt.errorCode = e.code;
    attempt.cause = e.opts.cause ?? 'validation';
  }
  const headers = status === 401 ? { 'www-authenticate': 'OAuth "Facebook Platform" "invalid_token"' } : {};
  for (const [k, v] of Object.entries(headers)) ctx.res.setHeader(k, v);
  sendJson(
    ctx.res,
    status,
    graphErrorBody(e.code, { ...e.opts, ...(e.details ? { details: e.details } : {}) }),
  );
  ctx.state.log(
    `graph ${ctx.url.pathname} → ${status} code=${e.code}${attempt?.to ? ` to=${mask(attempt.to)}` : ''}`,
  );
}

/** Channel state, auth and phone-number checks shared by every Graph route. */
async function preflight(ctx: GraphContext, attempt: SendAttempt | null, version: string): Promise<boolean> {
  const { state } = ctx;
  if (state.latencyMs > 0) await state.sleep(state.latencyMs);
  if (!/^v\d+\.\d+$/.test(version)) {
    reply(
      ctx,
      attempt,
      new GraphReject(2500, undefined, { message: `Unknown path components: /${version}` }),
    );
    return false;
  }
  const channel = state.channelState();
  if (channel.state === 'timeout') {
    await hang(ctx, attempt);
    return false;
  }
  if (channel.state === 'down') {
    const code = channel.code ?? 131016;
    reply(
      ctx,
      attempt,
      new GraphReject(code, undefined, {
        cause: 'channel',
        ...(channel.httpStatus ? { httpStatus: channel.httpStatus } : {}),
      }),
    );
    return false;
  }
  const auth = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.authorization ?? '');
  const token = auth?.[1];
  if (!token || (state.config.accessToken !== null && token !== state.config.accessToken)) {
    reply(
      ctx,
      attempt,
      new GraphReject(190, undefined, {
        message: token
          ? 'Invalid OAuth access token - Cannot parse access token'
          : 'An active access token must be used to query information about the current user.',
        cause: 'auth',
      }),
    );
    return false;
  }
  return true;
}

function checkPhoneNumberId(state: SimulatorState, id: string): void {
  if (state.config.phoneNumberId !== null && id !== state.config.phoneNumberId) {
    throw new GraphReject(100, undefined, {
      message: `Unsupported post request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      subcode: 33,
    });
  }
}

interface ParsedSend {
  to: string | null;
  recipient: string | null;
  waId: string | null;
  userId: string | null;
  type: string;
  template: TemplateInfo | null;
  templateName: string | null;
  templateLanguage: string | null;
  bodyParams: string[];
  buttons: SentButton[];
  text: string | null;
  renderedText: string | null;
  contextMessageId: string | null;
  bizOpaque: string | null;
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new GraphReject(100, undefined, { message: `(#100) The parameter ${path} is required.` });
  }
  return v;
}

function parseTemplate(
  state: SimulatorState,
  raw: unknown,
): Pick<
  ParsedSend,
  'template' | 'templateName' | 'templateLanguage' | 'bodyParams' | 'buttons' | 'renderedText'
> {
  if (!isRecord(raw))
    throw new GraphReject(100, undefined, { message: '(#100) The parameter template is required.' });
  const name = requireString(raw, 'name', "template['name']");
  if (!isRecord(raw.language))
    throw new GraphReject(100, undefined, {
      message: "(#100) The parameter template['language'] is required.",
    });
  const language = requireString(raw.language, 'code', "template['language']['code']");
  const def = state.templates.get(templateKey(name, language));
  if (!def) {
    throw new GraphReject(132001, `template name (${name}) does not exist in ${language}`, {
      message: '(#132001) Template name does not exist in the translation',
    });
  }
  if (def.status === 'PAUSED') throw new GraphReject(132015, `template ${name} is paused`);
  if (def.status === 'DISABLED') throw new GraphReject(132016, `template ${name} is disabled`);
  if (def.status !== 'APPROVED') {
    throw new GraphReject(132001, `template ${name} (${language}) is ${def.status}, not APPROVED`, {
      message: '(#132001) Template name does not exist in the translation',
    });
  }
  const components = raw.components ?? [];
  if (!Array.isArray(components)) throw new GraphReject(100, "template['components'] must be an array");

  let bodyParams: string[] | null = null;
  const payloads = new Map<number, string>();
  components.forEach((c, ci) => {
    if (!isRecord(c) || typeof c.type !== 'string')
      throw new GraphReject(100, `template['components'][${ci}]['type'] is required`);
    const type = c.type.toLowerCase();
    const params = c.parameters ?? [];
    if (!Array.isArray(params))
      throw new GraphReject(100, `template['components'][${ci}]['parameters'] must be an array`);
    if (type === 'body') {
      if (bodyParams !== null) throw new GraphReject(100, 'duplicate body component');
      bodyParams = params.map((p, pi) => {
        const where = `template['components'][${ci}]['parameters'][${pi}]`;
        if (!isRecord(p) || typeof p.type !== 'string')
          throw new GraphReject(131008, `${where}['type'] is required`);
        if (p.type !== 'text')
          throw new GraphReject(132012, `${where}: expected a text parameter, got ${p.type}`);
        if (typeof p.text !== 'string' || p.text.length === 0)
          throw new GraphReject(131008, `${where}['text'] is required`);
        if (/[\n\t]| {5,}/.test(p.text)) {
          throw new GraphReject(
            100,
            'Param text cannot have new-line/tab characters or more than 4 consecutive spaces',
          );
        }
        return p.text;
      });
      if (bodyParams.length !== def.bodyParamCount) {
        throw new GraphReject(
          132000,
          `body: number of localizable_params (${bodyParams.length}) does not match the expected number of params (${def.bodyParamCount})`,
        );
      }
    } else if (type === 'header') {
      throw new GraphReject(
        132000,
        `header: number of localizable_params (${params.length}) does not match the expected number of params (0)`,
      );
    } else if (type === 'button') {
      const subType = typeof c.sub_type === 'string' ? c.sub_type.toLowerCase() : '';
      const index =
        typeof c.index === 'number'
          ? c.index
          : typeof c.index === 'string' && /^\d+$/.test(c.index)
            ? Number(c.index)
            : NaN;
      if (Number.isNaN(index))
        throw new GraphReject(131008, `template['components'][${ci}]['index'] is required`);
      const btn = def.buttons[index];
      if (!btn) throw new GraphReject(131009, `button at index ${index} does not exist in template ${name}`);
      if (subType !== 'quick_reply' || btn.type !== 'QUICK_REPLY') {
        throw new GraphReject(
          131009,
          `button at index ${index} is ${btn.type}; sub_type ${subType || '(missing)'} is not valid`,
        );
      }
      if (payloads.has(index)) throw new GraphReject(131009, `duplicate button component for index ${index}`);
      const p = params[0];
      if (
        params.length !== 1 ||
        !isRecord(p) ||
        p.type !== 'payload' ||
        typeof p.payload !== 'string' ||
        p.payload === ''
      ) {
        throw new GraphReject(
          131008,
          `template['components'][${ci}]['parameters'][0] must be {type:'payload', payload}`,
        );
      }
      payloads.set(index, p.payload);
    } else {
      throw new GraphReject(100, `unsupported component type ${c.type}`);
    }
  });
  const finalParams: string[] = bodyParams ?? [];
  if (bodyParams === null && def.bodyParamCount > 0) {
    throw new GraphReject(
      132000,
      `body: number of localizable_params (0) does not match the expected number of params (${def.bodyParamCount})`,
    );
  }
  const buttons: SentButton[] = def.buttons.flatMap((b, index) =>
    b.type === 'QUICK_REPLY'
      ? [{ index, subType: 'quick_reply', payload: payloads.get(index) ?? null, text: b.text }]
      : [],
  );
  return {
    template: def,
    templateName: name,
    templateLanguage: language,
    bodyParams: finalParams,
    buttons,
    renderedText: renderBody(def.body, finalParams),
  };
}

function parseSend(state: SimulatorState, body: unknown): ParsedSend {
  if (!isRecord(body))
    throw new GraphReject(100, undefined, { message: '(#100) The parameter messaging_product is required.' });
  if (body.messaging_product !== 'whatsapp') {
    throw new GraphReject(100, undefined, { message: '(#100) The parameter messaging_product is required.' });
  }
  if (body.recipient_type !== undefined && body.recipient_type !== 'individual') {
    throw new GraphReject(100, `recipient_type must be individual`);
  }
  const to = typeof body.to === 'string' && body.to.trim() !== '' ? body.to.trim() : null;
  const recipient =
    typeof body.recipient === 'string' && body.recipient.trim() !== '' ? body.recipient.trim() : null;
  if (!to && !recipient)
    throw new GraphReject(100, undefined, { message: '(#100) The parameter to is required.' });
  let waId: string | null = null;
  if (to) {
    waId = digitsOnly(to);
    if (!/^\+?[\d\s()-]+$/.test(to) || waId.length < 7 || waId.length > 15)
      throw new GraphReject(100, `invalid phone number in "to"`);
    if (waId === digitsOnly(state.config.displayPhoneE164)) throw new GraphReject(131021);
  }
  let userId: string | null = recipient;
  if (waId) {
    userId ??= bsuidFor(waId);
    state.identities.set(userId, waId);
  } else if (recipient) {
    waId = state.identities.get(recipient) ?? null;
  }

  const type = body.type === undefined ? 'text' : body.type;
  if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type)) {
    throw new GraphReject(100, undefined, {
      message: `(#100) Param type must be one of {${MESSAGE_TYPES.map((t) => t.toUpperCase()).join(', ')}} - got "${String(type)}".`,
    });
  }
  let contextMessageId: string | null = null;
  if (body.context !== undefined) {
    if (!isRecord(body.context) || typeof body.context.message_id !== 'string')
      throw new GraphReject(100, "context['message_id'] is required");
    contextMessageId = body.context.message_id;
  }
  let bizOpaque: string | null = null;
  if (body.biz_opaque_callback_data !== undefined) {
    if (typeof body.biz_opaque_callback_data !== 'string' || body.biz_opaque_callback_data.length > 512) {
      throw new GraphReject(100, 'biz_opaque_callback_data must be a string of at most 512 characters');
    }
    bizOpaque = body.biz_opaque_callback_data;
  }

  const base = { to, recipient, waId, userId, type, contextMessageId, bizOpaque };
  if (type === 'template') return { ...base, text: null, ...parseTemplate(state, body.template) };
  if (type === 'text') {
    if (!isRecord(body.text))
      throw new GraphReject(100, undefined, { message: "(#100) The parameter text['body'] is required." });
    const text = requireString(body.text, 'body', "text['body']");
    if (text.length > 4096)
      throw new GraphReject(100, undefined, {
        message: "(#100) Param text['body'] must be at most 4096 characters long.",
      });
    if (body.text.preview_url !== undefined && typeof body.text.preview_url !== 'boolean')
      throw new GraphReject(100, 'preview_url must be a boolean');
    return {
      ...base,
      text,
      renderedText: text,
      template: null,
      templateName: null,
      templateLanguage: null,
      bodyParams: [],
      buttons: [],
    };
  }
  if (!isRecord(body[type]))
    throw new GraphReject(100, undefined, { message: `(#100) The parameter ${type} is required.` });
  return {
    ...base,
    text: null,
    renderedText: null,
    template: null,
    templateName: null,
    templateLanguage: null,
    bodyParams: [],
    buttons: [],
  };
}

/** Semantic identity of a send, stable across retries of the same notification (…1111 rule). */
function sendKey(p: ParsedSend): string {
  return sha256Hex(
    JSON.stringify([
      p.waId ?? p.userId,
      p.type,
      p.templateName,
      p.bodyParams,
      p.buttons.map((b) => b.payload),
      p.text,
      p.bizOpaque,
    ]),
  );
}

type ForcedFault =
  { kind: 'timeout' } | { kind: 'bare'; httpStatus: number } | { kind: 'code'; code: number };

/** `X-Sim-Fault: <graph code> | http_<status> | timeout` (docs/12 §11.3). */
function forcedFault(header: string | string[] | undefined): ForcedFault | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'timeout') return { kind: 'timeout' };
  const http = /^http_(\d{3})$/.exec(v);
  if (http) return { kind: 'bare', httpStatus: Number(http[1]) };
  if (/^\d+$/.test(v)) return { kind: 'code', code: Number(v) };
  return null;
}

/** POST /{version}/{phone_number_id}/messages */
export async function handleSendMessage(ctx: GraphContext, params: Params): Promise<void> {
  const { state } = ctx;
  const version = params.version as string;
  const phoneNumberId = params.phoneNumberId as string;
  const attempt: SendAttempt = {
    seq: state.nextSeq(),
    at: nowIso(),
    path: ctx.url.pathname,
    to: null,
    recipient: null,
    type: null,
    templateName: null,
    httpStatus: null,
    errorCode: null,
    wamid: null,
    cause: null,
  };
  state.addAttempt(attempt);
  if (!(await preflight(ctx, attempt, version))) return;

  let parsed: ParsedSend;
  try {
    checkPhoneNumberId(state, phoneNumberId);
    let body: unknown;
    try {
      body = JSON.parse(ctx.raw.toString('utf8'));
    } catch {
      throw new GraphReject(100, 'request body is not valid JSON');
    }
    if (isRecord(body)) {
      attempt.to = typeof body.to === 'string' ? body.to : null;
      attempt.recipient = typeof body.recipient === 'string' ? body.recipient : null;
      attempt.type = typeof body.type === 'string' ? body.type : 'text';
      attempt.templateName =
        isRecord(body.template) && typeof body.template.name === 'string' ? body.template.name : null;
    }
    parsed = parseSend(state, body);

    // Injected faults: X-Sim-Fault header first, then the control-API rules.
    const forced = forcedFault(ctx.req.headers['x-sim-fault']);
    if (forced?.kind === 'timeout') return hang(ctx, attempt);
    if (forced?.kind === 'bare') return replyBare(ctx, attempt, forced.httpStatus);
    if (forced?.kind === 'code') throw new GraphReject(forced.code, undefined, { cause: 'fault' });

    const purpose = parsed.templateName ? purposeOf(parsed.templateName) : null;
    const fault = state.takeFault({
      waId: parsed.waId,
      userId: parsed.userId,
      template: parsed.templateName,
      purpose,
      type: parsed.type,
    });
    let plannedFailure: { code: number } | null = null;
    let faulted = false;
    if (fault) {
      if (fault.latencyMs) await state.sleep(fault.latencyMs);
      if (fault.kind === 'timeout') return hang(ctx, attempt);
      if (fault.mode === 'async') {
        plannedFailure = { code: fault.code ?? 131026 };
        faulted = true;
      } else if (fault.code !== undefined) {
        throw new GraphReject(fault.code, fault.details, {
          cause: 'fault',
          ...(fault.message ? { message: fault.message } : {}),
          ...(fault.httpStatus ? { httpStatus: fault.httpStatus } : {}),
        });
      } else if (fault.httpStatus !== undefined) {
        return replyBare(ctx, attempt, fault.httpStatus);
      }
      // A rule with only latencyMs just slows the send down.
    }
    // Deterministic number rules (docs/12 §11.3).
    if (state.config.deterministicFaults && parsed.waId && !faulted) {
      if (parsed.waId.endsWith('1111')) {
        const key = sendKey(parsed);
        if (!state.pairRuleSeen.has(key)) {
          state.pairRuleSeen.add(key);
          throw new GraphReject(131056, undefined, { cause: 'number_rule' });
        }
      }
      if (parsed.waId.endsWith('0000')) plannedFailure = { code: 131026 };
    }
    accept(ctx, attempt, version, phoneNumberId, parsed, purpose, plannedFailure);
  } catch (err) {
    if (err instanceof GraphReject) return reply(ctx, attempt, err);
    throw err;
  }
}

function replyBare(ctx: GraphContext, attempt: SendAttempt, httpStatus: number, cause = 'fault'): void {
  attempt.httpStatus = httpStatus;
  attempt.cause = cause;
  sendJson(ctx.res, httpStatus, bareHttpErrorBody(httpStatus));
  ctx.state.log(`graph ${ctx.url.pathname} → ${httpStatus} (bare)`);
}

function accept(
  ctx: GraphContext,
  attempt: SendAttempt,
  version: string,
  phoneNumberId: string,
  p: ParsedSend,
  purpose: string | null,
  plannedFailure: { code: number } | null,
): void {
  const { state } = ctx;
  state.lastPhoneNumberId = phoneNumberId;
  const wamid = newWamid();
  const msg: OutboundMessage = {
    wamid,
    seq: attempt.seq,
    apiVersion: version,
    phoneNumberId,
    to: p.to,
    recipient: p.recipient,
    waId: p.waId,
    userId: p.userId,
    conversation: p.waId ?? (p.userId as string),
    type: p.type,
    templateName: p.templateName,
    templateLanguage: p.templateLanguage,
    purpose,
    bodyParams: p.bodyParams,
    buttons: p.buttons,
    text: p.text,
    renderedText: p.renderedText,
    contextMessageId: p.contextMessageId,
    bizOpaqueCallbackData: p.bizOpaque,
    plannedFailure,
    acceptedAt: nowIso(),
    statuses: [],
    request: JSON.parse(ctx.raw.toString('utf8')) as unknown,
  };
  state.addOutbound(msg);
  attempt.httpStatus = 200;
  attempt.wamid = wamid;
  if (plannedFailure) attempt.cause = 'async_failure';

  const contact: Record<string, string> = { input: p.to ?? (p.recipient as string) };
  if (p.waId) contact.wa_id = p.waId;
  if (p.recipient) contact.user_id = p.recipient;
  sendJson(ctx.res, 200, {
    messaging_product: 'whatsapp',
    contacts: [contact],
    messages: [{ id: wamid, ...(p.type === 'template' ? { message_status: 'accepted' } : {}) }],
  });
  state.log(
    `graph send ${p.type}${p.templateName ? `:${p.templateName}` : ''} to=${mask(p.waId ?? p.userId)} → 200${plannedFailure ? ` (will fail ${plannedFailure.code})` : ''}`,
  );
  scheduleAutoStatuses(state, msg);
}

/** GET /{version}/{phone_number_id} — phone-number status for the channel health check (docs/12 §5.14). */
export async function handlePhoneNumber(ctx: GraphContext, params: Params): Promise<void> {
  if (!(await preflight(ctx, null, params.version as string))) return;
  const { state } = ctx;
  try {
    checkPhoneNumberId(state, params.id as string);
  } catch (err) {
    if (err instanceof GraphReject) return reply(ctx, null, err);
    throw err;
  }
  sendJson(ctx.res, 200, {
    verified_name: brand().customerNameAr,
    code_verification_status: 'VERIFIED',
    display_phone_number: state.config.displayPhoneE164,
    quality_rating: 'GREEN',
    platform_type: 'CLOUD_API',
    throughput: { level: 'STANDARD' },
    name_status: 'APPROVED',
    whatsapp_business_manager_messaging_limit: 'TIER_2K',
    health_status: { can_send_message: 'AVAILABLE', entities: [] },
    id: params.id,
  });
}

/** GET /{version}/{waba_id}/message_templates */
export async function handleListTemplates(ctx: GraphContext, params: Params): Promise<void> {
  if (!(await preflight(ctx, null, params.version as string))) return;
  const q = ctx.url.searchParams;
  const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 1000);
  const list = [...ctx.state.templates.values()].filter(
    (t) =>
      (!q.get('name') || t.name === q.get('name')) &&
      (!q.get('status') || t.status === q.get('status')?.toUpperCase()),
  );
  sendJson(ctx.res, 200, {
    data: list.slice(0, limit).map(graphTemplateView),
    paging: { cursors: { before: 'QVFIUSIM', after: 'QVFIUSIM' } },
  });
}

const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];

/** POST /{version}/{waba_id}/message_templates — accepts the definition; APPROVED (optionally after a delay). */
export async function handleCreateTemplate(ctx: GraphContext, params: Params): Promise<void> {
  if (!(await preflight(ctx, null, params.version as string))) return;
  const { state } = ctx;
  try {
    let body: unknown;
    try {
      body = JSON.parse(ctx.raw.toString('utf8'));
    } catch {
      throw new GraphReject(100, 'request body is not valid JSON');
    }
    if (!isRecord(body)) throw new GraphReject(100, 'body must be an object');
    const name = requireString(body, 'name', 'name');
    if (!/^[a-z0-9_]{1,512}$/.test(name))
      throw new GraphReject(100, 'name may contain only lowercase letters, digits and underscores');
    const language = requireString(body, 'language', 'language');
    const category = requireString(body, 'category', 'category').toUpperCase();
    if (!CATEGORIES.includes(category))
      throw new GraphReject(100, `category must be one of ${CATEGORIES.join(', ')}`);
    if (!Array.isArray(body.components)) throw new GraphReject(100, 'components is required');
    let text: string | null = null;
    let buttons: { type: string; text: string }[] = [];
    for (const c of body.components) {
      if (!isRecord(c) || typeof c.type !== 'string')
        throw new GraphReject(100, 'component type is required');
      const type = c.type.toUpperCase();
      if (type === 'BODY') {
        if (typeof c.text !== 'string' || c.text.length === 0 || c.text.length > 1024)
          throw new GraphReject(100, 'BODY text is required (≤ 1024 characters)');
        text = c.text;
        const n = countBodyParams(c.text);
        const example =
          isRecord(c.example) && Array.isArray(c.example.body_text) ? c.example.body_text[0] : undefined;
        if (n > 0 && (!Array.isArray(example) || example.length !== n)) {
          throw new GraphReject(100, `BODY has ${n} variables; example.body_text[0] must hold ${n} samples`);
        }
      } else if (type === 'BUTTONS') {
        if (!Array.isArray(c.buttons) || c.buttons.length === 0 || c.buttons.length > 10)
          throw new GraphReject(100, 'BUTTONS needs 1–10 buttons');
        buttons = c.buttons.map((b) => {
          if (!isRecord(b) || typeof b.type !== 'string' || typeof b.text !== 'string')
            throw new GraphReject(100, 'button type and text are required');
          if (b.text.length > 25) throw new GraphReject(100, 'button text must be at most 25 characters');
          return { type: b.type.toUpperCase(), text: b.text };
        });
      }
    }
    if (text === null) throw new GraphReject(100, 'a BODY component is required');
    const key = templateKey(name, language);
    if (state.templates.has(key))
      throw new GraphReject(100, `Content in this language already exists (${name}, ${language})`, {
        subcode: 2388024,
      });
    const rejected = name.includes('reject');
    const delayed = !rejected && state.config.templateApprovalDelayMs > 0;
    const status: TemplateStatus = rejected ? 'REJECTED' : delayed ? 'PENDING' : 'APPROVED';
    const t: TemplateInfo = {
      id: state.nextTemplateId(),
      name,
      language,
      category: category as TemplateInfo['category'],
      status,
      purpose: purposeOf(name),
      body: text,
      bodyParamCount: countBodyParams(text),
      buttons,
      rejectedReason: rejected ? 'INVALID_FORMAT' : null,
    };
    state.templates.set(key, t);
    sendJson(ctx.res, 200, { id: t.id, status: t.status, category: t.category });
    state.log(`graph template ${name}:${language} → ${status}`);
    if (delayed) {
      void state.sleep(state.config.templateApprovalDelayMs).then((ok) => {
        if (ok && state.templates.get(key) === t && t.status === 'PENDING')
          void setTemplateStatus(state, t, 'APPROVED', true);
      });
    } else if (state.config.webhookUrl) {
      void emitTemplateStatusWebhook(state, t).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof GraphReject) return reply(ctx, null, err);
    throw err;
  }
}

export async function emitTemplateStatusWebhook(
  state: SimulatorState,
  t: TemplateInfo,
  reason?: string,
): Promise<void> {
  if (!state.config.webhookUrl) return;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: state.config.wabaId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            value: {
              event: t.status,
              message_template_id: Number(t.id),
              message_template_name: t.name,
              message_template_language: t.language,
              reason: reason ?? t.rejectedReason ?? 'NONE',
            },
            field: 'message_template_status_update',
          },
        ],
      },
    ],
  };
  await deliver(state, JSON.stringify(payload), { kind: 'template_status', wamids: [] });
}

export async function setTemplateStatus(
  state: SimulatorState,
  t: TemplateInfo,
  status: TemplateStatus,
  emitWebhook: boolean,
  reason?: string,
): Promise<void> {
  t.status = status;
  if (status === 'REJECTED') t.rejectedReason = reason ?? 'INVALID_FORMAT';
  state.log(`template ${t.name}:${t.language} → ${status}`);
  if (emitWebhook) await emitTemplateStatusWebhook(state, t, reason);
}
