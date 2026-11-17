#!/usr/bin/env node
import { migrate, reset } from './migrate.js';
import { checkDrift, runInvariants } from './tools.js';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
// drift/invariants build throwaway databases, so they need a URL with CREATE DATABASE rights.
const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? url;

function need(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

async function main() {
  switch (cmd) {
    case 'migrate': {
      const done = await migrate(need(url, 'DATABASE_URL'), console.log);
      console.log(done.length ? `applied ${done.length} migration(s)` : 'database is up to date');
      break;
    }
    case 'reset':
      await reset(need(url, 'DATABASE_URL'));
      await migrate(need(url, 'DATABASE_URL'), console.log);
      console.log('database reset');
      break;
    case 'drift': {
      const r = await checkDrift(need(adminUrl, 'ADMIN_DATABASE_URL'));
      if (!r.ok) {
        console.error('SCHEMA DRIFT: migrations are missing objects defined in docs/06_schema.sql');
        console.error(JSON.stringify(r.missing, null, 2));
        process.exit(1);
      }
      console.log('no schema drift');
      break;
    }
    case 'invariants': {
      const r = await runInvariants(need(adminUrl, 'ADMIN_DATABASE_URL'));
      for (const line of r.output) console.log(line);
      if (!r.passed) process.exit(1);
      break;
    }
    case 'seed-annex': {
      // V2-036 (DEC-607): the dev-only demo of the subscriptions annex, after the base seed
      const { seedAnnexDemo } = await import('./seed/annex-demo.js');
      const pg = (await import('pg')).default;
      const pool = new pg.Pool({ connectionString: need(url, 'DATABASE_URL'), max: 1 });
      try {
        const r = await seedAnnexDemo(pool);
        console.log(`seed-annex: ${r.inserted} row(s) inserted`);
      } finally {
        await pool.end();
      }
      break;
    }
    case 'seed': {
      // same as `node dist/seed/cli.js` (per-table summary, exit 3 when refused)
      await import('./seed/cli.js');
      break;
    }
    default:
      console.error('usage: point-db migrate|reset|drift|invariants|seed');
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
