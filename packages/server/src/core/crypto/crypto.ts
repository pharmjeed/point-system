import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Opaque random token (base64url), e.g. a 256-bit session token or an action token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniform random numeric code of `digits` digits (claim codes, PINs). */
export function randomDigits(digits: number): string {
  let s = '';
  for (let i = 0; i < digits; i++) s += String(randomInt(0, 10));
  return s;
}

export function hmacHex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface EncryptionKey {
  id: string;
  key: Buffer; // 32 bytes
}

export function parseEncryptionKey(base64: string, id: string): EncryptionKey {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
  return { id, key };
}

/**
 * AES-256-GCM. Ciphertext format: `<keyId>:<iv b64>:<tag b64>:<ct b64>` (shared with the seed). The key id
 * allows rotation: old keys stay readable until re-encryption (05 §10).
 */
export function encrypt(plain: string, k: EncryptionKey): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [k.id, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload: string, keys: EncryptionKey | EncryptionKey[]): string {
  const [id, iv, tag, ct] = payload.split(':');
  if (!id || !iv || !tag || !ct) throw new Error('malformed ciphertext');
  const k = (Array.isArray(keys) ? keys : [keys]).find((x) => x.id === id);
  if (!k) throw new Error(`unknown encryption key id ${id}`);
  const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
