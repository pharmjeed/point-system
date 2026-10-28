import pg from 'pg';
import { randomBytes } from 'node:crypto';

/** Test/dev helper: creates a throwaway database on the server of `adminUrl` and returns its URL. */
export async function createDatabase(
  adminUrl: string,
  prefix = 'point_t',
): Promise<{ url: string; name: string }> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return { url: u.toString(), name };
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
