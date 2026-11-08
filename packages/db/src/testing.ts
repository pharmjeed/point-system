import pg from 'pg';
import { createDatabase, dropDatabase } from './admin.js';
import { migrate } from './migrate.js';

/**
 * Integration-test databases. The vitest global setup provides TEST_DATABASE_URL (a server where we may
 * CREATE DATABASE: Testcontainers postgres:16 in CI, or a local PostgreSQL 16) and TEST_TEMPLATE_DB (a
 * database already migrated once). Each test file clones the template, which takes milliseconds.
 */
export function testAdminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (run through the vitest "integration" project)');
  return url;
}

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export async function createMigratedTemplate(adminUrl: string): Promise<string> {
  const db = await createDatabase(adminUrl, 'point_tpl');
  await migrate(db.url);
  return db.name;
}

export async function createTestDatabase(opts: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const admin = testAdminUrl();
  const template = process.env.TEST_TEMPLATE_DB;
  const migrated = opts.migrated ?? true;
  let created: { url: string; name: string };
  if (migrated && template) {
    const name = `point_t_${Math.random().toString(16).slice(2, 12)}`;
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    try {
      await c.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    } finally {
      await c.end();
    }
    const u = new URL(admin);
    u.pathname = `/${name}`;
    created = { url: u.toString(), name };
  } else {
    created = await createDatabase(admin);
    if (migrated) await migrate(created.url);
  }
  return { ...created, drop: () => dropDatabase(admin, created.name) };
}
