import type { ErrorCode, WaHealthStatus } from '@point/shared';

/**
 * Error classes of the Cloud API (12 §5.9, 08 §6). Classification is by `error.code`, not by the HTTP
 * status (DEC-PROPOSED in pnt-037 notes); bare 5xx, timeouts and network errors are temporary.
 */
export type WaErrorClass =
  | 'temporary' // retry with backoff 4^x
  | 'throughput' // 130429: retry, slow the global limiter down 20 % for a minute
  | 'pair_limit' // 131056: retry 4^x
  | 'recipient' // 131026, 131021: the number cannot be reached → failed
  | 'outside_window' // 131047: session replies → skipped stale, no alert
  | 'policy' // 131049, 131050: failed (never expected for UTILITY)
  | 'programming' // bad payload/parameters → failed + alert + error log
  | 'template' // template missing/paused/disabled → failed, template status, channel degraded
  | 'channel' // token/permission/account/payment → channel down, notification stays pending
  | 'quality'; // 131048 → channel degraded, retry

export interface GraphFailure {
  /** HTTP status of the answer; null for a timeout or a network error */
  status: number | null;
  kind: 'http' | 'timeout' | 'network';
  /** Graph `error.code` when the body carried one */
  code: number | null;
  message: string;
}

export interface WaErrorClassification {
  cls: WaErrorClass;
  retryable: boolean;
  /** channel health consequence of this single error (12 §5.14) */
  channel: Extract<WaHealthStatus, 'down' | 'degraded'> | null;
  /** internal canon code stored in notifications.last_error_code */
  internalCode: ErrorCode;
  /** new whatsapp_templates.status implied by a template error */
  templateStatus: 'paused' | 'disabled' | 'rejected' | null;
  /** the value stored as provider_error_code ('timeout', 'network', 'http_503' or the Graph code) */
  providerCode: string;
}

const TEMPORARY = new Set([1, 2, 4, 80007, 131000, 131016, 131057, 133004]);
const PROGRAMMING = new Set([100, 131008, 131009, 131051, 132000, 132012, 135000]);
const TEMPLATE = new Set([132001, 132005, 132007, 132015, 132016]);
const CHANNEL = new Set([0, 3, 10, 190, 368, 131005, 131031, 131042, 131045, 133010]);

export function providerCodeOf(f: GraphFailure): string {
  if (f.kind !== 'http') return f.kind;
  return f.code !== null ? String(f.code) : `http_${f.status}`;
}

export function classifyGraphFailure(f: GraphFailure): WaErrorClassification {
  const providerCode = providerCodeOf(f);
  const make = (
    cls: WaErrorClass,
    retryable: boolean,
    internalCode: ErrorCode,
    channel: WaErrorClassification['channel'] = null,
    templateStatus: WaErrorClassification['templateStatus'] = null,
  ): WaErrorClassification => ({ cls, retryable, channel, internalCode, templateStatus, providerCode });

  if (f.kind === 'timeout') return make('temporary', true, 'DEPENDENCY_TIMEOUT');
  if (f.kind === 'network') return make('temporary', true, 'WA_SEND_FAILED');
  const code = f.code;
  if (code === null) {
    // bare HTTP failure without a Graph code (gateway, proxy, upstream)
    if (f.status === 429 || (f.status !== null && f.status >= 500))
      return make('temporary', true, 'WA_SEND_FAILED');
    return make('programming', false, 'WA_SEND_FAILED');
  }
  if (code === 130429) return make('throughput', true, 'WA_SEND_FAILED');
  if (code === 131056) return make('pair_limit', true, 'WA_SEND_FAILED');
  if (TEMPORARY.has(code)) return make('temporary', true, 'WA_SEND_FAILED');
  if (code === 131048) return make('quality', true, 'WA_SEND_FAILED', 'degraded');
  if (code === 131026 || code === 131021) return make('recipient', false, 'WA_SEND_FAILED');
  if (code === 131047) return make('outside_window', false, 'WA_SEND_FAILED');
  if (code === 131049 || code === 131050) return make('policy', false, 'WA_SEND_FAILED');
  if (PROGRAMMING.has(code)) return make('programming', false, 'WA_SEND_FAILED');
  if (TEMPLATE.has(code)) {
    const status = code === 132015 ? 'paused' : code === 132016 ? 'disabled' : 'rejected';
    return make('template', false, 'WA_TEMPLATE_NOT_APPROVED', 'degraded', status);
  }
  if (CHANNEL.has(code) || (code >= 200 && code <= 299))
    return make('channel', true, 'WA_CHANNEL_UNAVAILABLE', 'down');
  if (f.status === 429 || (f.status !== null && f.status >= 500))
    return make('temporary', true, 'WA_SEND_FAILED');
  // an unknown code is treated as a permanent programming error and logged (never an endless loop)
  return make('programming', false, 'WA_SEND_FAILED');
}

/** Provider messages may echo numbers; keep them out of the database and logs (12 §5.12). */
export function sanitizeProviderMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  return message
    .replace(/\+?\d[\d\s-]{5,}\d/g, '•••')
    .replace(/wamid\.[A-Za-z0-9._=-]+/g, 'wamid.•••')
    .slice(0, 300);
}
