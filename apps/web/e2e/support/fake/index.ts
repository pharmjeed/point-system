import { registerDriverRoutes } from './routesDriver';
import { registerSetupRoutes } from './routesSetup';
import { FakeServer } from './server';
import type { SeedOptions } from './seed';

export { errorReply, ok } from './http';
export type { Reply } from './http';
export type { FTicket, World } from './model';
export { FakeServer, STORAGE_PREFIX } from './server';
export type { FakeCall, Session } from './server';
export { SEED_CREDENTIALS, SEED_IDS } from './seed';
export type { SeedOptions, SeedUserKey } from './seed';

/** A fake backend with every route the web app uses, seeded from docs/17 §4. */
export function createFake(options: SeedOptions = {}): FakeServer {
  const server = new FakeServer(options);
  registerSetupRoutes(server);
  registerDriverRoutes(server);
  return server;
}
