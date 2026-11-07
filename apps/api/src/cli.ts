import 'reflect-metadata';
import { Database, EnvError, SystemClock, loadDeployedEnv, maskPhone, type Env } from '@point/server';
import {
  CREATE_OWNER_USAGE,
  OwnerBootstrapError,
  createOwner,
  parseCreateOwnerArgs,
} from './ops/create-owner.js';
import {
  CREATE_PLATFORM_OWNER_USAGE,
  PlatformOwnerBootstrapError,
  createPlatformOwner,
  parseCreatePlatformOwnerArgs,
} from './ops/create-platform-owner.js';

/**
 * Operator commands of the api image (docs/DEPLOYMENT.md):
 *   node api/dist/cli.js create-owner --phone <phone> --name <full name> [--org-name-ar <name>] …
 *   node api/dist/cli.js create-platform-owner --phone <phone> --name <full name>   (V2-002)
 * Exit codes: 0 done, 2 usage or configuration, 3 refused (e.g. an owner exists), 1 failure.
 */
const USAGE = `${CREATE_OWNER_USAGE}\n\n${CREATE_PLATFORM_OWNER_USAGE}`;

function openDatabase(env: Env): Database {
  return new Database(
    {
      connectionString: env.DATABASE_URL,
      poolMax: 2,
      ssl: env.DATABASE_SSL,
      lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      applicationName: 'point-cli',
    },
    new SystemClock(),
  );
}

function deployedEnv(): Env | null {
  try {
    return loadDeployedEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      return null;
    }
    throw e;
  }
}

async function runCreateOwner(rest: string[]): Promise<number> {
  let input;
  try {
    input = parseCreateOwnerArgs(rest);
  } catch (e) {
    console.error(`${(e as Error).message}\n${CREATE_OWNER_USAGE}`);
    return 2;
  }
  const env = deployedEnv();
  if (!env) return 2;
  const db = openDatabase(env);
  try {
    const r = await createOwner(db, env, input);
    console.log(
      [
        'owner created',
        `  organization   ${r.orgId}${r.orgCreated ? ' (new)' : ''}`,
        `  user           ${r.userId} ${r.employeeCode}`,
        `  phone          ${maskPhone(r.phoneE164)}`,
        `  temporary password (shown once): ${r.temporaryPassword}`,
        `next: sign in at ${new URL('/staff/login', env.APP_BASE_URL).toString()} — change the password, then set up the authenticator (MFA).`,
      ].join('\n'),
    );
    return 0;
  } catch (e) {
    if (e instanceof OwnerBootstrapError) {
      console.error(`create-owner refused (${e.reason}): ${e.message}`);
      return 3;
    }
    console.error(`create-owner failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
}

async function runCreatePlatformOwner(rest: string[]): Promise<number> {
  let input;
  try {
    input = parseCreatePlatformOwnerArgs(rest);
  } catch (e) {
    console.error(`${(e as Error).message}\n${CREATE_PLATFORM_OWNER_USAGE}`);
    return 2;
  }
  const env = deployedEnv();
  if (!env) return 2;
  const db = openDatabase(env);
  try {
    const r = await createPlatformOwner(db, env, input);
    console.log(
      [
        'platform owner created',
        `  platform user  ${r.userId}`,
        `  phone          ${maskPhone(r.phoneE164)}`,
        `  temporary password (shown once): ${r.temporaryPassword}`,
        `next: sign in at ${new URL('/platform/login', env.APP_BASE_URL).toString()} — change the password, then set up the authenticator (MFA).`,
      ].join('\n'),
    );
    return 0;
  } catch (e) {
    if (e instanceof PlatformOwnerBootstrapError) {
      console.error(`create-platform-owner refused (${e.reason}): ${e.message}`);
      return 3;
    }
    console.error(`create-platform-owner failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'create-owner') return runCreateOwner(rest);
  if (cmd === 'create-platform-owner') return runCreatePlatformOwner(rest);
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
