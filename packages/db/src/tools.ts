import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createDatabase, dropDatabase } from './admin.js';
import { compareCatalogs, snapshotCatalog, type DriftReport } from './catalog.js';
import { migrate } from './migrate.js';
import { INVARIANTS_SQL, SCHEMA_SQL } from './paths.js';

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Executes a psql script through the driver: psql meta-commands (`\set ...`) are dropped. */
export async function runSqlScript(url: string, file: string): Promise<string[]> {
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('\\'))
    .join('\n');
  return withClient(url, async (c) => {
    const res = await c.query(sql);
    const results = Array.isArray(res) ? res : [res];
    return results.flatMap((r) =>
      r.rows.map((row: Record<string, unknown>) => String(Object.values(row)[0])),
    );
  });
}

/** PNT-003 drift check: a database built from the migrations must contain everything docs/06_schema.sql defines. */
export async function checkDrift(adminUrl: string): Promise<DriftReport> {
  const a = await createDatabase(adminUrl, 'point_drift_mig');
  const b = await createDatabase(adminUrl, 'point_drift_ref');
  try {
    await migrate(a.url);
    await runSqlScript(b.url, SCHEMA_SQL);
    const [actual, expected] = await Promise.all([
      withClient(a.url, snapshotCatalog),
      withClient(b.url, snapshotCatalog),
    ]);
    return compareCatalogs(expected, actual);
  } finally {
    await dropDatabase(adminUrl, a.name);
    await dropDatabase(adminUrl, b.name);
  }
}

/** PNT-004: runs docs/06_schema_invariants_test.sql on a fresh database built from the migrations. */
export async function runInvariants(adminUrl: string): Promise<{ passed: boolean; output: string[] }> {
  const db = await createDatabase(adminUrl, 'point_inv');
  try {
    await migrate(db.url);
    const output = await runSqlScript(db.url, INVARIANTS_SQL);
    return { passed: output.at(-1) === 'ALL INVARIANT TESTS PASSED', output };
  } finally {
    await dropDatabase(adminUrl, db.name);
  }
}
