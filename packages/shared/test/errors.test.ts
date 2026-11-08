/**
 * PNT-005 AC3: the error catalog covers every canon §8 code exactly once with the right HTTP
 * status, and carries the exact texts, `retryable`, log level and alert of docs/08 §4.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_TYPES,
  DomainError,
  ERROR_CATALOG,
  ERROR_CODES,
  ERRORS,
  RETRYABLE_ERROR_CODES,
  buildErrorEnvelope,
  errorEnvelopeSchema,
  isDomainError,
  isErrorCode,
  requiresRetryAfter,
} from '../src/index.js';
import type { ErrorCode } from '../src/index.js';
import { backticks, readDoc, section, tableRows } from './docs.js';

const canonRows = tableRows(section(readDoc('00_Glossary_Canon.md'), '## 8.'));
const canonHttp = new Map(canonRows.map((r) => [backticks(r[0] ?? '')[0] ?? '', Number(r[1])]));
const canonMeaning = new Map(canonRows.map((r) => [backticks(r[0] ?? '')[0] ?? '', r[2] ?? '']));

interface GuideRow {
  http: number;
  retryable: boolean;
  message_ar: string;
  message: string;
}
interface GuideBehaviour {
  log: string;
  alert: string | undefined;
}

/** 08 §4: registry rows (code, HTTP, إعادة, message_ar, message_en) and behaviour rows (… السجل · التنبيه). */
function guide(): { registry: Map<string, GuideRow>; behaviour: Map<string, GuideBehaviour> } {
  const registry = new Map<string, GuideRow>();
  const behaviour = new Map<string, GuideBehaviour>();
  for (const r of tableRows(section(readDoc('08_Error_Codes_Guide.md'), '## 4.'))) {
    const code = /^`([A-Z_]+)`$/.exec(r[0] ?? '')?.[1];
    if (!code || r.length !== 5) continue;
    if (/^\d{3}$/.test(r[1] ?? '')) {
      expect(registry.has(code), `08 lists ${code} twice`).toBe(false);
      registry.set(code, {
        http: Number(r[1]),
        retryable: r[2] === 'نعم',
        message_ar: r[3] ?? '',
        message: r[4] ?? '',
      });
    } else {
      const [logPart, ...rest] = (r[4] ?? '').split(' · ');
      const alerts = backticks(rest.join(' · ')).filter((a) =>
        (ALERT_TYPES as readonly string[]).includes(a),
      );
      behaviour.set(code, {
        log: /^(info|warn|error)/.exec(logPart ?? '')?.[1] ?? `?${logPart}`,
        alert: alerts[0],
      });
    }
  }
  return { registry, behaviour };
}

const { registry, behaviour } = guide();

describe('AC3 — catalog covers canon §8', () => {
  it('has every §8 code exactly once, and nothing else', () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...canonHttp.keys()].sort());
    // 96 of V1 + 2 V2 platform codes (DEC-462, DEC-466) + 2 pass codes (DEC-500) + 4 online-payment codes (V2-020 / V2-021)
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(104);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it.each([...canonHttp.entries()])('%s has HTTP %i', (code, http) => {
    expect(ERROR_CATALOG[code as ErrorCode].http).toBe(http);
  });

  it('every entry has a non-empty message and message_ar', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CATALOG[code].message.trim(), code).not.toBe('');
      expect(ERROR_CATALOG[code].message_ar.trim(), code).not.toBe('');
      expect(ERROR_CATALOG[code].message_ar, code).not.toBe('—');
    }
  });

  it('ERRORS is the same catalog', () => {
    expect(ERRORS).toBe(ERROR_CATALOG);
  });
});

