import type { ZatcaStatus } from '@point/shared';
import { raisePlatformAlert, resolvePlatformAlert } from '../../../core/alerts/platform-alerts.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { RetryableJobError, backoffMs, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { enqueue } from '../../../core/outbox/outbox-writer.js';
import { platformOrgId } from '../../payments-online/index.js';
import { EINVOICE_SUBMIT_JOB, INVOICE_PDF_RENDER_JOB } from '../domain/jobs.js';
import type { ProviderAnswer, ProviderCode } from '../domain/provider.js';
import { renderInvoicePdf } from '../infra/pdf.js';
import type { InvoicingRuntime } from '../runtime.js';
import { invoiceById, toDocument, type InvoiceRow } from './issue.js';

const STATUS_AR: Record<ZatcaStatus, string> = {
  pending: 'بانتظار الإرسال',
  reported: 'مُبلَّغ عنها',
  cleared: 'معتمدة',
  rejected: 'مرفوضة',
};

/** The object key of an invoice's PDF in the private bucket. */
export const invoicePdfKey = (r: Pick<InvoiceRow, 'series' | 'number'>) =>
  `invoices/${r.series}/${r.number}.pdf`;

/**
 * Writes what the provider answered on a pending invoice (holding its row): the status and the provider's
 * artefacts once accepted (then the PDF is queued), the codes of a rejection (with an `einvoice_rejected` alert:
 * a rejected document stays in the chain and is corrected by a credit note). A later answer on a document already
 * answered changes nothing (`ignored`). Every answer is a row of `invoice_provider_events`.
 */
