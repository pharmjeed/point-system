import type { TestProject } from 'vitest/node';
import { createMigratedTemplate } from '../src/testing.js';
import { dropDatabase } from '../src/admin.js';

// Integration tests run on a real PostgreSQL 16. CI starts one with Testcontainers; locally you may point
// TEST_DATABASE_URL at any PostgreSQL 16 where the user can CREATE DATABASE.
export default async function setup(_project: TestProject) {
  let stop: (() => Promise<unknown>) | undefined;
  if (!process.env.TEST_DATABASE_URL) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16').start();
    process.env.TEST_DATABASE_URL = container.getConnectionUri();
    stop = () => container.stop();
  }
  const admin = process.env.TEST_DATABASE_URL;
  const template = await createMigratedTemplate(admin);
  process.env.TEST_TEMPLATE_DB = template;
  return async () => {
    await dropDatabase(admin, template).catch(() => {});
    await stop?.();
  };
}
