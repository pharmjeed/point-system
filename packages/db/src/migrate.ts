import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR } from './paths.js';

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies pending SQL migrations in order. The first one is docs/06_schema.sql verbatim (it carries its own
 * BEGIN/COMMIT). A changed checksum of an applied migration is an error: migrations are append-only.
 */
export async function migrate(
  connectionString: string,
  log: (m: string) => void = () => {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`SELECT pg_advisory_lock(hashtext('point_schema_migrations'))`);
    const applied = new Map(
      (
        await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')
      ).rows.map((r) => [r.name, r.checksum]),
    );
    const done: string[] = [];
    for (const m of listMigrations()) {
      const prev = applied.get(m.name);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied`);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        m.name,
        m.checksum,
      ]);
      done.push(m.name);
    }
    return done;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('point_schema_migrations'))`).catch(() => {});
    await client.end();
  }
}

/** Drops and recreates the public schema. Refuses in production. */
export async function reset(connectionString: string): Promise<void> {
  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refused in production');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}