export async function applyProviderAnswer(
  tx: Tx,
  invoiceId: string,
  answer:
    | { kind: 'submit'; result: ProviderAnswer }
    | {
        kind: 'callback';
        status: 'reported' | 'cleared' | 'rejected';
        reference: string | null;
        codes: ProviderCode[];
      },
): Promise<'accepted' | 'rejected' | 'ignored' | 'error'> {
  const row = await tx.maybeOne<{ zatca_status: ZatcaStatus; number: string; org_id: string | null }>(
    `SELECT zatca_status, number, org_id FROM invoices WHERE id = $1 FOR NO KEY UPDATE`,
    [invoiceId],
  );
  if (!row) return 'ignored';
  let outcome: 'accepted' | 'rejected' | 'ignored' | 'error';
  let status: ZatcaStatus | null = null;
  let codes: ProviderCode[];
  let reference: string | null = null;
  let hash: string | null = null;
  let qr: string | null = null;
  if (answer.kind === 'submit') {
    const r = answer.result;
    if (r.ok) {
      outcome = 'accepted';
      status = r.status;
      codes = r.warnings;
      reference = r.reference;
      hash = r.hash;
      qr = r.qr;
    } else if (r.kind === 'rejected') {
      outcome = 'rejected';
      status = 'rejected';
      codes = r.codes;
    } else {
      outcome = 'error';
      codes = [{ code: r.kind, category: 'error' }];
    }
  } else {
    outcome = answer.status === 'rejected' ? 'rejected' : 'accepted';
    status = answer.status;
    codes = answer.codes;
    reference = answer.reference;
  }
  if (row.zatca_status !== 'pending' && outcome !== 'error') outcome = 'ignored';
  await tx.query(
    `INSERT INTO invoice_provider_events (invoice_id, kind, outcome, zatca_status, codes, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      invoiceId,
      answer.kind,
      outcome,
      outcome === 'ignored' ? row.zatca_status : status,
      JSON.stringify(codes),
      tx.now,
    ],
  );
  if (outcome === 'error' || outcome === 'ignored') return outcome;
  await tx.query(
    `UPDATE invoices SET zatca_status = $2, provider_reference = $3, provider_hash = $4, provider_qr = $5,
            provider_codes = $6, submitted_at = COALESCE(submitted_at, $7), status_at = $7
      WHERE id = $1 AND zatca_status = 'pending'`,
    [invoiceId, status, reference, hash, qr, JSON.stringify(codes), tx.now],
  );
  await platformAudit(tx, {
    actor: { type: 'system', id: null, name: 'invoicing' },
    action: `invoice.${status}`,
    entityType: 'invoice',
    entityId: invoiceId,
    orgId: row.org_id,
    metadata: { number: row.number, source: answer.kind, codes: codes.map((c) => c.code) },
  });
  const queueOrg = (await platformOrgId(tx))!;
  if (outcome === 'accepted') {
    await enqueue(tx, {
      type: INVOICE_PDF_RENDER_JOB,
      orgId: queueOrg,
      aggregate: { type: 'invoice', id: invoiceId },
      dedupeKey: `invoice_pdf:${invoiceId}`,
      payload: { invoice_id: invoiceId },
    });
    await resolvePlatformAlert(tx, `einvoice_submit_failed:${invoiceId}`, 'accepted by the provider');
  } else {
    await raisePlatformAlert(tx, {
      type: 'einvoice_rejected',
      dedupeKey: `einvoice_rejected:${invoiceId}`,
      details: { invoice_id: invoiceId, number: row.number, codes: codes.map((c) => c.code).slice(0, 20) },
    });
  }
  return outcome;
}

/**
 * `job.einvoice_submit` (mode external, DEC-543): sends a pending document to the provider outside any transaction
 * — `report` for the simplified series, `clear` for the standard series — then writes its answer. Documents of a
 * series go one after the other (ordering key), so the provider sees the chain in order. A provider that does not
 * answer is retried with backoff; the last attempt raises `einvoice_submit_failed` for finance.
 */
export function einvoiceSubmitJob(runtime: () => InvoicingRuntime): JobHandler {
  return {
    type: EINVOICE_SUBMIT_JOB,
    mode: 'external',
    async handle({ row, db }) {
      const id = row.payload?.invoice_id;
      if (typeof id !== 'string') return;
      const inv = await invoiceById(db, id);
      if (!inv || inv.zatca_status !== 'pending') return;
      const rt = runtime();
      const doc = toDocument(inv);
      const result =
        inv.series === 'simplified' ? await rt.provider.report(doc) : await rt.provider.clear(doc);
      if (!result.ok && result.kind !== 'rejected') {
        const last = row.attempts >= row.max_attempts;
        await db.transaction(async (tx) => {
          await applyProviderAnswer(tx, id, { kind: 'submit', result });
          if (last)
            await raisePlatformAlert(tx, {
              type: 'einvoice_submit_failed',
              dedupeKey: `einvoice_submit_failed:${id}`,
              details: { invoice_id: id, number: inv.number, reason: result.kind },
            });
        });
        if (!last) throw new RetryableJobError(`e-invoice ${result.kind}`, backoffMs(row.attempts));
        return;
      }
      await db.transaction((tx) =>
        applyProviderAnswer(tx, id, { kind: 'submit', result }).then(() => undefined),
      );
    },
  };
}

/**
 * `job.invoice_pdf_render` (mode external, DEC-548): renders the document's PDF (Arabic, right to left, with its QR —
 * the provider's stamped one when it gave one), writes it to the private bucket (create-only) and records its key
 * once. Re-running it after a lost answer finds the object and only records the key.
 */
export function invoicePdfRenderJob(runtime: () => InvoicingRuntime): JobHandler {
  return {
    type: INVOICE_PDF_RENDER_JOB,
    mode: 'external',
    async handle({ row, db }) {
      const id = row.payload?.invoice_id;
      if (typeof id !== 'string') return;
      const inv = await invoiceById(db, id);
      if (!inv || inv.pdf_storage_key) return;
      const rt = runtime();
      const key = invoicePdfKey(inv);
      const pdf = await renderInvoicePdf(toDocument(inv), {
        simulated: inv.provider === 'simulator',
        qr: inv.provider_qr ?? inv.qr_payload,
        status: STATUS_AR[inv.zatca_status],
      });
      try {
        await rt.storage().put(key, pdf, {
          contentType: 'application/pdf',
          cacheControl: 'private, no-store',
          ifNoneMatch: true,
        });
      } catch (e) {
        throw new RetryableJobError(
          `invoice PDF upload failed: ${(e as Error).message}`,
          backoffMs(row.attempts),
        );
      }
      await db.query(
        `UPDATE invoices SET pdf_storage_key = $2, pdf_rendered_at = $3 WHERE id = $1 AND pdf_storage_key IS NULL`,
        [id, key, rt.clock.now()],
      );
    },
  };
}

/**
 * `POST /webhooks/einvoicing` (DEC-543): the provider's asynchronous status of a document, signed over the raw body.
 * A wrong or missing signature is EINVOICE_WEBHOOK_SIGNATURE_INVALID before anything is read; an unknown document is
 * acknowledged and ignored (nothing to apply).
 */
export async function receiveProviderCallback(
  db: Database,
  rt: InvoicingRuntime,
  raw: Buffer | undefined,
  signature: string | undefined,
): Promise<void> {
  const cb = raw ? await rt.provider.verifyCallback(raw, signature) : null;
  if (!cb) throw new AppError('EINVOICE_WEBHOOK_SIGNATURE_INVALID');
  await db.transaction(async (tx) => {
    const inv = await tx.maybeOne<{ id: string }>(`SELECT id FROM invoices WHERE zatca_uuid = $1`, [
      cb.invoiceUuid,
    ]);
    if (!inv) return;
    await applyProviderAnswer(tx, inv.id, {
      kind: 'callback',
      status: cb.status,
      reference: cb.reference,
      codes: cb.codes,
    });
  });
}
