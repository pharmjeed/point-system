import { createHmac, timingSafeEqual } from 'node:crypto';
import { INVOICE_TRANSACTION_SUBTYPE, ZATCA_STATUSES } from '@point/shared';
import { documentHash, sar, type EInvoiceDocument } from '../domain/document.js';
import type {
  EInvoicingProvider,
  ProviderAnswer,
  ProviderCallback,
  ProviderCode,
} from '../domain/provider.js';
import { decodeTlv } from '../domain/qr.js';

const VAT_RE = /^3[0-9]{13}3$/;
const CR_RE = /^[0-9]{10}$/;
const B64 = /^[A-Za-z0-9+/]{40,120}={0,2}$/;
const DAY_MS = 86_400_000;

export interface SimulatorOptions {
  /** the clock the 24-hour reporting window and the future-dated check are read from */
  now?: () => Date;
  /** the callback secret(s): current and previous while it rotates */
  callbackSecrets?: () => Promise<string[]>;
}

/**
 * The e-invoicing simulator (V2-040, DEC-540): no network, every environment but production. It answers like a
 * provider would after validating what ZATCA validates on POINT's part of a document (DEC-542) — the seller's VAT
 * and CR numbers, the counter and previous-hash fields, the document hash recomputed from its content, the type code
 * and subtype of its series, a credit note's original reference and reason (BR-KSA-17 / KSA-10), the buyer of a
 * standard invoice, the arithmetic of every line (VAT within a halala of net × rate) and of the totals, the issue
 * time (not in the future; a simplified document later than 24 hours is reported with a warning) and the QR tags 1–5
 * against the document. It signs nothing: the stamped QR and the XML hash are the real provider's.
 *
 * Test seams: `failNext('unavailable' | 'rejected')` makes the next submission fail that way.
 */
export class SimulatorEInvoicingProvider implements EInvoicingProvider {
  readonly name = 'simulator';
  private failures: ('unavailable' | 'rejected')[] = [];
  readonly submitted: { uuid: string; number: string; via: 'report' | 'clear' }[] = [];

  constructor(private readonly opts: SimulatorOptions = {}) {}

  failNext(kind: 'unavailable' | 'rejected'): void {
    this.failures.push(kind);
  }

  async report(doc: EInvoiceDocument): Promise<ProviderAnswer> {
    return this.answer(doc, 'report');
  }

  async clear(doc: EInvoiceDocument): Promise<ProviderAnswer> {
    return this.answer(doc, 'clear');
  }

