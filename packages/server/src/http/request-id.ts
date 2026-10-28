import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID (time-ordered, Crockford base32). */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

const ACCEPTED = /^[A-Za-z0-9_-]{8,64}$/;

/** `X-Request-Id` is accepted when well-formed, otherwise `req_<ulid>` is generated (04 §5.1). */
export function resolveRequestId(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return v && ACCEPTED.test(v) ? v : `req_${ulid()}`;
}
