import type { PlatformInvoicesQuery } from '@point/shared';
import {
  maskPhone,
  type CustomerInvoiceDetail,
  type CustomerInvoiceList,
  type CustomerInvoiceSummary,
} from '@point/shared/customer';
import type { Clock } from '../../../core/clock/clock.js';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import { AppError } from '../../../core/errors/app-error.js';
import { readUrlTtlSeconds, type ObjectStorage } from '../../media/index.js';
import { ListCursorCodec, pageOf } from '../../venues-events/index.js';
import { INVOICE_SELECT, type InvoiceRow } from './issue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
const US = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DAY_START = (p: string) => `(${p}::date::timestamp AT TIME ZONE 'Asia/Riyadh')`;

export const invoiceNotFound = () => new AppError('RESOURCE_NOT_FOUND', { resource: 'invoice' });

export interface PdfLink {
  pdf_url: string | null;
  pdf_url_expires_at: string | null;
}

/** A private link of a few minutes to the PDF (presigning is local math), or nulls while it is being rendered. */
export async function pdfLink(
  storage: ObjectStorage,
  env: Env,
  now: Date,
  r: Pick<InvoiceRow, 'pdf_storage_key' | 'number'>,
): Promise<PdfLink> {
  if (!r.pdf_storage_key) return { pdf_url: null, pdf_url_expires_at: null };
  const signed = await storage.presignDownload(r.pdf_storage_key, {
    expiresInS: readUrlTtlSeconds(env.MEDIA_READ_URL_TTL_S),
    now,
    contentType: 'application/pdf',
    cacheControl: 'private, no-store',
  });
  return { pdf_url: signed.url, pdf_url_expires_at: signed.expiresAt.toISOString() };
}

/** An invoice for the platform (P-10) and the operator (O-06): the stored document, never a customer's phone. */
export function invoiceView(r: InvoiceRow) {
  return {
    id: r.id,
    number: r.number,
    series: r.series,
    kind: r.kind,
    type_code: r.type_code,
    icv: r.icv,
    uuid: r.zatca_uuid,
    issued_at: iso(r.issued_at)!,
    supply_date: r.supply_date,
    period_start: r.period_start,
    period_end: r.period_end,
    currency: r.currency,
    vat_rate_bp: r.vat_rate_bp,
    subtotal_halalas: r.subtotal_halalas,
    vat_halalas: r.vat_halalas,
    total_halalas: r.total_halalas,
    seller: r.seller,
    buyer: r.buyer,
    lines: r.lines,
    original: r.original_invoice_id ? { id: r.original_invoice_id, number: r.original_number } : null,
    credit_reason: r.credit_reason,
    online_payment_id: r.online_payment_id,
    refund_id: r.refund_id,
    settlement_statement_id: r.settlement_statement_id,
    previous_hash: r.previous_hash,
    invoice_hash: r.invoice_hash,
    qr: r.provider_qr ?? r.qr_payload,
    provider: r.provider,
    status: r.zatca_status,
    provider_reference: r.provider_reference,
    provider_codes: r.provider_codes ?? [],
    submitted_at: iso(r.submitted_at),
    status_at: iso(r.status_at),
    pdf_ready: !!r.pdf_storage_key,
  };
}

function customerSummary(r: InvoiceRow): CustomerInvoiceSummary {
  return {
    id: r.id,
    number: r.number,
    kind: r.kind === 'credit_note' ? 'credit_note' : 'customer_simplified',
    issued_at: iso(r.issued_at)!,
    total_halalas: r.total_halalas,
    vat_halalas: r.vat_halalas,
    currency: 'SAR',
    status: r.zatca_status,
    venue_name_ar: r.buyer?.venue_name_ar ?? null,
    venue_name_en: r.buyer?.venue_name_en ?? null,
    original_number: r.original_number,
  };
}

