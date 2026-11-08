import { randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { templateKey } from './catalog.js';
import { applyConfigPatch, setStatusDelay, validateFault } from './config-patch.js';
import {
  emitRaw,
  emitStatuses,
  pressButton,
  sendInboundText,
  sendInteractive,
  sendLinkCode,
  sendStop,
} from './emitters.js';
import { setTemplateStatus } from './graph-api.js';
import { HttpError, isRecord, Router, sendJson, sendText, type Params } from './http-util.js';
import { BUILTIN_SCENARIOS, runBuiltin, runDocument } from './scenarios.js';
import type { SimulatorState } from './store.js';
import type {
  ChannelSetting,
  InboundOptions,
  MessageFilter,
  ScenarioDocument,
  TemplateStatus,
  TextOptions,
  VerifyWebhookResult,
} from './types.js';
import { renderUi } from './ui.js';
import { conversation, conversations, lastClaimCode } from './views.js';
import { webhookUrlFor } from './webhook.js';

export interface ControlContext {
  req: IncomingMessage;
  res: ServerResponse;
  state: SimulatorState;
  url: URL;
  body: unknown;
}

export const CONTROL_PREFIXES = ['/_sim', '/sim'] as const;

function obj(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
  return body;
}

function filterFrom(url: URL): MessageFilter {
  const q = url.searchParams;
  const f: MessageFilter = {};
  for (const key of ['to', 'template', 'purpose', 'type', 'phoneNumberId'] as const) {
    const v = q.get(key);
    if (v) f[key] = v;
  }
  const after = q.get('afterSeq');
  if (after !== null) {
    if (!/^\d+$/.test(after)) throw new HttpError(400, 'invalid_query', 'afterSeq must be an integer');
    f.afterSeq = Number(after);
  }
  return f;
}

const TEMPLATE_STATUSES: readonly TemplateStatus[] = [
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
];

async function verifyWebhook(
  state: SimulatorState,
  body: Record<string, unknown>,
): Promise<VerifyWebhookResult> {
  const token = typeof body.verifyToken === 'string' ? body.verifyToken : state.config.verifyToken;
  if (!token) throw new HttpError(409, 'verify_token_not_configured', 'set VERIFY_TOKEN or pass verifyToken');
  const challenge =
    typeof body.challenge === 'string' ? body.challenge : String(randomInt(1_000_000_000, 2_000_000_000));
  const target = new URL(
    webhookUrlFor(state, typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined),
  );
  target.searchParams.set('hub.mode', typeof body.mode === 'string' ? body.mode : 'subscribe');
  target.searchParams.set('hub.verify_token', token);
  target.searchParams.set('hub.challenge', challenge);
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(state.config.webhookTimeoutMs) });
    const text = await res.text();
    return {
      ok: res.status === 200 && text === challenge,
      httpStatus: res.status,
      body: text,
      challenge,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      challenge,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type Handler = (ctx: ControlContext, params: Params) => Promise<unknown> | unknown;

/** JSON control API; every route answers 200 with the handler's value unless it throws an HttpError. */
export function controlRouter(): Router<ControlContext> {
  const router = new Router<ControlContext>();
  const on = (method: string, path: string, handler: Handler): void => {
    for (const prefix of CONTROL_PREFIXES) {
      router.on(method, `${prefix}${path}`, async (ctx, params) => {
        const value = await handler(ctx, params);
        if (!ctx.res.headersSent) sendJson(ctx.res, 200, value ?? { ok: true });
      });
    }
  };

  on('GET', '/health', ({ state }) => ({
    ok: true,
    service: 'wa-simulator',
    webhookUrl: state.config.webhookUrl,
    phoneNumberId: state.effectivePhoneNumberId(),
    channel: state.channelState().state,
    outbound: state.outbound.length,
    inbound: state.inbound.length,
    deliveries: state.deliveries.length,
  }));

  on('GET', '/config', ({ state }) => state.configView());
  const patchConfig: Handler = ({ state, body }) => {
    applyConfigPatch(state, obj(body));
    return state.configView();
  };
  on('PATCH', '/config', patchConfig);
  on('POST', '/config', patchConfig);
  on('POST', '/reset', ({ state, body }) => {
    state.reset(obj(body).resetConfig === true);
    return { ok: true };
  });

  // Outbound messages (what the business sent).
  on('GET', '/messages', ({ state, url }) => ({ data: state.findMessages(filterFrom(url)) }));
  on('GET', '/messages/last', ({ state, url }) => {
    const found = state.findMessages(filterFrom(url)).at(-1);
    if (!found) throw new HttpError(404, 'message_not_found', 'no outbound message matches');
    return found;
  });
  on('GET', '/messages/:wamid', ({ state }, p) => state.selectMessage({ wamid: p.wamid as string }));
  on('GET', '/send-attempts', ({ state }) => ({ data: state.attempts }));

  // Per-customer helpers (docs/12 §11.2).
  on('GET', '/customers/:id/last-message', ({ state, url }, p) => {
    const found = state.findMessages({ ...filterFrom(url), to: p.id as string }).at(-1);
    if (!found) throw new HttpError(404, 'message_not_found', `no outbound message to ${p.id as string}`);
    return found;
  });
  on('GET', '/customers/:id/claim-code', ({ state }, p) => {
    const found = lastClaimCode(state, p.id as string);
    if (!found)
      throw new HttpError(
        404,
        'claim_code_not_found',
        `no W-05 message with a handover code to ${p.id as string}`,
      );
    return found;
  });
  on('POST', '/customers/:id/tap', ({ state, body }, p) => {
    const b = obj(body);
    const contextWamid = typeof b.context_wamid === 'string' ? b.context_wamid : undefined;
    return pressButton(state, {
      ...b,
      ...(contextWamid ? { wamid: contextWamid } : { to: p.id as string }),
      from: (b.from as string | undefined) ?? (p.id as string),
    });
  });
  on('POST', '/customers/:id/text', ({ state, body }, p) =>
    sendInboundText(state, { ...obj(body), from: p.id as string } as TextOptions),
  );
  on('POST', '/customers/:id/link-code', ({ state, body }, p) =>
    sendLinkCode(state, { ...obj(body), from: p.id as string } as InboundOptions & { code: string }),
  );
  on('POST', '/customers/:id/stop', ({ state, body }, p) =>
    sendStop(state, { ...obj(body), from: p.id as string }),
  );
  on('GET', '/conversations', ({ state }) => ({ data: conversations(state) }));
  on('GET', '/conversations/:id', ({ state }, p) => conversation(state, p.id as string));

  // Inbound emitters (customer → business webhooks).
  on('POST', '/press', ({ state, body }) => pressButton(state, obj(body)));
  on('POST', '/text', ({ state, body }) => sendInboundText(state, obj(body) as never));
  on('POST', '/link-code', ({ state, body }) => sendLinkCode(state, obj(body) as never));
  on('POST', '/stop', ({ state, body }) => sendStop(state, obj(body)));
  on('POST', '/interactive', ({ state, body }) => sendInteractive(state, obj(body) as never));
  on('POST', '/statuses', ({ state, body }) => emitStatuses(state, obj(body)));
  on('POST', '/webhooks/raw', ({ state, body }) => emitRaw(state, obj(body) as never));
  on('GET', '/webhooks', ({ state }) => ({ data: state.deliveries }));
  on('POST', '/verify-webhook', ({ state, body }) => verifyWebhook(state, obj(body)));

  // Fault injection.
  on('GET', '/faults', ({ state }) => state.faultsView());
  on('POST', '/faults', ({ state, body }) => {
    const b = body;
    const rules = Array.isArray(b) ? b : isRecord(b) && Array.isArray(b.rules) ? b.rules : [b];
    const validated = rules.map(validateFault);
    for (const r of validated) state.addFault(r);
    return state.faultsView();
  });
  on('DELETE', '/faults', ({ state }) => {
    state.clearFaults();
    return state.faultsView();
  });
  on('POST', '/channel', ({ state, body }) => {
    const b = obj(body) as unknown as ChannelSetting;
    if (!['up', 'down', 'timeout'].includes(b.state))
      throw new HttpError(400, 'invalid_channel', 'state must be up, down or timeout');
    state.setChannel(b);
    return state.faultsView();
  });
  on('POST', '/latency', ({ state, body }) => {
    const ms = obj(body).ms;
    if (typeof ms !== 'number' || ms < 0)
      throw new HttpError(400, 'invalid_latency', 'ms must be a number ≥ 0');
    state.latencyMs = ms;
    return state.faultsView();
  });
  on('POST', '/status-delay', ({ state, body }) => {
    const b = obj(body);
    const delayMs = typeof b.delayMs === 'number' && b.delayMs >= 0 ? b.delayMs : NaN;
    const count = b.count === undefined ? 1 : typeof b.count === 'number' && b.count >= 0 ? b.count : NaN;
    if (Number.isNaN(delayMs) || Number.isNaN(count))
      throw new HttpError(400, 'invalid_option', 'delayMs ≥ 0 and count ≥ 0 are required');
    return setStatusDelay(state, delayMs, count);
  });

  // Templates of the local catalog.
  on('GET', '/templates', ({ state }) => ({ data: [...state.templates.values()] }));
  on('POST', '/templates/:name/status', async ({ state, body }, p) => {
    const b = obj(body);
    const language = typeof b.language === 'string' ? b.language : 'ar';
    const t = state.templates.get(templateKey(p.name as string, language));
    if (!t) throw new HttpError(404, 'template_not_found', `no template ${p.name as string} (${language})`);
    const status = typeof b.status === 'string' ? (b.status.toUpperCase() as TemplateStatus) : undefined;
    if (!status || !TEMPLATE_STATUSES.includes(status)) {
      throw new HttpError(400, 'invalid_status', `status must be one of ${TEMPLATE_STATUSES.join(', ')}`);
    }
    await setTemplateStatus(
      state,
      t,
      status,
      b.emitWebhook === true,
      typeof b.reason === 'string' ? b.reason : undefined,
    );
    return t;
  });

  // Scenarios (docs/12 §11.4, docs/17 §3.4).
  on('GET', '/scenarios', () => ({ data: BUILTIN_SCENARIOS }));
  on('POST', '/scenarios', ({ state, body }) => runDocument(state, body as ScenarioDocument));
  on('POST', '/scenarios/:name', ({ state, body }, p) => runBuiltin(state, p.name as string, obj(body)));

  for (const prefix of CONTROL_PREFIXES) {
    router.on('GET', `${prefix}/ui`, ({ res }) => sendText(res, 200, renderUi(), 'text/html'));
  }
  return router;
}
