import { hmacHex, safeEqual } from '../../../core/crypto/crypto.js';
import { AppError } from '../../../core/errors/app-error.js';

/**
 * Opaque, HMAC-signed pagination cursors (07 §1.7, 08 §4: a tampered cursor or one from another route is
 * `400 PAGINATION_CURSOR_INVALID`). The route name is part of the signed text.
 */
export class CursorCodec {
  private readonly key: Buffer;
  constructor(secretBase64: string) {
    this.key = Buffer.concat([Buffer.from('point-cursor:'), Buffer.from(secretBase64, 'base64')]);
  }

  encode(route: string, value: Record<string, string | number>): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${this.sign(route, body)}`;
  }

  decode<T extends Record<string, unknown>>(route: string, cursor: string, check: (v: unknown) => v is T): T {
    const [body, sig, extra] = cursor.split('.');
    if (!body || !sig || extra !== undefined || !safeEqual(sig, this.sign(route, body)))
      throw new AppError('PAGINATION_CURSOR_INVALID');
    let v: unknown;
    try {
      v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('PAGINATION_CURSOR_INVALID');
    }
    if (!check(v)) throw new AppError('PAGINATION_CURSOR_INVALID');
    return v;
  }

  private sign(route: string, body: string): string {
    return hmacHex(this.key, `${route}|${body}`).slice(0, 32);
  }
}

/** `{ id: <positive integer> }` (audit_log.id, outbox_events.seq) */
export function isIdCursor(v: unknown): v is { id: number } {
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isSafeInteger((v as { id?: unknown }).id) &&
    ((v as { id: number }).id ?? 0) > 0
  );
}
