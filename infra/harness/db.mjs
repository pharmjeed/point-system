// Databases of a harness run: a fresh database per run (point_load_* / point_chaos_*, never the shared ones),
// migrated with the production migrator, and the consistency checks run after the run (17 H-08 «بعد التشغيل»).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, distPath, pg } from './deps.mjs';
import { baseEnv } from './env.mjs';

/** Server on which the run may CREATE DATABASE (the local PostgreSQL 16). */
export const ADMIN_URL =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres';

const NAME_RE = /^point_(load|chaos)[a-z0-9_]*$/;

/** Only databases named point_load* / point_chaos* are ever created, cut or dropped by the harness. */
export function assertHarnessDb(name) {
  if (!NAME_RE.test(name))
    throw new Error(`refusing to touch database ${name}: not a point_load*/point_chaos* database`);
}

export function dbUrl(name, admin = ADMIN_URL) {
  assertHarnessDb(name);
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function withAdmin(fn, admin = ADMIN_URL) {
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createDb(name) {
  assertHarnessDb(name);
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  });
  return dbUrl(name);
}

export async function dropDb(name) {
  assertHarnessDb(name);
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

/** Applies the migrations with the production migrator (`node packages/db/dist/cli.js migrate`). */
export async function migrateDb(url) {
  const out = await run(process.execPath, [distPath('packages/db/dist/cli.js'), 'migrate'], {
    DATABASE_URL: url,
  });
  if (out.code !== 0) throw new Error(`migrate failed:\n${out.text}`);
  return out.text.trim();
}

/** The schema invariants script (docs/06_schema_invariants_test.sql) through `pnpm db:invariants`. */
export async function schemaInvariants() {
  const out = await run('pnpm', ['--silent', 'db:invariants'], {
    ADMIN_DATABASE_URL: ADMIN_URL,
    TEST_DATABASE_URL: ADMIN_URL,
  });
  return {
    passed: out.code === 0 && /ALL INVARIANT TESTS PASSED/.test(out.text),
    tail: out.text.trim().split('\n').slice(-3),
  };
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...baseEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('exit', (code) => resolve({ code, text }));
  });
}

/** 10 §14.1 (I-A … I-F) and 11 §1.7: each query returns the violating rows (none on a healthy database). */
export const DISPATCH_INVARIANTS = {
  'I-A available ⟺ available_since': `SELECT s.user_id FROM v_driver_state s
     WHERE s.duty_status = 'on_duty' AND ((s.driver_state = 'available') <> (s.available_since IS NOT NULL))`,
  'I-B task status ⟺ live round': `SELECT t.id FROM tasks t LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
     WHERE t.type = 'retrieve' AND ((t.status = 'offered' AND (o.id IS NULL OR o.mode <> 'single'))
        OR (t.status = 'broadcast' AND (o.id IS NULL OR o.mode <> 'broadcast'))
        OR (t.status NOT IN ('offered','broadcast') AND o.id IS NOT NULL))`,
  'I-C ticket mirrors its retrieve task': `SELECT k.id FROM tickets k JOIN tasks t ON t.ticket_id = k.id AND t.type = 'retrieve' AND t.status NOT IN ('completed','canceled')
     WHERE NOT ((k.status = 'requested' AND t.status IN ('queued','offered','broadcast'))
             OR (k.status = 'assigned' AND t.status = 'accepted')
             OR (k.status = 'assigned_waiting' AND t.status = 'assigned_waiting')
             OR (k.status IN ('retrieving','ready') AND t.status = 'in_progress'))`,
  'I-D live single offers only for available drivers': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     JOIN v_driver_state s ON s.user_id = r.user_id
     WHERE o.status = 'active' AND o.mode = 'single' AND s.driver_state <> 'available'`,
  'I-E one live single offer per driver': `SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
     WHERE o.status = 'active' AND o.mode = 'single' GROUP BY r.user_id HAVING count(*) > 1`,
  'I-F rounds never cross pools': `SELECT o.id FROM task_offers o JOIN tasks t ON t.id = o.task_id JOIN offer_recipients r ON r.offer_id = o.id
     LEFT JOIN duty_sessions ds ON ds.id = r.duty_session_id
     WHERE o.status = 'active' AND (o.dispatch_pool_id <> t.dispatch_pool_id OR ds.dispatch_pool_id <> o.dispatch_pool_id)`,
  '11 §1.7 ticket ↔ open task': `SELECT t.id FROM tickets t LEFT JOIN tasks k ON k.ticket_id = t.id AND k.status NOT IN ('completed','canceled')
     WHERE NOT (
          (t.status IN ('received','parking') AND k.type = 'park' AND k.status = 'in_progress')
       OR (t.status = 'requested' AND k.type = 'retrieve' AND k.status IN ('queued','offered','broadcast'))
       OR (t.status = 'assigned' AND k.type = 'retrieve' AND k.status = 'accepted')
       OR (t.status = 'assigned_waiting' AND k.type = 'retrieve' AND k.status = 'assigned_waiting')
       OR (t.status IN ('retrieving','ready') AND k.type = 'retrieve' AND k.status = 'in_progress')
       OR (t.status = 'reparking' AND k.type = 'repark' AND k.status = 'in_progress')
       OR (t.status IN ('parked','delivered','voided') AND k.id IS NULL))`,
};

/**
 * Every consistency check: the 10 §14.1 / 11 §1.7 queries above and infra/backup/consistency.sql (the restore
 * drill's checks). Returns `{ name: violations }` for all of them.
 */
export async function consistency(q) {
  const out = {};
  for (const [name, sql] of Object.entries(DISPATCH_INVARIANTS))
    out[name] = (await q.query(sql)).rowCount ?? 0;
  const restore = readFileSync(join(ROOT, 'infra/backup/consistency.sql'), 'utf8');
  for (const r of (await q.query(restore)).rows) out[`backup/${r.check_name}`] = Number(r.violations);
  return out;
}
