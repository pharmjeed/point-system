// Public surface of the invoicing module (V2-040 / V2-042, DEC-540 … DEC-543, DEC-548): the e-invoicing provider
// port and its simulator, the invoice chain, issuing documents, the provider's answers, the PDFs and the reads.
import type { JobHandler } from '../../core/outbox/dispatcher.js';
import { registerPaymentDocumentsHook } from '../payments-online/index.js';
import { paymentDocuments } from './application/issue.js';
import { einvoiceSubmitJob, invoicePdfRenderJob } from './application/submission.js';
import { defaultInvoicingRuntime, InvoicingRuntime } from './runtime.js';

export { InvoicingHttpModule } from './invoicing.module.js';
export {
  InvoicingRuntime,
  currentInvoicingRuntime,
  defaultInvoicingRuntime,
  type InvoicingDeps,
} from './runtime.js';
export type * from './domain/provider.js';
export {
  documentHash,
  invoiceNumber,
  isoSecond,
  sar,
  type EInvoiceDocument,
  type InvoiceBuyer,
} from './domain/document.js';
export { decodeTlv, encodeTlv, zatcaQr } from './domain/qr.js';
export { EINVOICE_SUBMIT_JOB, INVOICE_PDF_RENDER_JOB } from './domain/jobs.js';
export { SimulatorEInvoicingProvider, UnconfiguredLiveProvider } from './infra/simulator.js';
export { bidiRuns, renderInvoicePdf } from './infra/pdf.js';
export {
  ensureCustomerInvoice,
  inclusiveLine,
  invoiceById,
  issueDocument,
  issueFullCreditNote,
  issueRefundCreditNote,
  paymentDocuments,
  toDocument,
  INVOICE_SELECT,
  type InvoiceRow,
  type IssueInput,
} from './application/issue.js';
export {
  applyProviderAnswer,
  einvoiceSubmitJob,
  invoicePdfKey,
  invoicePdfRenderJob,
  receiveProviderCallback,
} from './application/submission.js';
export {
  customerInvoice,
  customerInvoices,
  invoiceView,
  operatorInvoice,
  operatorInvoices,
  pdfLink,
  PlatformInvoicesConsole,
} from './application/reads.js';

// every payment whose money was taken gets its simplified invoice, every succeeded refund its credit note (api and
// worker load this module)
registerPaymentDocumentsHook(paymentDocuments);

type RuntimeOption = InvoicingRuntime | (() => InvoicingRuntime);
const asFactory = (given?: RuntimeOption): (() => InvoicingRuntime) =>
  given instanceof InvoicingRuntime
    ? () => given
    : typeof given === 'function'
      ? given
      : () => defaultInvoicingRuntime().use();

/** worker process: the provider submissions and the PDFs (canon §7.2 V2 rows). */
export function invoicingJobs(opts: { runtime?: RuntimeOption } = {}): JobHandler[] {
  const runtime = asFactory(opts.runtime);
  return [einvoiceSubmitJob(runtime), invoicePdfRenderJob(runtime)];
}
