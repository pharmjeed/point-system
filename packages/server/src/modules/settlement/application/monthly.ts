import type { PlatformActorContext } from '../../../core/actor-context/platform-actor.js';
import type { Clock } from '../../../core/clock/clock.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { schedule } from '../../../core/outbox/outbox-writer.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { platformOrgId } from '../../payments-online/index.js';
import { monthBounds, previousMonth } from '../domain/compute.js';
import { generateForOrg, settledOrganizations, statementView, type GenerateOutcome } from './statements.js';

export const SETTLEMENT_MONTHLY_JOB = 'job.settlement_monthly';

/**
 * The next run of a monthly cron in UTC, `M H D * *` (one minute, hour and day of the month 1–28, so every month has
 * it): the first such instant strictly after `after`.
 */
export function nextMonthlyRun(cron: string, after: Date): Date {
  const parts = cron.trim().split(/\s+/);
  const [m, h, d, month, dow] = parts;
  const num = (v: string | undefined, lo: number, hi: number) => {
    const n = /^[0-9]{1,2}$/.test(v ?? '') ? Number(v) : NaN;
    if (!(n >= lo && n <= hi)) throw new Error(`job.settlement_monthly runs monthly: "M H D * *" (${cron})`);
    return n;
  };
  if (parts.length !== 5 || month !== '*' || dow !== '*')
    throw new Error(`job.settlement_monthly runs monthly: "M H D * *" (${cron})`);
  const minute = num(m, 0, 59);
  const hour = num(h, 0, 23);
  const day = num(d, 1, 28);
  let y = after.getUTCFullYear();
  let mo = after.getUTCMonth();
  for (;;) {
    const at = new Date(Date.UTC(y, mo, day, hour, minute));
    if (at.getTime() > after.getTime()) return at;
    mo += 1;
    if (mo === 12) {
      mo = 0;
      y += 1;
    }
  }
}
const RIYADH_MS = 3 * 3_600_000;
const riyadhDay = (at: Date) => new Date(at.getTime() + RIYADH_MS).toISOString().slice(0, 10);

/** A month can be settled once it has ended in Riyadh (its exclusive end is today or earlier). */
export function assertClosedMonth(period: string, now: Date): void {
  if (monthBounds(period).end > riyadhDay(now))
    throw new AppError('VALIDATION_FAILED', { fields: [{ field: 'period', issue: 'not_closed' }] });
}

const outcomeView = (o: GenerateOutcome) =>
  o.outcome === 'skipped'
    ? o
    : { org_id: o.org_id, outcome: o.outcome, statement: statementView(o.statement) };

/**
 * `POST /v1/platform/settlements/generate` (P-09): the drafts of a closed month for one operator or every operator,
 * in the command's transaction — the work of `job.settlement_monthly` on demand (a rerun recomputes drafts only).
 */
export async function generateCommand(
  tx: Tx,
  actor: PlatformActorContext,
  body: { period: string; org_id?: string | undefined },
  vatRateBp: number,
  client: ClientInfo,
) {
  assertClosedMonth(body.period, tx.now);
  let orgs: string[];
  if (body.org_id) {
    const org = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM organizations WHERE id = $1 AND is_platform_operated = false`,
      [body.org_id],
    );
    if (!org) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'operator' });
    orgs = [org.id];
  } else orgs = await settledOrganizations(tx);
  const results: GenerateOutcome[] = [];
  for (const orgId of orgs)
    results.push(
      await generateForOrg(
        tx,
        orgId,
        body.period,
        vatRateBp,
        { type: 'platform_user', id: actor.userId, role: actor.role },
        client.requestId,
      ),
    );
  return { period: body.period, results: results.map(outcomeView) };
}

export async function scheduleSettlement(tx: Tx, cron: string, after: Date): Promise<string | null> {
  const orgId = await platformOrgId(tx);
  if (!orgId) return null;
  const at = nextMonthlyRun(cron, after);
  return schedule(tx, SETTLEMENT_MONTHLY_JOB, at, {
    orgId,
    dedupeKey: `settlement_monthly:${at.toISOString().slice(0, 10)}`,
    payload: {},
  });
}

/** Keeps one `job.settlement_monthly` scheduled (first start, or after a dead run). */
export async function ensureSettlementScheduled(tx: Tx, cron: string): Promise<string | null> {
  const pending = await tx.maybeOne(
    `SELECT 1 FROM outbox_events WHERE type = $1 AND status IN ('pending','processing') LIMIT 1`,
    [SETTLEMENT_MONTHLY_JOB],
  );
  if (pending) return null;
  return scheduleSettlement(tx, cron, tx.now);
}

/**
 * `job.settlement_monthly` (canon §7.2 V2 row; DEC-544): on the 1st of the Riyadh month (SETTLEMENT_MONTHLY_CRON_UTC)
 * the drafts of the month before, one transaction per operator (an operator's failure does not stop the others; the
 * job retries). Payload: `period` (`YYYY-MM`, default the previous Riyadh month) and `reschedule: false` for a manual
 * run. A rerun recomputes drafts and leaves issued statements alone.
 */
export function settlementMonthlyJob(opts: { cron?: string; vatRateBp?: () => number } = {}): JobHandler {
  const cron = opts.cron ?? process.env.SETTLEMENT_MONTHLY_CRON_UTC ?? '15 0 1 * *';
  nextMonthlyRun(cron, new Date(0)); // a malformed expression fails at registration
  const vat = opts.vatRateBp ?? (() => Number(process.env.VAT_RATE_BP ?? 1500));
  return {
    type: SETTLEMENT_MONTHLY_JOB,
    mode: 'external',
    async handle({ row, db, clock, logger }) {
      const p = (row.payload ?? {}) as { period?: unknown; reschedule?: unknown };
      const period =
        typeof p.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p.period)
          ? p.period
          : previousMonth(riyadhDay(clock.now()));
      const r = await runMonthly(db, clock, period, vat());
      logger.info({ period, ...r }, 'settlement drafts computed');
      if (p.reschedule !== false) await db.transaction((tx) => scheduleSettlement(tx, cron, clock.now()));
    },
  };
}

export async function runMonthly(db: Database, clock: Clock, period: string, vatRateBp: number) {
  assertClosedMonth(period, clock.now());
  const orgs = await settledOrganizations(db);
  let created = 0;
  let recomputed = 0;
  let skipped = 0;
  for (const orgId of orgs) {
    const o = await db.transaction((tx) =>
      generateForOrg(tx, orgId, period, vatRateBp, { type: 'system', id: null, name: 'settlement' }),
    );
    if (o.outcome === 'created') created++;
    else if (o.outcome === 'recomputed') recomputed++;
    else skipped++;
  }
  return { operators: orgs.length, created, recomputed, skipped };
}
