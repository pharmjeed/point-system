import { sha256Hex } from '../crypto/crypto.js';

/** JSON with object keys sorted recursively (07 §1.4: canonical JSON of the body + path params). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** request_hash = sha256(method + resolved path + canonical JSON body) (04 §5.2). */
export function requestHash(method: string, resolvedPath: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()} ${resolvedPath}\n${canonicalJson(body ?? null)}`);
}
