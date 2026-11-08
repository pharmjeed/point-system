import {
  emitRaw,
  emitStatuses,
  pressButton,
  sendInboundText,
  sendInteractive,
  sendLinkCode,
  sendStop,
} from './emitters.js';
import { HttpError, isRecord } from './http-util.js';
import type { SimulatorState } from './store.js';
import type {
  EmitResult,
  ScenarioDocument,
  ScenarioResult,
  ScenarioStep,
  ScenarioStepResult,
  SimulatorConfigPatch,
  WebhookDelivery,
} from './types.js';
import { applyConfigPatch, setStatusDelay, validateFault } from './config-patch.js';

/** Phone of CUS3, the forwarding sender of AC-02 in the test seed (docs/17 §4). */
export const DEFAULT_FORWARD_FROM = '+966500001234';

type Params = Record<string, unknown>;

function str(p: Params, key: string, required: true): string;
function str(p: Params, key: string, required?: false): string | undefined;
function str(p: Params, key: string, required = false): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'invalid_scenario', `parameter "${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string')
    throw new HttpError(400, 'invalid_scenario', `parameter "${key}" must be a string`);
  return v;
}

function num(p: Params, key: string, fallback: number): number {
  const v = p[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new HttpError(400, 'invalid_scenario', `parameter "${key}" must be a number ≥ 0`);
  }
  return v;
}

function selectorOf(p: Params): { to?: string; wamid?: string } {
  const to = str(p, 'to');
  const wamid = str(p, 'wamid');
  if (!to && !wamid) throw new HttpError(400, 'invalid_scenario', 'parameter "to" (or "wamid") is required');
  return { ...(to ? { to } : {}), ...(wamid ? { wamid } : {}) };
}

/** Built-in scenarios of docs/12 §11.4, expressed as step lists. */
const BUILTINS: Record<string, (p: Params, state: SimulatorState) => ScenarioStep[]> = {
  // The same button webhook 10× with an identical body, then 10× with the same wamid in different bodies (AC-01).
  dup10: (p) => {
    const copies = num(p, 'copies', 10);
    return [
      {
        action: 'press',
        ...selectorOf(p),
        ...(str(p, 'from') ? { from: str(p, 'from') } : {}),
        copies: copies * 2,
        identicalFirst: copies,
        duplicateMode: 'same_wamid',
        parallel: num(p, 'parallel', 5),
      },
    ];
  },
  // 10 real taps (10 different wamids) within 5 s.
  taps10: (p) => {
    const copies = num(p, 'copies', 10);
    return [
      {
        action: 'press',
        ...selectorOf(p),
        ...(str(p, 'from') ? { from: str(p, 'from') } : {}),
        copies,
        duplicateMode: 'distinct',
        delayMs: Math.floor(num(p, 'spreadMs', 5000) / Math.max(1, copies)),
      },
    ];
  },
  // read before sent, delivered after read.
  reorder: (p) => [
    {
      action: 'statuses',
      ...selectorOf(p),
      ...(str(p, 'template') ? { template: str(p, 'template') } : {}),
      statuses: ['sent', 'delivered', 'read'],
      order: 'reorder',
    },
  ],
  // The W-01 button of `to` pressed from another number (AC-02).
  forwarded: (p) => [{ action: 'press', ...selectorOf(p), from: str(p, 'from') ?? DEFAULT_FORWARD_FROM }],
  // One customer, two tickets: press the chosen ticket's W-01 (default: the latest) (AC-03).
  two_tickets: (p) => {
    const ticketNumber = str(p, 'ticketNumber');
    const index = p.index === undefined ? undefined : num(p, 'index', 0);
    return [
      {
        action: 'press',
        to: str(p, 'to', true),
        purpose: 'W-01',
        ...(ticketNumber ? { ticketNumber } : {}),
        ...(index !== undefined ? { index } : {}),
      },
    ];
  },
  // One customer with tickets in two venues presses each W-01 (AC-20).
  two_venues: (p, state) => {
    const to = str(p, 'to', true);
    const list = state.findMessages({ to, purpose: 'W-01', withButtons: true });
    if (list.length === 0) throw new HttpError(404, 'message_not_found', `no W-01 message to ${to}`);
    return list.map((m) => ({ action: 'press', wamid: m.wamid, delayMs: 0 }) as ScenarioStep);
  },
  qr_link: (p) => [{ action: 'link_code', from: str(p, 'from', true), code: str(p, 'code', true) }],
  // Two numbers send the same link code (the second must get W-11 invalid).
  qr_race: (p) => [
    { action: 'link_code', from: str(p, 'from', true), code: str(p, 'code', true) },
    { action: 'wait', ms: num(p, 'gapMs', 0) },
    { action: 'link_code', from: str(p, 'from2', true), code: str(p, 'code', true) },
  ],
  opt_out_then_tap: (p) => {
    const to = str(p, 'to', true);
    const keyword = str(p, 'keyword');
    return [
      { action: 'stop', from: to, ...(keyword ? { keyword } : {}) },
      { action: 'wait', ms: num(p, 'gapMs', 0) },
      { action: 'press', to, purpose: 'W-01' },
    ];
  },
  // Token expired (190) for two minutes, then recovery.
  channel_down: (p) => [
    {
      action: 'channel',
      state: 'down',
      code: num(p, 'code', 190),
      durationMs: num(p, 'durationMs', 120_000),
    },
  ],
  // Accept the next send(s) but hold their status webhooks for 20 s (docs/12 §5.13).
  crash_after_accept: (p) => [
    { action: 'status_delay', delayMs: num(p, 'delayMs', 20_000), count: num(p, 'count', 1) },
  ],
};

export const BUILTIN_SCENARIOS: readonly string[] = Object.keys(BUILTINS);

function asEmit(value: unknown): EmitResult | null {
  return isRecord(value) && Array.isArray(value.deliveries) ? (value as unknown as EmitResult) : null;
}

async function runStep(state: SimulatorState, step: ScenarioStep): Promise<unknown> {
  if (!isRecord(step) || typeof step.action !== 'string') {
    throw new HttpError(400, 'invalid_scenario', 'every step needs an "action"');
  }
  const { action, ...rest } = step as ScenarioStep & Record<string, unknown>;
  switch (action) {
    case 'press':
      return pressButton(state, rest as never);
    case 'text':
      return sendInboundText(state, rest as never);
    case 'link_code':
      return sendLinkCode(state, rest as never);
    case 'stop':
      return sendStop(state, rest as never);
    case 'interactive':
      return sendInteractive(state, rest as never);
    case 'statuses':
      return emitStatuses(state, rest as never);
    case 'raw':
      return emitRaw(state, rest as never);
    case 'fault':
      return state.addFault(validateFault(rest));
    case 'clear_faults':
      state.clearFaults();
      return { ok: true };
    case 'channel':
      return state.setChannel(rest as never);
    case 'latency':
      state.latencyMs = num(rest, 'ms', 0);
      return { latencyMs: state.latencyMs };
    case 'wait':
      await state.sleep(num(rest, 'ms', 0));
      return { waited: num(rest, 'ms', 0) };
    case 'config':
      applyConfigPatch(state, rest as SimulatorConfigPatch);
      return state.configView();
    case 'status_delay':
      return setStatusDelay(state, num(rest, 'delayMs', 0), num(rest, 'count', 1));
    case 'scenario':
      return runBuiltin(state, str(rest, 'name', true), isRecord(rest.params) ? rest.params : {});
    default:
      throw new HttpError(400, 'invalid_scenario', `unknown step action "${String(action)}"`);
  }
}

async function runSteps(state: SimulatorState, name: string, steps: ScenarioStep[]): Promise<ScenarioResult> {
  const results: ScenarioStepResult[] = [];
  const deliveries: WebhookDelivery[] = [];
  const wamids: string[] = [];
  for (const [index, step] of steps.entries()) {
    let result: unknown;
    try {
      result = await runStep(state, step);
    } catch (err) {
      if (err instanceof HttpError) {
        throw new HttpError(
          err.status,
          err.code,
          `scenario ${name}, step ${index} (${step.action}): ${err.message}`,
        );
      }
      throw err;
    }
    results.push({ index, action: step.action, result });
    // EmitResult and nested ScenarioResult both carry deliveries + wamids.
    const emit = asEmit(result);
    if (emit) {
      deliveries.push(...emit.deliveries);
      wamids.push(...emit.wamids);
    }
  }
  return { name, steps: results, deliveries, wamids };
}

export function runBuiltin(state: SimulatorState, name: string, params: Params): Promise<ScenarioResult> {
  const make = BUILTINS[name];
  if (!make) {
    throw new HttpError(
      404,
      'unknown_scenario',
      `unknown scenario "${name}"; built-ins: ${BUILTIN_SCENARIOS.join(', ')}`,
    );
  }
  return runSteps(state, name, make(params, state));
}

/** Replays a scenario document (docs/17 §3.4): steps run in order, each step's webhooks are recorded. */
export function runDocument(state: SimulatorState, doc: ScenarioDocument): Promise<ScenarioResult> {
  if (!isRecord(doc) || !Array.isArray(doc.steps)) {
    throw new HttpError(
      400,
      'invalid_scenario',
      'a scenario document is { name?, description?, steps: [...] }',
    );
  }
  return runSteps(state, typeof doc.name === 'string' ? doc.name : 'document', doc.steps);
}
