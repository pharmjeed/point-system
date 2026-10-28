// payments-reports public surface (04 §4.2 item 8): collection, waiver and reversal, cash handovers, the event
// settlement and reconciliation, reports and audited exports (PNT-080 … PNT-082, PNT-087 … PNT-089).
// Imports tickets-custody, venues-events, media and core only (04 §4.3); never dispatch or the use-cases.

export { PaymentsReportsHttpModule } from './http/payments-reports.module.js';

// collection rules (13 §5) and display helpers
export {
  normalizePosReference,
  posReferenceIssues,
  assertPaymentShape,
  assertPaymentMatches,
  paymentStatusBlocker,
  formatSar,
  formatSarAr,
  formatRiyadh,
  POS_REFERENCE_RE,
  CARD_NUMBER_RE,
  type PaymentInput,
} from './domain/payment-rules.js';

// commands (the use-cases reuse the collection inside the handover, the exception and the manual reconcile)
export {
  PaymentsService,
  assertCollectable,
  recordCollection,
  recordedPaymentOf,
  alreadyRecorded,
  assertEventAcceptsMoney,
  loadEventRow as loadMoneyEventRow,
  type PaymentSource,
  type RecordCollectionArgs,
} from './application/payments.js';
export { CashHandoversService, type CashHandoverBody } from './application/cash-handovers.js';
export { openPaymentDiscrepancyIncident, type OpenIncidentArgs } from './application/incidents.js';

// reads
export {
  computeSettlement,
  financeSummary,
  integrityViolations,
  type Settlement,
  type IntegrityViolation,
} from './application/settlement.js';
export { computeReconciliation, closeSummary, type Reconciliation } from './application/reconciliation.js';
export {
  findEventInScope,
  recheckStaffScope,
  EVENT_SELECT as MONEY_EVENT_SELECT,
  type EventRow as MoneyEventRow,
} from './application/scope.js';
export { ReportsService, eventSummaryReport } from './application/reports.js';
export { paymentView, loadPaymentViews, type PaymentRow } from './application/views.js';

// exports (PNT-089)
export { ExportsService, EXPORT_FILE_TTL_MS, EXPORT_JOB } from './application/exports.js';
export { EXPORT_MAX_ROWS, buildExport, type ExportFilters } from './application/export-data.js';
export {
  EXPORTS_STORAGE,
  createExportsStorage,
  registerExportsStorage,
  exportStorageKey,
  EXPORT_CONTENT_TYPE,
} from './infra/exports-storage.js';
export { toCsv, csvCell, BOM as CSV_BOM, type CsvColumn } from './infra/csv.js';

// worker
export { paymentsReportsJobs, paymentsReportsWorkerService } from './jobs/index.js';
export { exportGenerateHandler } from './jobs/export-generate.js';