describe('catalog equals docs/08 §4', () => {
  it('08 lists the same codes as the canon', () => {
    expect([...registry.keys()].sort()).toEqual([...ERROR_CODES].sort());
    expect([...behaviour.keys()].sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each([...ERROR_CODES])('%s: HTTP, retryable and texts as in 08', (code) => {
    const row = registry.get(code);
    const def = ERROR_CATALOG[code];
    expect(row).toBeDefined();
    expect(def.http).toBe(row?.http);
    expect(def.retryable).toBe(row?.retryable);
    expect(def.message).toBe(row?.message);
    if (row?.message_ar === '—') {
      // 08 gives no Arabic text for the webhook codes (consumer is Meta): the canon §8 meaning is used.
      expect(def.message_ar).toBe(canonMeaning.get(code));
    } else {
      expect(def.message_ar).toBe(row?.message_ar);
    }
  });

  it.each([...ERROR_CODES])('%s: log level and alert as in 08', (code) => {
    const b = behaviour.get(code);
    expect(ERROR_CATALOG[code].log).toBe(b?.log);
    expect(ERROR_CATALOG[code].alert).toBe(b?.alert);
  });

  it('the 08 §9.1 examples match', () => {
    expect(ERROR_CATALOG.TASK_ALREADY_CLAIMED).toMatchObject({ http: 409, retryable: false, log: 'info' });
    expect(ERROR_CATALOG.HANDOVER_CODE_LOCKED).toMatchObject({
      http: 423,
      retryable: false,
      log: 'warn',
      message_ar: 'قُفل التحقق بعد محاولات خاطئة. اتصل بالمشرف.',
      alert: 'handover_code_locked',
    });
  });
});

describe('retryable codes', () => {
  it('equal the list of 07 §1.6', () => {
    const line =
      readDoc('07_API_Contract.md')
        .split('\n')
        .find((l) => l.includes('`retryable=true` فقط')) ?? '';
    const listed = backticks(line).filter(isErrorCode);
    expect([...RETRYABLE_ERROR_CODES].sort()).toEqual([...listed].sort());
    expect(listed).toHaveLength(6);
  });

  it('Retry-After is required on 429, 503 and IDEMPOTENCY_IN_PROGRESS', () => {
    expect(requiresRetryAfter('RATE_LIMITED')).toBe(true);
    expect(requiresRetryAfter('RESEND_LIMIT_REACHED')).toBe(true);
    expect(requiresRetryAfter('SERVICE_UNAVAILABLE')).toBe(true);
    expect(requiresRetryAfter('IDEMPOTENCY_IN_PROGRESS')).toBe(true);
    expect(requiresRetryAfter('VERSION_CONFLICT')).toBe(false);
  });
});

describe('OpenAPI ErrorCode enum', () => {
  it('lists the same codes', () => {
    const yaml = readDoc('07_openapi.yaml');
    const block = /\n {4}ErrorCode:\n {6}type: string\n {6}enum: \[([^\]]*)\]/.exec(yaml)?.[1] ?? '';
    const codes = block
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    expect(codes.sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe('DomainError', () => {
  it('carries the code and details, and exposes HTTP and retryable from the catalog', () => {
    const err = new DomainError('OLDER_REQUEST_PENDING', { older_task_id: 't1' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('OLDER_REQUEST_PENDING');
    expect(err.details).toEqual({ older_task_id: 't1' });
    expect(err.http).toBe(409);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('OLDER_REQUEST_PENDING');
    expect(new DomainError('INTERNAL_ERROR').details).toEqual({});
  });

  it('isDomainError recognises instances and structural copies only', () => {
    expect(isDomainError(new DomainError('RATE_LIMITED'))).toBe(true);
    const copy = Object.assign(new Error('TICKET_NOT_FOUND'), {
      name: 'DomainError',
      code: 'TICKET_NOT_FOUND',
      details: {},
    });
    expect(isDomainError(copy)).toBe(true);
    expect(
      isDomainError(Object.assign(new Error('x'), { name: 'DomainError', code: 'NOPE', details: {} })),
    ).toBe(false);
    expect(isDomainError(new Error('TICKET_NOT_FOUND'))).toBe(false);
    expect(isDomainError({ code: 'TICKET_NOT_FOUND' })).toBe(false);
  });

  it('buildErrorEnvelope produces a valid envelope with catalog texts', () => {
    const env = buildErrorEnvelope('TASK_ALREADY_CLAIMED', 'req_01JBQ7Z3M8X4K2N6P0R5T9V1W3', {
      task_id: 't1',
    });
    expect(errorEnvelopeSchema.parse(env)).toEqual(env);
    expect(env.error).toEqual({
      code: 'TASK_ALREADY_CLAIMED',
      message: 'Another driver accepted this request.',
      message_ar: 'قبل الطلب سائق آخر.',
      request_id: 'req_01JBQ7Z3M8X4K2N6P0R5T9V1W3',
      retryable: false,
      details: { task_id: 't1' },
    });
  });
});
