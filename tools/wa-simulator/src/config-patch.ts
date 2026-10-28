import { STATUS_NAMES, STATUS_ORDERS } from './config.js';
import { HttpError, isRecord } from './http-util.js';
import type { SimulatorState } from './store.js';
import type { FaultRule, FaultsView, SimulatorConfigPatch, StatusName } from './types.js';

function bad(message: string): HttpError {
  return new HttpError(400, 'invalid_config', message);
}

function nonNegativeInt(key: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw bad(`${key} must be an integer ≥ 0`);
  return v;
}

function nullableString(key: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') throw bad(`${key} must be a non-empty string or null`);
  return v.trim();
}

/** Validates and applies PATCH /_sim/config. Unknown keys are rejected so typos do not pass silently. */
export function applyConfigPatch(state: SimulatorState, patch: SimulatorConfigPatch): void {
  if (!isRecord(patch)) throw bad('config patch must be an object');
  const c = { ...state.config };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'webhookUrl': {
        const url = nullableString(key, value);
        if (url !== null && !/^https?:\/\//.test(url)) throw bad('webhookUrl must be an http(s) URL');
        c.webhookUrl = url;
        break;
      }
      case 'appSecret':
        if (typeof value !== 'string' || value.length === 0)
          throw bad('appSecret must be a non-empty string');
        c.appSecret = value;
        break;
      case 'verifyToken':
        c.verifyToken = nullableString(key, value);
        break;
      case 'accessToken':
        c.accessToken = nullableString(key, value);
        break;
      case 'phoneNumberId':
        c.phoneNumberId = nullableString(key, value);
        break;
      case 'wabaId':
      case 'displayPhoneE164': {
        const v = nullableString(key, value);
        if (v === null) throw bad(`${key} cannot be null`);
        c[key] = v;
        break;
      }
      case 'autoStatuses':
      case 'deterministicFaults':
      case 'includeUserIds':
        if (typeof value !== 'boolean') throw bad(`${key} must be a boolean`);
        c[key] = value;
        break;
      case 'statusDelayMs':
      case 'webhookRetries':
      case 'webhookRetryDelayMs':
      case 'templateApprovalDelayMs':
        c[key] = nonNegativeInt(key, value);
        break;
      case 'webhookTimeoutMs':
      case 'hangMs':
        c[key] = Math.max(1, nonNegativeInt(key, value));
        break;
      case 'statusOrder':
        if (typeof value !== 'string' || !STATUS_ORDERS.includes(value as never)) {
          throw bad(`statusOrder must be one of ${STATUS_ORDERS.join(', ')}`);
        }
        c.statusOrder = value as SimulatorConfigPatch['statusOrder'] & string;
        break;
      case 'statusSequence':
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((s) => !STATUS_NAMES.includes(s as StatusName))
        ) {
          throw bad(`statusSequence must be a non-empty list of ${STATUS_NAMES.join(', ')}`);
        }
        c.statusSequence = value as StatusName[];
        break;
      default:
        throw bad(`unknown config key "${key}"`);
    }
  }
  state.config = c;
}

/** Delays the status webhooks of the next `count` accepted sends (crash_after_accept, docs/12 §5.13). */
export function setStatusDelay(state: SimulatorState, delayMs: number, count: number): FaultsView {
  state.statusDelayOverride = count > 0 ? { delayMs, remaining: count } : null;
  return state.faultsView();
}

/** Validates a fault rule from the control API. */
export function validateFault(rule: unknown): FaultRule {
  if (!isRecord(rule)) throw new HttpError(400, 'invalid_fault', 'a fault rule must be an object');
  const r = rule as FaultRule;
  if (r.code !== undefined && (!Number.isInteger(r.code) || r.code < 0))
    throw new HttpError(400, 'invalid_fault', 'code must be an integer');
  if (
    r.httpStatus !== undefined &&
    (!Number.isInteger(r.httpStatus) || r.httpStatus < 400 || r.httpStatus > 599)
  ) {
    throw new HttpError(400, 'invalid_fault', 'httpStatus must be 400–599');
  }
  if (r.kind !== undefined && r.kind !== 'error' && r.kind !== 'timeout')
    throw new HttpError(400, 'invalid_fault', 'kind must be error or timeout');
  if (r.mode !== undefined && r.mode !== 'sync' && r.mode !== 'async')
    throw new HttpError(400, 'invalid_fault', 'mode must be sync or async');
  if (r.count !== undefined && r.count !== 'unlimited' && (!Number.isInteger(r.count) || r.count < 1)) {
    throw new HttpError(400, 'invalid_fault', 'count must be a positive integer or "unlimited"');
  }
  if (r.latencyMs !== undefined && (typeof r.latencyMs !== 'number' || r.latencyMs < 0)) {
    throw new HttpError(400, 'invalid_fault', 'latencyMs must be ≥ 0');
  }
  if (r.match !== undefined && !isRecord(r.match))
    throw new HttpError(400, 'invalid_fault', 'match must be an object');
  if (
    r.kind !== 'timeout' &&
    r.mode !== 'async' &&
    r.code === undefined &&
    r.httpStatus === undefined &&
    r.latencyMs === undefined
  ) {
    throw new HttpError(
      400,
      'invalid_fault',
      'give code, httpStatus, mode:"async", kind:"timeout" or latencyMs',
    );
  }
  return r;
}
