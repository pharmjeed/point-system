// CLI for the dev/test seed: `node packages/db/dist/seed/cli.js` (after `pnpm --filter @point/db build`).
// Reads DATABASE_URL (and APP_ENV, NODE_ENV, DATA_ENCRYPTION_KEY[_ID], AUTH_SECRET_PEPPER, BRAND_CUSTOMER_NAME_AR).
// Exit codes: 0 seeded (or already seeded), 2 configuration error, 3 refused (production/staging), 1 failure.
import pg from 'pg';
import { assertSeedAllowed, seed, SeedRefusedError } from './index.js';

async function main(): Promise<number> {
  try {
    // Refuse before opening any connection.
    assertSeedAllowed(process.env.APP_ENV, process.env.NODE_ENV);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 3;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed: DATABASE_URL is not set');
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const summary = await seed(pool);
    console.log(`seed: APP_ENV=${summary.appEnv}`);
    for (const [table, { inserted, existing }] of Object.entries(summary.tables)) {
      console.log(
        `  ${table.padEnd(20)} inserted ${String(inserted).padStart(3)}  existing ${String(existing).padStart(3)}`,
      );
    }
    console.log(
      `  mfa_secret_enc key id: ${summary.dataKeyId}${summary.usedDevDataKey ? ' (DEV-ONLY fallback key: DATA_ENCRYPTION_KEY is empty)' : ''}`,
    );
    console.log(`  argon2 pepper: ${summary.pepperApplied ? 'AUTH_SECRET_PEPPER applied' : 'none'}`);
    return 0;
  } catch (err) {
    if (err instanceof SeedRefusedError) {
      console.error(err.message);
      return 3;
    }
    console.error('seed failed:', err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
