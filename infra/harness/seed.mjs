// The harness seed (PNT-097 load profile 17 H-08, PNT-098 chaos runs). It is NOT a production path:
//  - it only writes to a database named point_load* / point_chaos* (assertHarnessDb),
//  - it starts from the development seed (packages/db seed: refuses staging/production and a live channel),
//  - it adds venues, drivers and supervisors with direct SQL, like the dev seed, for the load shape:
//    5 venues (RMS, LYL and three load halls), 10 drivers on each, one supervisor socket per venue.
// Profile choices (documented in infra/load/README.md): supervisors without MFA (org setting) so their sockets
// can be opened by the generator, and no mandatory inspection photo (the photo upload is a direct-to-S3 path
// that the load profile does not measure; MinIO is not part of the run).
import { randomUUID } from 'node:crypto';
import { argon2, importDist, pg } from './deps.mjs';
import { assertHarnessDb } from './db.mjs';

export const DRIVER_PIN = '583920';
export const SUPERVISOR_PASSWORD = 'harness-supervisor-2026';

/**
 * @param {string} url database URL (point_load* / point_chaos*)
 * @param {{ venues?: number, driversPerVenue?: number, env: Record<string,string>, spotsPerVenue?: number,
 *           slotsPerVenue?: number }} o
 *   `env` = the server environment of the run (keys, pepper, brand); every venue gets at least `spotsPerVenue`
 *   parking spots (40) and `slotsPerVenue` key slots (60)
 */