/** C-17: the account's documents (the simplified series only), newest first. */
export async function customerInvoices(db: Database, accountId: string): Promise<CustomerInvoiceList> {
  const rows = await db.rows<InvoiceRow>(
    `${INVOICE_SELECT} WHERE i.account_id = $1 AND i.series = 'simplified' ORDER BY i.issued_at DESC, i.icv DESC
      LIMIT 100`,
    [accountId],
  );
  return { items: rows.map(customerSummary) };
}

/** C-17 detail: the account's own document only (else RESOURCE_NOT_FOUND, as for an id that does not exist). */
export async function customerInvoice(
  db: Database,
  storage: ObjectStorage,
  env: Env,
  clock: Clock,
  accountId: string,
  invoiceId: string,
): Promise<CustomerInvoiceDetail> {
  const r = UUID.test(invoiceId)
    ? (
        await db.rows<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1 AND i.account_id = $2`, [
          invoiceId,
          accountId,
        ])
      )[0]
    : undefined;
  if (!r || r.series !== 'simplified') throw invoiceNotFound();
  return {
    ...customerSummary(r),
    type_code: r.type_code,
    uuid: r.zatca_uuid,
    subtotal_halalas: r.subtotal_halalas,
    vat_rate_bp: r.vat_rate_bp,
    seller: r.seller,
    lines: r.lines,
    credit_reason: r.credit_reason,
    online_payment_id: r.online_payment_id,
    qr: r.provider_qr ?? r.qr_payload,
    ...(await pdfLink(storage, env, clock.now(), r)),
  };
}

/**
 * An invoice as its operator sees it (O-06): the document without the chain's internals (the counter and hashes
 * belong to POINT's whole series, across operators).
 */
function operatorInvoiceView(r: InvoiceRow) {
  const { icv: _icv, previous_hash: _prev, invoice_hash: _hash, ...view } = invoiceView(r);
  return view;
}

/** O-06: the operator's own documents (the standard series bought by its organization), newest first. */
export async function operatorInvoices(db: Database, orgId: string) {
  const rows = await db.rows<InvoiceRow>(
    `${INVOICE_SELECT} WHERE i.org_id = $1 AND i.series = 'standard' ORDER BY i.issued_at DESC, i.icv DESC LIMIT 120`,
    [orgId],
  );
  return rows.map(operatorInvoiceView);
}

export async function operatorInvoice(
  db: Database,
  storage: ObjectStorage,
  env: Env,
  clock: Clock,
  orgId: string,
  invoiceId: string,
) {
  const r = UUID.test(invoiceId)
    ? (
        await db.rows<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [invoiceId, orgId])
      )[0]
    : undefined;
  if (!r || r.series !== 'standard') throw invoiceNotFound();
  return { ...operatorInvoiceView(r), ...(await pdfLink(storage, env, clock.now(), r)) };
}

/**
 * P-10 «الفواتير» (`platform.invoice_read`: finance and the owner): every document of both series with the
 * provider's status and the PDF. A customer appears as a masked phone only (V2-D12).
 */
export class PlatformInvoicesConsole {
  constructor(
    private readonly db: Database,
    private readonly cursors: ListCursorCodec,
    private readonly storage: ObjectStorage,
    private readonly env: Env,
    private readonly clock: Clock,
  ) {}

  async list(q: PlatformInvoicesQuery) {
    if (q.from && q.to && q.from > q.to)
      throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'to', issue: 'before_from' }] });
    const scope = [
      'platform-invoices',
      q.kind,
      q.series,
      q.status,
      q.org_id,
      q.account_id,
      q.number,
      q.from,
      q.to,
    ].join('|');
    const after = q.cursor ? this.cursors.decode(q.cursor, scope, 2) : null;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (cond: (n: string) => string, value: unknown) => {
      params.push(value);
      where.push(cond(`$${params.length}`));
    };
    if (q.kind) add((n) => `i.kind = ${n}`, q.kind);
    if (q.series) add((n) => `i.series = ${n}`, q.series);
    if (q.status) add((n) => `i.zatca_status = ${n}`, q.status);
    if (q.org_id) add((n) => `i.org_id = ${n}::uuid`, q.org_id);
    if (q.account_id) add((n) => `i.account_id = ${n}::uuid`, q.account_id);
    if (q.number) add((n) => `i.number = ${n}`, q.number);
    if (q.from) add((n) => `i.issued_at >= ${DAY_START(n)}`, q.from);
    if (q.to) add((n) => `i.issued_at < ${DAY_START(`(${n}::date + 1)`)}`, q.to);
    if (after) {
      params.push(after[0], after[1]);
      where.push(`(i.issued_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    // the platform reads every document (POINT is the seller of all of them); org_id is an optional filter
    const rows = await this.db.rows<
      InvoiceRow & { issued_at_us: string; org_name_ar: string | null; account_phone: string | null }
    >(
      `SELECT x.*, org.name_ar AS org_name_ar, acc.phone_e164 AS account_phone
         FROM (${INVOICE_SELECT.replace('i.created_at,', `i.created_at, ${US('i.issued_at')} AS issued_at_us,`)}
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY i.issued_at DESC, i.id DESC LIMIT $${params.length}) x
         LEFT JOIN organizations org ON org.id = x.org_id
         LEFT JOIN customer_accounts acc ON acc.id = x.account_id
        ORDER BY x.issued_at DESC, x.id DESC`,
      params,
    );
    return pageOf(
      rows,
      q.limit,
      (r) => ({
        id: r.id,
        number: r.number,
        series: r.series,
        kind: r.kind,
        issued_at: iso(r.issued_at)!,
        total_halalas: r.total_halalas,
        vat_halalas: r.vat_halalas,
        status: r.zatca_status,
        provider: r.provider,
        original_number: r.original_number,
        org: r.org_id ? { id: r.org_id, name_ar: r.org_name_ar } : null,
        account: r.account_id
          ? { id: r.account_id, phone_masked: r.account_phone ? maskPhone(r.account_phone) : null }
          : null,
        pdf_ready: !!r.pdf_storage_key,
      }),
      (r) => this.cursors.encode(scope, [r.issued_at_us, r.id]),
    );
  }

  async detail(invoiceId: string) {
    const r = UUID.test(invoiceId)
      ? (await this.db.rows<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [invoiceId]))[0]
      : undefined;
    if (!r) throw invoiceNotFound();
    const events = await this.db.rows<{
      id: number;
      kind: string;
      outcome: string;
      zatca_status: string | null;
      codes: unknown;
      occurred_at: Date;
    }>(
      `SELECT id::float8 AS id, kind, outcome, zatca_status, codes, occurred_at FROM invoice_provider_events
        WHERE invoice_id = $1 ORDER BY occurred_at, id`,
      [r.id],
    );
    const credits = await this.db.rows<{
      id: string;
      number: string;
      total_halalas: number;
      issued_at: Date;
    }>(
      `SELECT id, number, total_halalas::float8 AS total_halalas, issued_at FROM invoices
        WHERE original_invoice_id = $1 ORDER BY icv`,
      [r.id],
    );
    const account = r.account_id
      ? await this.db.rows<{ phone_e164: string | null }>(
          `SELECT phone_e164 FROM customer_accounts WHERE id = $1`,
          [r.account_id],
        )
      : [];
    return {
      ...invoiceView(r),
      account: r.account_id
        ? { id: r.account_id, phone_masked: account[0]?.phone_e164 ? maskPhone(account[0].phone_e164) : null }
        : null,
      provider_events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        outcome: e.outcome,
        status: e.zatca_status,
        codes: e.codes ?? [],
        occurred_at: iso(e.occurred_at)!,
      })),
      credit_notes: credits.map((c) => ({
        id: c.id,
        number: c.number,
        total_halalas: c.total_halalas,
        issued_at: iso(c.issued_at)!,
      })),
      ...(await pdfLink(this.storage, this.env, this.clock.now(), r)),
    };
  }
}
