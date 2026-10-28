import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error.js';

export type CursorValue = string | number | null;

/**
 * Opaque, HMAC-signed keyset cursors (07 §1.7, 08 §4.3): `base64url(json) + '.' + mac`. The signed body carries a
 * scope (list + path parameters + filters), so a tampered cursor, or one from another list or other filters, is
 * PAGINATION_CURSOR_INVALID (400). The key is derived from SESSION_SECRET.
 */
export class ListCursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac('sha256', 'point.list-cursor.v1').update(secret).digest();
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body).digest().subarray(0, 18);
  }

  encode(scope: string, values: readonly CursorValue[]): string {
    const body = Buffer.from(JSON.stringify({ s: scope, v: values }), 'utf8').toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }

  decode(cursor: string, scope: string, arity: number): CursorValue[] {
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor();
    const [body, mac] = parts as [string, string];
    // compare the encoded text: base64url decoding ignores trailing characters, the signature must match exactly
    const given = Buffer.from(mac, 'utf8');
    const expected = Buffer.from(this.mac(body).toString('base64url'), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidCursor();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw invalidCursor();
    }
    const p = parsed as { s?: unknown; v?: unknown };
    if (p.s !== scope || !Array.isArray(p.v) || p.v.length !== arity) throw invalidCursor();
    if (!p.v.every((x) => x === null || typeof x === 'string' || typeof x === 'number'))
      throw invalidCursor();
    return p.v as CursorValue[];
  }
}

function invalidCursor(): AppError {
  return new AppError('PAGINATION_CURSOR_INVALID');
}

/** Splits a `limit + 1` result into the page and the cursor of its last row. */
export function pageOf<R, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
  cursorOf: (row: R) => string,
): { data: T[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map(map),
    next_cursor: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}
