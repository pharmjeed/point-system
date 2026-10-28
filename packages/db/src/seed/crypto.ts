// Field encryption used by the seed for `users.mfa_secret_enc` (09 §9.1: AES-256-GCM with DATA_ENCRYPTION_KEY).
//
// Ciphertext format (v1, one text column):
//   <keyId>:<iv base64>:<tag base64>:<ciphertext base64>
//   keyId      = DATA_ENCRYPTION_KEY_ID (matches /^[A-Za-z0-9_.-]{1,64}$/, never contains «:»)
//   iv         = 12 random bytes (GCM nonce), standard base64 with padding
//   tag        = 16-byte GCM authentication tag, standard base64
//   ciphertext = AES-256-GCM(key, iv, utf8(plaintext)), standard base64; no additional authenticated data
// The server decrypts with the key named by keyId (rotation keeps old keys readable, 05 §10).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * DEVELOPMENT/TEST ONLY fallback key, used by the seed when DATA_ENCRYPTION_KEY is empty outside
 * production/staging. Configure the server with the same pair to decrypt seeded MFA secrets:
 *   DATA_ENCRYPTION_KEY=<this value>  DATA_ENCRYPTION_KEY_ID=dev0
 */
export const DEV_DATA_ENCRYPTION_KEY = 'J0fYaXmFXs1TdlfW/n9DaIpgvRF/ntOunEAKS7scTFg=';
export const DEV_DATA_ENCRYPTION_KEY_ID = 'dev0';

const KEY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface DataKey {
  id: string;
  key: Buffer;
  /** true when the published dev-only key was used because DATA_ENCRYPTION_KEY was empty. */
  isDevFallback: boolean;
}

function decodeKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64.replace(/\s+/g, '')) {
    throw new Error('DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  }
  return key;
}

/** Resolves the data key from explicit values or the environment; falls back to the dev key only when allowed. */
export function resolveDataKey(input: { key?: string; keyId?: string }, allowDevFallback: boolean): DataKey {
  const raw = input.key?.trim();
  if (!raw) {
    if (!allowDevFallback) throw new Error('DATA_ENCRYPTION_KEY is required');
    return { id: DEV_DATA_ENCRYPTION_KEY_ID, key: decodeKey(DEV_DATA_ENCRYPTION_KEY), isDevFallback: true };
  }
  const id = input.keyId?.trim();
  if (!id) throw new Error('DATA_ENCRYPTION_KEY_ID is required when DATA_ENCRYPTION_KEY is set');
  if (!KEY_ID_RE.test(id)) throw new Error('DATA_ENCRYPTION_KEY_ID must match /^[A-Za-z0-9_.-]{1,64}$/');
  return { id, key: decodeKey(raw), isDevFallback: false };
}

export function encryptField(plaintext: string, dataKey: Pick<DataKey, 'id' | 'key'>): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey.key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [dataKey.id, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Reference decryption of the v1 format (the server implements the same contract). */
export function decryptField(value: string, keys: ReadonlyMap<string, Buffer>): string {
  const parts = value.split(':');
  if (parts.length !== 4) throw new Error('encrypted field: expected <keyId>:<iv>:<tag>:<ciphertext>');
  const [id, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = keys.get(id);
  if (!key) throw new Error(`encrypted field: unknown key id ${JSON.stringify(id)}`);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error('encrypted field: bad iv or tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
