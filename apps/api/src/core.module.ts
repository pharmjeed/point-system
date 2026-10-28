import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import {
  CLOCK,
  DATABASE,
  ENV,
  LOGGER,
  SECRETS,
  Database,
  SecretResolver,
  SystemClock,
  createLogger,
  metrics,
  type Clock,
  type Env,
} from '@point/server';

export interface CoreModuleOptions {
  env: Env;
  clock?: Clock;
  database?: Database;
  /** extra modules for tests */
  extraModules?: Type[];
}

/** Process-wide singletons: configuration, clock, database pool, logger, secret resolver. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(opts: CoreModuleOptions): DynamicModule {
    const clock = opts.clock ?? new SystemClock();
    const database =
      opts.database ??
      new Database(
        {
          connectionString: opts.env.DATABASE_URL,
          poolMax: opts.env.DATABASE_POOL_MAX,
          lockTimeoutMs: opts.env.DATABASE_LOCK_TIMEOUT_MS,
          statementTimeoutMs: opts.env.DATABASE_STATEMENT_TIMEOUT_MS,
          ssl: opts.env.DATABASE_SSL,
          applicationName: 'point-api',
        },
        clock,
      );
    database.onRetry = (sqlstate) => metrics.dbTxRetries.inc({ sqlstate });
    const logger = createLogger({ level: opts.env.LOG_LEVEL, name: 'point-api' });
    database.onIdleError = (err) =>
      logger.warn({ err }, 'idle database connection failed; it will be replaced');
    return {
      module: CoreModule,
      providers: [
        { provide: ENV, useValue: opts.env },
        { provide: CLOCK, useValue: clock },
        { provide: DATABASE, useValue: database },
        { provide: LOGGER, useValue: logger },
        { provide: SECRETS, useValue: new SecretResolver(process.env) },
      ],
      exports: [ENV, CLOCK, DATABASE, LOGGER, SECRETS],
    };
  }
}
