import 'reflect-metadata';
import { Database, EnvError, SystemClock, loadDeployedEnv, maskPhone } from '@point/server';
import {
  CREATE_OWNER_USAGE,
  OwnerBootstrapError,
  createOwner,
  parseCreateOwnerArgs,
} from './ops/create-owner.js';

/**
 * Operator commands of the api image (docs/DEPLOYMENT.md):
 *   node api/dist/cli.js create-owner --phone <phone> --name <full name> [--org-name-ar <name>] …
 * Exit codes: 0 done, 2 usage or configuration, 3 refused (e.g. an owner exists), 1 failure.
 */
async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'create-owner') {
    console.error(CREATE_OWNER_USAGE);
    return 2;
  }
  let input;
  try {
    input = parseCreateOwnerArgs(rest);
  } catch (e) {
    console.error(`${(e as Error).message}\n${CREATE_OWNER_USAGE}`);
    return 2;
  }
  let env;
  try {
    env = loadDeployedEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const db = new Database(
    {
      connectionString: env.DATABASE_URL,
      poolMax: 2,
      ssl: env.DATABASE_SSL,
      lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: 'point-cli',
    },
    new SystemClock(),
  );
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

process.exitCode = await main(process.argv.slice(2));
