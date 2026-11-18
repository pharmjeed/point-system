import type { ReconciliationMismatchKind } from '@point/shared';
import { PAYMENTS_RECONCILE_JOB } from '../domain/jobs.js';
import { raisePlatformAlert, resolvePlatformAlert } from '../../../core/alerts/platform-alerts.js';
import { platformAudit } from '../../../core/audit/platform-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { RetryableJobError, backoffMs, type JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import { nextCronRun } from '../../audit-monitoring/index.js';
import { retryableFailure, type GatewayPayment } from '../domain/gateway.js';
import { decideSync, localStatusOf } from '../domain/status.js';
import type { PaymentsRuntime } from '../runtime.js';
import {
  applyGatewayPayment,
  ONLINE_PAYMENT_COLUMNS,
  paymentById,
  type OnlinePaymentRow,
} from './payment-sync.js';
import { platformOrgId } from './platform-org.js';

const DAY_MS = 86_400_000;
/** Asia/Riyadh is UTC+3 all year (no daylight saving time). */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const MAX_PAGES = 500;

/** The Asia/Riyadh calendar date of an instant, `YYYY-MM-DD`. */
export function riyadhDate(at: Date): string {
  return new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** [00:00, 24:00) of a Riyadh date, as UTC instants (`to` is the last millisecond). */
export function riyadhDayWindow(date: string): { from: Date; to: Date } {
  const from = Date.parse(`${date}T00:00:00.000Z`) - RIYADH_OFFSET_MS;
  return { from: new Date(from), to: new Date(from + DAY_MS - 1) };
}

export interface ReconciliationMismatch {
  kind: ReconciliationMismatchKind;
  gateway_payment_id: string | null;
  online_payment_id: string | null;
  point_status?: string;
  gateway_status?: string;
  point_amount_halalas?: number;
  gateway_amount_halalas?: number;
  point_refunded_halalas?: number;
  gateway_refunded_halalas?: number;
  /** the platform was behind the gateway and was brought up to it (forward move of the machine) */
  synced?: boolean;
}

export interface ReconciliationResult {
  runId: string;
  status: 'matched' | 'mismatched';
  gatewayCount: number;
  localCount: number;
  matched: number;
  mismatches: ReconciliationMismatch[];
}

const netPaid = (status: string | null, amount: number, refunded: number) =>
  status === 'paid' || status === 'partially_refunded' || status === 'refunded' ? amount - refunded : 0;

/**
 * The daily reconciliation of docs/v2/04 §3 (`job.payments_reconcile`, canon §7.2 V2 row; DEC-514): every payment the
 * gateway holds for a Riyadh day has its `online_payments` row with the same amount, status and refunded amount, and
 * every row of that day is at the gateway. All network reads happen before the transaction that records the run.
 * Each difference is a mismatch of the run and a platform alert for finance (`payment_unknown` for a payment POINT
 * does not know, `payment_mismatch` otherwise); where the platform is only behind (a lost webhook), the gateway's
 * record is applied with the machine's forward moves (applyGatewayPayment) and the mismatch says `synced`.
 */
export class PaymentsReconciler {
  constructor(
    private readonly db: Database,
    private readonly rt: PaymentsRuntime,
  ) {}

  async run(date: string): Promise<ReconciliationResult> {
    const { from, to } = riyadhDayWindow(date);
    const gw = this.rt.gateway;
    const run = await this.db.transaction((tx) =>
      tx.one<{ id: string }>(
        `INSERT INTO payment_reconciliation_runs (gateway, run_date, started_at) VALUES ($1, $2, $3) RETURNING id`,
        [gw.name, date, tx.now],
      ),
    );
    try {
      // 1. the gateway's payments created that day, every page
      const remote = new Map<string, GatewayPayment>();
      for (let page = 1, n = 0; page && n < MAX_PAGES; n++) {
        const r = await gw.listPayments({ from, to, page });
        if (!r.ok) throw new GatewayReadError(r.kind, retryableFailure(r));
        for (const p of r.value.payments) remote.set(p.id, p);
        page = r.value.nextPage ?? 0;
      }
      // 2. our rows of that day, and our rows of the gateway's payments whatever their day (a boundary)
      const local = await this.db.query<OnlinePaymentRow>(
        `SELECT ${ONLINE_PAYMENT_COLUMNS} FROM online_payments p
          WHERE p.gateway = $1 AND ((p.created_at >= $2 AND p.created_at <= $3) OR p.gateway_payment_id = ANY($4::text[]))
          ORDER BY p.created_at, p.id`,
        [gw.name, from, to, [...remote.keys()]],
      );
      const byGateway = new Map(
        local.rows.filter((r) => r.gateway_payment_id).map((r) => [r.gateway_payment_id!, r]),
      );
      const byOurId = new Map(local.rows.map((r) => [r.id, r]));
      // 3. ours that the gateway's day did not list: read one by one (a different day there, or missing)
      const single = new Map<string, GatewayPayment | null>();
      for (const r of local.rows) {
        if (!r.gateway_payment_id || remote.has(r.gateway_payment_id)) continue;
        const f = await gw.fetchPayment(r.gateway_payment_id);
        if (f.ok) single.set(r.gateway_payment_id, f.value);
        else if (f.kind === 'http' && f.status === 404) single.set(r.gateway_payment_id, null);
        else throw new GatewayReadError(f.kind, retryableFailure(f));
      }
      return await this.db.transaction((tx) =>
        this.record(tx, run.id, date, remote, single, byGateway, byOurId, local.rows),
      );
    } catch (e) {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE payment_reconciliation_runs SET status = 'failed', finished_at = $2, failure_reason = $3
            WHERE id = $1 AND status = 'running'`,
          [run.id, tx.now, e instanceof GatewayReadError ? `gateway_${e.kind}` : 'internal_error'],
        );
      });
      throw e;
    }
  }

  private async record(
    tx: Tx,
    runId: string,
    date: string,
    remote: Map<string, GatewayPayment>,
    single: Map<string, GatewayPayment | null>,
    byGateway: Map<string, OnlinePaymentRow>,
    byOurId: Map<string, OnlinePaymentRow>,
    rows: OnlinePaymentRow[],
  ): Promise<ReconciliationResult> {
    const mismatches: ReconciliationMismatch[] = [];
    let matched = 0;
    let gatewayNet = 0;
    let localNet = 0;
    const seen = new Set<string>();

    const compare = async (gp: GatewayPayment, row: OnlinePaymentRow) => {
      seen.add(row.id);
      const theirs = localStatusOf(gp, row.amount_halalas);
      gatewayNet += netPaid(theirs, gp.amount, gp.refunded);
      localNet += netPaid(row.status, row.amount_halalas, row.refunded_halalas);
      const base = {
        gateway_payment_id: gp.id,
        online_payment_id: row.id,
        point_status: row.status,
        gateway_status: gp.status,
      };
      let found: ReconciliationMismatch | null = null;
      if (gp.amount !== row.amount_halalas)
        found = {
          kind: 'amount',
          ...base,
          point_amount_halalas: row.amount_halalas,
          gateway_amount_halalas: gp.amount,
        };
      else if (theirs && theirs !== row.status) found = { kind: 'status', ...base };
      else if (gp.refunded !== row.refunded_halalas)
        found = {
          kind: 'refunded',
          ...base,
          point_refunded_halalas: row.refunded_halalas,
          gateway_refunded_halalas: gp.refunded,
        };
      if (!found) return void matched++;
      const locked = (await paymentById(tx, row.id, true))!;
      if (decideSync(locked, gp).kind === 'apply') {
        await applyGatewayPayment(tx, locked, gp, { kind: 'reconcile', runId });
        found.synced = true;
      }
      mismatches.push(found);
      await raisePlatformAlert(tx, {
        type: 'payment_mismatch',
        dedupeKey: `payment_mismatch:${row.id}`,
        onlinePaymentId: row.id,
        details: { ...found, reconciliation_run_id: runId, run_date: date },
      });
    };

    for (const gp of [...remote.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const ours = gp.metadata.online_payment_id;
      const row = byGateway.get(gp.id) ?? (ours ? byOurId.get(ours) : undefined);
      if (row) {
        await compare(gp, row);
        continue;
      }
      gatewayNet += netPaid(localStatusOf(gp, gp.amount), gp.amount, gp.refunded);
      const m: ReconciliationMismatch = {
        kind: 'unknown_at_point',
        gateway_payment_id: gp.id,
        online_payment_id: null,
        gateway_status: gp.status,
        gateway_amount_halalas: gp.amount,
      };
      mismatches.push(m);
      await raisePlatformAlert(tx, {
        type: 'payment_unknown',
        dedupeKey: `payment_unknown:${gp.id}`,
        details: { ...m, reason: 'unknown_at_point', reconciliation_run_id: runId, run_date: date },
      });
    }
    for (const row of rows) {
      if (seen.has(row.id) || !row.gateway_payment_id) continue; // never reached the gateway: no money moved
      const gp = single.get(row.gateway_payment_id);
      if (gp) {
        await compare(gp, row);
        continue;
      }
      seen.add(row.id);
      localNet += netPaid(row.status, row.amount_halalas, row.refunded_halalas);
      const m: ReconciliationMismatch = {
        kind: 'missing_at_gateway',
        gateway_payment_id: row.gateway_payment_id,
        online_payment_id: row.id,
        point_status: row.status,
        point_amount_halalas: row.amount_halalas,
      };
      mismatches.push(m);
      await raisePlatformAlert(tx, {
        type: 'payment_mismatch',
        dedupeKey: `payment_mismatch:${row.id}`,
        onlinePaymentId: row.id,
        details: { ...m, reconciliation_run_id: runId, run_date: date },
      });
    }
    const status = mismatches.length ? 'mismatched' : 'matched';
    const localCount = rows.filter((r) => r.gateway_payment_id).length;
    await tx.query(
      `UPDATE payment_reconciliation_runs
          SET status = $2, finished_at = $3, gateway_count = $4, local_count = $5, matched_count = $6,
              mismatch_count = $7, gateway_paid_halalas = $8, local_paid_halalas = $9, mismatches = $10
        WHERE id = $1`,
      [
        runId,
        status,
        tx.now,
        remote.size,
        localCount,
        matched,
        mismatches.length,
        gatewayNet,
        localNet,
        JSON.stringify(mismatches),
      ],
    );
    await resolvePlatformAlert(tx, `payment_reconcile_failed:${date}`, `reconciled by run ${runId}`);
    await platformAudit(tx, {
      actor: { type: 'system', id: null, name: 'payments' },
      action: 'payments.reconcile',
      entityType: 'payment_reconciliation_run',
      entityId: runId,
      metadata: {
        run_date: date,
        status,
        gateway_count: remote.size,
        local_count: localCount,
        mismatch_count: mismatches.length,
        gateway_paid_halalas: gatewayNet,
        local_paid_halalas: localNet,
      },
    });
    return { runId, status, gatewayCount: remote.size, localCount, matched, mismatches };
  }
}

class GatewayReadError extends Error {
  constructor(
    readonly kind: string,
    readonly retryable: boolean,
  ) {
    super(`gateway read failed: ${kind}`);
  }
}

/** Schedules the next daily run after `after` (`payments_reconcile:<date>`) on the platform organization's row. */
export async function scheduleReconcile(tx: Tx, cron: string, after: Date): Promise<string | null> {
  const orgId = await platformOrgId(tx);
  if (!orgId) return null;
  const at = nextCronRun(cron, after);
  return schedule(tx, PAYMENTS_RECONCILE_JOB, at, {
    orgId,
    dedupeKey: `payments_reconcile:${at.toISOString().slice(0, 10)}`,
    payload: {},
  });
}

/** Keeps one `job.payments_reconcile` scheduled (first start, or after a dead run): none when one is pending. */
export async function ensureReconcileScheduled(tx: Tx, cron: string): Promise<string | null> {
  const pending = await tx.maybeOne(
    `SELECT 1 FROM outbox_events WHERE type = $1 AND status IN ('pending','processing') LIMIT 1`,
    [PAYMENTS_RECONCILE_JOB],
  );
  if (pending) return null;
  return scheduleReconcile(tx, cron, tx.now);
}

export interface ReconcileJobOptions {
  /** PAYMENTS_RECONCILE_CRON_UTC (DEC-514) */
  cron?: string;
}

/**
 * `job.payments_reconcile` (mode external). Payload: `run_date` (`YYYY-MM-DD`, default the Riyadh day before the
 * run) and `reschedule: false` for a manual run. A gateway that cannot be read retries with backoff; the last
 * attempt records the failure and raises `payment_reconcile_failed`, resolved by the next run that completes.
 */
export function paymentsReconcileJob(
  runtime: () => PaymentsRuntime,
  opts: ReconcileJobOptions = {},
): JobHandler {
  const cron = opts.cron ?? process.env.PAYMENTS_RECONCILE_CRON_UTC ?? '30 0 * * *';
  nextCronRun(cron, new Date(0)); // a malformed expression fails at registration
  return {
    type: PAYMENTS_RECONCILE_JOB,
    mode: 'external',
    async handle({ row, db, clock, logger }) {
      const p = (row.payload ?? {}) as { run_date?: unknown; reschedule?: unknown };
      const date =
        typeof p.run_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.run_date)
          ? p.run_date
          : riyadhDate(new Date(clock.now().getTime() - DAY_MS));
      const reschedule = p.reschedule !== false;
      try {
        const r = await new PaymentsReconciler(db, runtime()).run(date);
        logger.info(
          {
            run_date: date,
            status: r.status,
            gateway_count: r.gatewayCount,
            mismatch_count: r.mismatches.length,
          },
          'payments reconciled',
        );
      } catch (e) {
        if (!(e instanceof GatewayReadError)) throw e;
        const last = row.attempts >= row.max_attempts; // attempts already counts this one
        if (!last) throw new RetryableJobError(e.message, backoffMs(row.attempts));
        await db.transaction((tx) =>
          raisePlatformAlert(tx, {
            type: 'payment_reconcile_failed',
            dedupeKey: `payment_reconcile_failed:${date}`,
            details: { run_date: date, reason: `gateway_${e.kind}` },
          }),
        );
      }
      if (reschedule) await db.transaction((tx) => scheduleReconcile(tx, cron, clock.now()));
    },
  };
}
