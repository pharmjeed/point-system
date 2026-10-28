import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../core/errors/app-error.js';

export type CursorValue = string | number | null;

/**
 * Opaque HMAC-signed keyset cursors of the report lists (07 §1.7, DEC-124 pattern): `base64url(json).mac`, the
 * signed body carrying the list scope (route + filters). A tampered cursor or one from another list or other
 * filters → 400 PAGINATION_CURSOR_INVALID. The key is derived from SESSION_SECRET.
 */
export class ReportCursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac('sha256', 'point.report-cursor.v1').update(secret).digest();
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest().subarray(0, 18).toString('base64url');
  }

  encode(scope: string, values: readonly CursorValue[]): string {
    const body = Buffer.from(JSON.stringify({ s: scope, v: values }), 'utf8').toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  decode(cursor: string, scope: string, arity: number): CursorValue[] {
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
    const [body, mac] = parts as [string, string];
    const given = Buffer.from(mac, 'utf8');
    const expected = Buffer.from(this.mac(body), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw invalid();
    }
    const p = parsed as { s?: unknown; v?: unknown };
    if (p.s !== scope || !Array.isArray(p.v) || p.v.length !== arity) throw invalid();
    if (!p.v.every((x) => x === null || typeof x === 'string' || typeof x === 'number')) throw invalid();
    return p.v as CursorValue[];
  }
}

const invalid = () => new AppError('PAGINATION_CURSOR_INVALID');
