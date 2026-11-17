// V2-036 (DEC-607): a development-only demo of the subscriptions annex — a fictional university venue of the seed
// operator, listed, selling the student plan (22 counted days Sunday … Thursday, 150 SAR + VAT, renewed by hand,
// non-refundable, eligibility checked, one visit a day, one freeze of 5 counted days, a capacity) with an announced
// holiday. Run after the base seed: `pnpm --filter @point/db seed:annex`. Idempotent (fixed ids, ON CONFLICT DO
// NOTHING), refused in staging and production like the base seed. Fictional names only.
import type { Pool } from 'pg';
import { assertSeedAllowed } from './index.js';
import { SEED_IDS } from './ids.js';

export const ANNEX_DEMO_IDS = {
  platformUser: '00000000-0000-4000-8000-000a00000001',
  venue: '00000000-0000-4000-8000-000a00000002',
  plan: '00000000-0000-4000-8000-000a00000003',
  closure: '00000000-0000-4000-8000-000a00000004',
} as const;

export async function seedAnnexDemo(pool: Pool, env = process.env): Promise<{ inserted: number }> {
  assertSeedAllowed(env.APP_ENV, env.NODE_ENV);
  const c = await pool.connect();
  let inserted = 0;
  const run = async (sql: string, params: unknown[]) => {
    const r = await c.query(sql, params);
    inserted += r.rowCount ?? 0;
  };
  try {
    await c.query('BEGIN');
    // a disabled platform account that only owns the demo rows: no secret, no MFA, it never signs in
    await run(
      `INSERT INTO platform_users (id, phone_e164, full_name, role, secret_hash, must_change_secret, status,
                                   disabled_at)
       VALUES ($1, '+966500000901', 'حساب البذر التجريبي', 'platform_owner', 'seed-only-no-login', true, 'disabled',
               now())
       ON CONFLICT (id) DO NOTHING`,
      [ANNEX_DEMO_IDS.platformUser],
    );
    await run(
      `INSERT INTO venues (id, org_id, code, name_ar, name_en, city)
       VALUES ($1, $2, 'UNI', 'جامعة الأفق التجريبية', 'Al Ufuq Demo University', 'الرياض')
       ON CONFLICT (id) DO NOTHING`,
      [ANNEX_DEMO_IDS.venue, SEED_IDS.org],
    );
    await run(
      `INSERT INTO venue_public_profiles (venue_id, org_id, status, category, subscriptions_enabled, approved_by,
                                          approved_at, opening_hours)
       VALUES ($1, $2, 'approved', 'other', true, $3, now(),
               '{"always_open":false,"days":{"sun":[{"open":"07:00","close":"17:00"}],"mon":[{"open":"07:00","close":"17:00"}],"tue":[{"open":"07:00","close":"17:00"}],"wed":[{"open":"07:00","close":"17:00"}],"thu":[{"open":"07:00","close":"17:00"}]}}')
       ON CONFLICT (venue_id) DO NOTHING`,
      [ANNEX_DEMO_IDS.venue, SEED_IDS.org, ANNEX_DEMO_IDS.platformUser],
    );
    await run(
      `INSERT INTO subscription_plans (id, org_id, venue_id, name_ar, vehicles_included, monthly_price_halalas,
                                       created_by, term_kind, service_days, service_weekdays_mask, renewal_mode,
                                       daily_visit_limit, refund_policy, closure_policy, freeze_max_times,
                                       freeze_max_days, eligibility, capacity, audience_ar, vehicle_change)
       VALUES ($1, $2, $3, 'باقة الطالب الشهرية', 1, 17250, $4, 'service_days', 22, 31, 'manual', 1,
               'non_refundable', 'continue', 1, 5, 'student_id_review', 300, 'طلاب وطالبات الجامعة التجريبية',
               'any_time')
       ON CONFLICT (id) DO NOTHING`,
      [ANNEX_DEMO_IDS.plan, SEED_IDS.org, ANNEX_DEMO_IDS.venue, ANNEX_DEMO_IDS.platformUser],
    );
    await run(
      `INSERT INTO venue_closures (id, org_id, venue_id, kind, starts_on, ends_on, reason_ar, created_by)
       VALUES ($1, $2, $3, 'holiday', (now() AT TIME ZONE 'Asia/Riyadh')::date + 30,
               (now() AT TIME ZONE 'Asia/Riyadh')::date + 37, 'إجازة تجريبية', $4)
       ON CONFLICT (id) DO NOTHING`,
      [ANNEX_DEMO_IDS.closure, SEED_IDS.org, ANNEX_DEMO_IDS.venue, ANNEX_DEMO_IDS.platformUser],
    );
    await c.query('COMMIT');
    return { inserted };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
