/**
 * The ZATCA QR code (DEC-542): a base64 TLV — one byte tag, one byte length (of the UTF-8 value), the value. Tags 1–5
 * are POINT's: seller name, seller VAT number, the invoice time (ISO 8601), the total with VAT and the VAT total.
 * Phase 2 adds tags 6–9 (the XML hash, the ECDSA signature, the public key and, for simplified invoices, ZATCA's
 * stamp of the key): they come from the provider's signing unit, which answers with the stamped QR (`provider_qr`).
 */
export interface QrFields {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
}

export function encodeTlv(entries: readonly (readonly [number, string])[]): string {
  const parts: Buffer[] = [];
  for (const [tag, value] of entries) {
    const v = Buffer.from(value, 'utf8');
    if (tag < 1 || tag > 255) throw new RangeError('TLV tag');
    if (v.length > 255) throw new RangeError(`TLV value of tag ${tag} longer than 255 bytes`);
    parts.push(Buffer.from([tag, v.length]), v);
  }
  return Buffer.concat(parts).toString('base64');
}

export function decodeTlv(b64: string): Map<number, string> {
  const buf = Buffer.from(b64, 'base64');
  const out = new Map<number, string>();
  for (let i = 0; i < buf.length;) {
    const tag = buf[i]!;
    const len = buf[i + 1];
    if (len === undefined || i + 2 + len > buf.length) throw new RangeError('truncated TLV');
    out.set(tag, buf.subarray(i + 2, i + 2 + len).toString('utf8'));
    i += 2 + len;
  }
  return out;
}

export function zatcaQr(f: QrFields): string {
  return encodeTlv([
    [1, f.sellerName],
    [2, f.vatNumber],
    [3, f.timestamp],
    [4, f.totalWithVat],
    [5, f.vatTotal],
  ]);
}