export async function seedWorld(url, o) {
  assertHarnessDb(new URL(url).pathname.slice(1));
  const venues = Math.max(2, o.venues ?? 5);
  const perVenue = Math.max(1, o.driversPerVenue ?? 10);
  const spotsPerVenue = Math.max(30, o.spotsPerVenue ?? 40);
  const slotsPerVenue = Math.max(30, o.slotsPerVenue ?? 60);
  const devSeed = await importDist('packages/db/dist/seed/index.js');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await devSeed.seed(pool, {
      env: 'harness',
      nodeEnv: 'development',
      dataEncryptionKey: o.env.DATA_ENCRYPTION_KEY,
      dataEncryptionKeyId: o.env.DATA_ENCRYPTION_KEY_ID,
      secretPepper: o.env.AUTH_SECRET_PEPPER,
      customerBrandNameAr: o.env.BRAND_CUSTOMER_NAME_AR,
    });
    const hashOptions = {
      ...devSeed.SEED_ARGON2_OPTIONS,
      secret: Buffer.from(o.env.AUTH_SECRET_PEPPER, 'utf8'),
    };
    const pinHash = await argon2.hash(DRIVER_PIN, hashOptions);
    const passwordHash = await argon2.hash(SUPERVISOR_PASSWORD, hashOptions);
    const ids = devSeed.SEED_IDS;
    const org = ids.org;
    const admin = ids.users.ADM1;
    const owner = ids.users.OWN1;
    const c = await pool.connect();
    let venueRows = [];
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{security}',
           coalesce(settings->'security', '{}'::jsonb) || '{"supervisor_mfa_required": false}'::jsonb) WHERE id = $1`,
        [org],
      );
      const noPhotos = `jsonb_set(coalesce(settings, '{}'::jsonb), '{inspection}',
           coalesce(settings->'inspection', '{}'::jsonb) || '{"required_photos": []}'::jsonb)`;
      await c.query(`UPDATE venues SET settings = ${noPhotos} WHERE org_id = $1`, [org]);

      // every venue gets `spotsPerVenue` spots (one zone more where the dev seed has fewer)
      const spotCount = async (venueId) =>
        Number(
          (await c.query(`SELECT count(*)::int AS n FROM parking_spots WHERE venue_id = $1`, [venueId]))
            .rows[0].n,
        );
      const addZone = async (venueId, name, sortOrder, count) => {
        const z = await c.query(
          `INSERT INTO parking_zones (org_id, venue_id, name, sort_order, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
          [org, venueId, name, sortOrder],
        );
        for (let i = 1; i <= count; i++)
          await c.query(
            `INSERT INTO parking_spots (org_id, venue_id, zone_id, label, status) VALUES ($1, $2, $3, $4, 'active')`,
            [org, venueId, z.rows[0].id, `${name}-${String(i).padStart(2, '0')}`],
          );
      };
      const addSlots = async (venueId, count) => {
        const b = await c.query(
          `INSERT INTO key_boards (org_id, venue_id, name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
          [org, venueId, `لوحة الحمل`],
        );
        for (let i = 1; i <= count; i++)
          await c.query(
            `INSERT INTO key_slots (org_id, venue_id, key_board_id, label, status) VALUES ($1, $2, $3, $4, 'active')`,
            [org, venueId, b.rows[0].id, `H${i}`],
          );
      };

      venueRows = [
        { id: ids.venues.RMS, code: 'RMS', poolId: ids.pools['POOL-R'], supervisor: ids.users['SUP-RL'] },
        { id: ids.venues.LYL, code: 'LYL', poolId: ids.pools['POOL-L'], supervisor: ids.users['SUP-RL'] },
      ];
      for (let k = 3; k <= venues; k++) {
        const code = `LD${k}`;
        const v = await c.query(
          `INSERT INTO venues (org_id, code, name_ar, name_en, timezone, status, settings)
           VALUES ($1, $2, $3, $4, 'Asia/Riyadh', 'active', '{"inspection": {"required_photos": []}}'::jsonb) RETURNING id`,
          [org, code, `قاعة الحمل ${k}`, `Load hall ${k}`],
        );
        const venueId = v.rows[0].id;
        const p = await c.query(
          `INSERT INTO dispatch_pools (org_id, venue_id, name, is_default, status) VALUES ($1, $2, 'الافتراضية', true, 'active') RETURNING id`,
          [org, venueId],
        );
        const poolId = p.rows[0].id;
        await c.query(
          `INSERT INTO events (org_id, venue_id, dispatch_pool_id, name_ar, event_date, starts_at, status, pricing_mode,
                  fee_halalas, allowed_payment_methods, next_display_number, opened_at, opened_by, created_by)
           VALUES ($1, $2, $3, $4, (now() AT TIME ZONE 'Asia/Riyadh')::date, now(), 'open', 'included', 0,
                   ARRAY['cash','pos']::text[], 1, now(), $5, $5)`,
          [org, venueId, poolId, `حفل الحمل ${k}`, admin],
        );
        await c.query(
          `INSERT INTO shifts (org_id, venue_id, dispatch_pool_id, name, starts_at, status, opened_at, opened_by, created_by)
           VALUES ($1, $2, $3, $4, now(), 'open', now(), $5, $5)`,
          [org, venueId, poolId, `وردية الحمل ${k}`, admin],
        );
        // one supervisor per load hall (venue scope, no driving)
        const s = await c.query(
          `INSERT INTO users (org_id, employee_code, full_name, phone_e164, role, can_drive, status, secret_kind,
                  secret_hash, must_change_secret, mfa_enabled, created_by)
           VALUES ($1, $2, $3, $4, 'supervisor', false, 'active', 'password', $5, false, false, $6) RETURNING id`,
          [
            org,
            `HS-${k}`,
            `مشرف الحمل ${k}`,
            `+9665012000${String(k).padStart(2, '0')}`,
            passwordHash,
            owner,
          ],
        );
        await c.query(
          `INSERT INTO role_scopes (org_id, user_id, scope_type, venue_id, granted_by, granted_at)
           VALUES ($1, $2, 'venue', $3, $4, now())`,
          [org, s.rows[0].id, venueId, owner],
        );
        venueRows.push({ id: venueId, code, poolId, supervisor: s.rows[0].id });
      }
      for (const v of venueRows) {
        const have = await spotCount(v.id);
        if (have < spotsPerVenue)
          await addZone(v.id, `H${venueRows.indexOf(v) + 1}`, 9, spotsPerVenue - have);
        const slots = Number(
          (
            await c.query(
              `SELECT count(*)::int AS n FROM key_slots WHERE venue_id = $1 AND status = 'active'`,
              [v.id],
            )
          ).rows[0].n,
        );
        if (slots < slotsPerVenue) await addSlots(v.id, slotsPerVenue - slots);
      }

      // drivers: up to `perVenue` with an active assignment in each venue
      let n = 0;
      for (const v of venueRows) {
        const have = Number(
          (
            await c.query(
              `SELECT count(*)::int AS n FROM driver_assignments WHERE venue_id = $1 AND status = 'active'`,
              [v.id],
            )
          ).rows[0].n,
        );
        for (let i = have; i < perVenue; i++) {
          n++;
          const u = await c.query(
            `INSERT INTO users (org_id, employee_code, full_name, phone_e164, role, can_drive, status, secret_kind,
                    secret_hash, must_change_secret, mfa_enabled, created_by)
             VALUES ($1, $2, $3, $4, 'driver', false, 'active', 'pin', $5, false, false, $6) RETURNING id`,
            [
              org,
              `HD-${String(n).padStart(4, '0')}`,
              `سائق الحمل ${n}`,
              `+96650110${String(n).padStart(4, '0')}`,
              pinHash,
              owner,
            ],
          );
          await c.query(
            `INSERT INTO driver_assignments (org_id, driver_id, venue_id, status, starts_at, created_by)
             VALUES ($1, $2, $3, 'active', now(), $4)`,
            [org, u.rows[0].id, v.id, admin],
          );
        }
      }
      // the seeded drivers (DRV1–DRV8) sign in with the harness PIN too
      await c.query(`UPDATE users SET secret_hash = $2 WHERE org_id = $1 AND role = 'driver'`, [
        org,
        pinHash,
      ]);
      await c.query(`UPDATE users SET secret_hash = $2 WHERE id = $1`, [ids.users['SUP-RL'], passwordHash]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    return await describeWorld(pool, devSeed, venueRows);
  } finally {
    await pool.end();
  }
}

/** Everything the generator needs to act through the API: venues, events, spots, slots, people. */
async function describeWorld(pool, devSeed, venueRows) {
  const ids = devSeed.SEED_IDS;
  const owner = devSeed.SEED_CREDENTIALS.OWN1;
  const world = {
    org: ids.org,
    owner: { phone: owner.phone, secret: owner.secret, totpSecret: owner.totpSecret },
    venues: [],
  };
  for (const v of venueRows) {
    const q = (sql) => pool.query(sql, [v.id]).then((r) => r.rows);
    const events = await q(
      `SELECT id, pricing_mode, fee_halalas FROM events WHERE venue_id = $1 AND status = 'open' ORDER BY name_ar`,
    );
    const spots = (
      await q(`SELECT id FROM parking_spots WHERE venue_id = $1 AND status = 'active' ORDER BY label`)
    ).map((r) => r.id);
    const slots = (
      await q(
        `SELECT s.id FROM key_slots s JOIN key_boards b ON b.id = s.key_board_id
          WHERE s.venue_id = $1 AND s.status = 'active' AND b.status = 'active' ORDER BY b.name, s.label`,
      )
    ).map((r) => r.id);
    const drivers = (
      await q(
        `SELECT u.id, u.phone_e164 AS phone FROM driver_assignments a JOIN users u ON u.id = a.driver_id
          WHERE a.venue_id = $1 AND a.status = 'active' ORDER BY u.employee_code`,
      )
    ).map((d) => ({ ...d, pin: DRIVER_PIN }));
    const sup = (await pool.query(`SELECT id, phone_e164 AS phone FROM users WHERE id = $1`, [v.supervisor]))
      .rows[0];
    world.venues.push({
      id: v.id,
      code: v.code,
      poolId: v.poolId,
      events,
      spots,
      slots,
      drivers,
      supervisor: { ...sup, password: SUPERVISOR_PASSWORD },
    });
  }
  return world;
}

/** A stable random id for one run's artefacts. */
export const runId = () => randomUUID().slice(0, 8);
