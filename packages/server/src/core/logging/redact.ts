/**
 * Mandatory redaction list (05 §7.6, 08 §9.4): cookies and the authorization header, any key containing
 * phone / wa_id / code / token / pin / password / secret, raw_body, code_ciphertext, mfa_secret_enc and the
 * Push subscription fields. Applied to every log line, audit diff and outbox payload check.
 */
const SENSITIVE_KEY =
  /(phone|wa_id|wa_user_id|code|token|pin|password|secret|cookie|authorization|raw_body|ciphertext|mfa_secret|push_endpoint|push_p256dh|push_auth|payload_text)/i;

/** Keys that contain a sensitive word but are known-safe identifiers or enums. */
const SAFE_KEYS = new Set([
  'code_id',
  'error_code',
  'claim_code_id',
  'link_code_id',
  'action_token_id',
  'employee_code',
  'venue_code',
  'status_code',
  'response_code',
  'http_code',
  'secret_kind',
  'must_change_secret',
  'phone_masked',
  'code', // the error code inside an error envelope is never sensitive: see isErrorEnvelopeCode
]);

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  return SENSITIVE_KEY.test(key);
}

/**
 * Deep-copies `value` replacing sensitive keys. `code` is sensitive unless its value looks like a canon
 * error code (UPPER_SNAKE): claim and link codes are digits/short strings.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'code') {
      out[k] = typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v) ? v : REDACTED;
    } else if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out as T;
}

/** Returns the dotted paths of sensitive keys found in `value` (used to reject outbox payloads). */
export function findSensitiveKeys(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (
      !Array.isArray(value) &&
      (k === 'code' ? !(typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v)) : isSensitiveKey(k))
    ) {
      found.push(path);
    } else {
      found.push(...findSensitiveKeys(v, path, depth + 1));
    }
  }
  return found;
}

/** `+966551234123` → `05•••••123` (canon §15). */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  const local = digits.startsWith('966') ? '0' + digits.slice(3) : digits;
  if (local.length < 5) return '•••';
  return local.slice(0, 2) + '•'.repeat(Math.max(local.length - 5, 1)) + local.slice(-3);
}