  async verifyCallback(raw: Buffer, signature: string | undefined): Promise<ProviderCallback | null> {
    const secrets = (await this.opts.callbackSecrets?.()) ?? [];
    if (!secrets.length || !signature?.startsWith('sha256=')) return null;
    const given = Buffer.from(signature.slice('sha256='.length), 'utf8');
    const ok = secrets.some((s) => {
      const expected = Buffer.from(SimulatorEInvoicingProvider.sign(raw, s).slice(7), 'utf8');
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
    if (!ok) return null;
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    const b = body as Record<string, unknown>;
    const status = b.status;
    if (
      typeof b.invoice_uuid !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(b.invoice_uuid) ||
      typeof status !== 'string' ||
      !(ZATCA_STATUSES as readonly string[]).includes(status) ||
      status === 'pending'
    )
      return null;
    const codes = Array.isArray(b.codes) ? b.codes.filter(isCode).slice(0, 20) : [];
    return {
      invoiceUuid: b.invoice_uuid,
      status: status as ProviderCallback['status'],
      reference: typeof b.reference === 'string' ? b.reference.slice(0, 120) : null,
      codes,
    };
  }

  /** `X-Einvoice-Signature` of a callback body: `sha256=<hex HMAC-SHA256>` (tests and local tools). */
  static sign(raw: Buffer | string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  }

  /** What the simulator checks; an empty list means the document is accepted. */
  validate(doc: EInvoiceDocument, via: 'report' | 'clear'): ProviderCode[] {
    const errors: ProviderCode[] = [];
    const err = (code: string, field?: string) =>
      errors.push({ code, category: 'error', ...(field ? { field } : {}) });
    const expectedVia = doc.series === 'simplified' ? 'report' : 'clear';
    if (via !== expectedVia) err('wrong_channel', 'series');
    if (doc.subtype !== INVOICE_TRANSACTION_SUBTYPE[doc.series]) err('subtype_mismatch', 'subtype');
    if (doc.typeCode !== (doc.kind === 'credit_note' ? 381 : 388)) err('type_code_mismatch', 'type_code');
    if (!doc.seller.legal_name_ar.trim()) err('seller_name_missing', 'seller.legal_name_ar');
    if (!VAT_RE.test(doc.seller.vat_number)) err('seller_vat_invalid', 'seller.vat_number');
    if (!CR_RE.test(doc.seller.cr_number)) err('seller_cr_invalid', 'seller.cr_number');
    if (!doc.seller.address_ar.trim()) err('seller_address_missing', 'seller.address_ar');
    if (!Number.isSafeInteger(doc.icv) || doc.icv < 1) err('icv_invalid', 'icv');
    if (!B64.test(doc.previousHash)) err('pih_invalid', 'previous_hash');
    if (documentHash(doc) !== doc.invoiceHash) err('hash_mismatch', 'invoice_hash');
    if (doc.kind === 'credit_note') {
      if (!doc.original) err('billing_reference_missing', 'original');
      if (!doc.creditReason || doc.creditReason.trim().length < 3)
        err('credit_reason_missing', 'credit_reason');
    }
    if (doc.series === 'standard') {
      if (!doc.buyer.legal_name_ar?.trim()) err('buyer_name_missing', 'buyer.legal_name_ar');
      if (doc.buyer.vat_number && !VAT_RE.test(doc.buyer.vat_number))
        err('buyer_vat_invalid', 'buyer.vat_number');
    }
    if (!doc.lines.length) err('no_lines', 'lines');
    let net = 0;
    let vat = 0;
    doc.lines.forEach((l, i) => {
      if (l.net_halalas + l.vat_halalas !== l.total_halalas) err('line_total_mismatch', `lines[${i}]`);
      if (Math.abs(l.vat_halalas * 10_000 - l.net_halalas * l.vat_rate_bp) > 10_000)
        err('line_vat_mismatch', `lines[${i}]`);
      if (l.vat_rate_bp !== doc.vatRateBp) err('line_rate_mismatch', `lines[${i}]`);
      net += l.net_halalas;
      vat += l.vat_halalas;
    });
    if (net !== doc.subtotalHalalas) err('subtotal_mismatch', 'subtotal');
    if (vat !== doc.vatHalalas) err('vat_total_mismatch', 'vat');
    if (doc.subtotalHalalas + doc.vatHalalas !== doc.totalHalalas) err('total_mismatch', 'total');
    const now = this.opts.now?.() ?? new Date();
    const issued = Date.parse(doc.issuedAt);
    if (Number.isNaN(issued) || issued > now.getTime() + 5 * 60_000) err('issue_time_invalid', 'issued_at');
    try {
      const qr = decodeTlv(doc.qr);
      if (
        qr.get(1) !== doc.seller.legal_name_ar ||
        qr.get(2) !== doc.seller.vat_number ||
        qr.get(3) !== doc.issuedAt ||
        qr.get(4) !== sar(doc.totalHalalas) ||
        qr.get(5) !== sar(doc.vatHalalas)
      )
        err('qr_mismatch', 'qr');
    } catch {
      err('qr_invalid', 'qr');
    }
    return errors;
  }

  private async answer(doc: EInvoiceDocument, via: 'report' | 'clear'): Promise<ProviderAnswer> {
    const forced = this.failures.shift();
    if (forced === 'unavailable') return { ok: false, kind: 'unavailable', message: 'simulated outage' };
    if (forced === 'rejected')
      return { ok: false, kind: 'rejected', codes: [{ code: 'simulated_rejection', category: 'error' }] };
    const errors = this.validate(doc, via);
    if (errors.length) return { ok: false, kind: 'rejected', codes: errors };
    const warnings: ProviderCode[] = [];
    const now = this.opts.now?.() ?? new Date();
    if (doc.series === 'simplified' && now.getTime() - Date.parse(doc.issuedAt) > DAY_MS)
      warnings.push({ code: 'reported_after_24h', category: 'warning' });
    this.submitted.push({ uuid: doc.uuid, number: doc.number, via });
    return {
      ok: true,
      status: doc.series === 'simplified' ? 'reported' : 'cleared',
      reference: `sim-${doc.uuid}`,
      hash: doc.invoiceHash,
      qr: doc.qr,
      warnings,
    };
  }
}

function isCode(c: unknown): c is ProviderCode {
  const x = c as ProviderCode;
  return (
    !!x &&
    typeof x.code === 'string' &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(x.code) &&
    (x.category === 'error' || x.category === 'warning')
  );
}

/**
 * `EINVOICE_MODE=live` before the owner chose the provider (DEC-460, DEC-540): there is no adapter to send a document
 * to, so every submission is refused without any network call — the invoice stays `pending`, the job retries and
 * finance gets an `einvoice_submit_failed` alert. A real adapter replaces this class.
 */
export class UnconfiguredLiveProvider implements EInvoicingProvider {
  readonly name = 'live';
  async report(): Promise<ProviderAnswer> {
    return { ok: false, kind: 'refused', message: 'no e-invoicing provider adapter is configured' };
  }
  async clear(): Promise<ProviderAnswer> {
    return { ok: false, kind: 'refused', message: 'no e-invoicing provider adapter is configured' };
  }
  async verifyCallback(): Promise<ProviderCallback | null> {
    return null;
  }
}
