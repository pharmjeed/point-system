import type { ZatcaStatus } from '@point/shared';
import type { EInvoiceDocument } from './document.js';

/** A code the provider (or ZATCA through it) answered: errors reject a document, warnings do not. */
export interface ProviderCode {
  code: string;
  category: 'error' | 'warning';
  field?: string;
}

export type ProviderAnswer =
  /** the document is in ZATCA's books: reported (simplified) or cleared (standard), with the provider's artefacts */
  | {
      ok: true;
      status: Extract<ZatcaStatus, 'reported' | 'cleared'>;
      reference: string;
      /** the hash of the signed XML (ZATCA's invoice hash), when the provider gives it */
      hash: string | null;
      /** the stamped QR (tags 1–9), when the provider gives it */
      qr: string | null;
      warnings: ProviderCode[];
    }
  /** rejected for good (a validation error): the document stays in the chain and is corrected by a credit note */
  | { ok: false; kind: 'rejected'; codes: ProviderCode[] }
  /** not answered (network, provider down, not configured): retried */
  | { ok: false; kind: 'unavailable' | 'refused'; message: string };

/** A status the provider pushes later (`POST /webhooks/einvoicing`), once its signature is verified. */
export interface ProviderCallback {
  invoiceUuid: string;
  status: Extract<ZatcaStatus, 'reported' | 'cleared' | 'rejected'>;
  reference: string | null;
  codes: ProviderCode[];
}

/**
 * The e-invoicing provider (V2-040, V2-D13; DEC-540): the provider is not chosen yet (DEC-460), so POINT talks to this
 * port only. `report` sends a simplified invoice or its credit note (reporting, within 24 hours of issue); `clear`
 * sends a standard invoice or its credit note and waits for ZATCA's clearance; `verifyCallback` checks and reads the
 * provider's asynchronous status notice. No call is ever made inside a database transaction (canon rule 3).
 */
export interface EInvoicingProvider {
  readonly name: string;
  report(doc: EInvoiceDocument): Promise<ProviderAnswer>;
  clear(doc: EInvoiceDocument): Promise<ProviderAnswer>;
  /** null: the signature is missing or wrong (EINVOICE_WEBHOOK_SIGNATURE_INVALID) */
  verifyCallback(raw: Buffer, signature: string | undefined): Promise<ProviderCallback | null>;
}
