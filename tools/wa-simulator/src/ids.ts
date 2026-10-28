import { createHash, randomUUID } from 'node:crypto';

export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

/** A BSUID looks like `<country>.<id>` (docs/12 F-21); a phone never contains a dot. */
export function looksLikeBsuid(value: string): boolean {
  return value.includes('.') && /[A-Za-z]/.test(value);
}

/** Simulated message id, `wamid.SIM.<uuid>` (docs/12 §11.1). */
export function newWamid(): string {
  return `wamid.SIM.${randomUUID()}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic fake business-scoped user id (BSUID, DEC-35) for a phone number:
 * `<ISO country>.<20 digits>`; the real format is re-verified at implementation (docs/12 F-21).
 */
export function bsuidFor(waId: string): string {
  const country = waId.startsWith('966') ? 'SA' : 'ZZ';
  const n = BigInt(`0x${sha256Hex(`bsuid:${waId}`).slice(0, 16)}`);
  return `${country}.${n.toString().padStart(20, '0')}`;
}

/** `•••567` — never log a full phone number or BSUID (CLAUDE.md §3.8). */
export function mask(value: string | null | undefined): string {
  if (!value) return '-';
  return `•••${value.slice(-3)}`;
}

/** Unix seconds as a string, the timestamp format of WhatsApp webhooks. */
export function unixSeconds(input?: number | string | Date): string {
  if (input === undefined) return String(Math.floor(Date.now() / 1000));
  if (input instanceof Date) return String(Math.floor(input.getTime() / 1000));
  if (typeof input === 'number') return String(Math.floor(input));
  if (/^\d+$/.test(input)) return input;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${input}`);
  return String(Math.floor(ms / 1000));
}
