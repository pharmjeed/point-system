// Runtime dependencies of the ops harness (infra/load, infra/chaos). infra/ is not a workspace package, so the
// libraries are resolved from the workspace packages that already depend on them: no new dependency and no
// lockfile change. The production build (`dist/`) of the backend packages is imported by path.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const fromApi = createRequire(join(ROOT, 'apps/api/package.json'));
const fromDb = createRequire(join(ROOT, 'packages/db/package.json'));

async function load(req, name) {
  const mod = await import(pathToFileURL(req.resolve(name)).href);
  return mod;
}

const pgMod = await load(fromApi, 'pg');
/** node-postgres (CommonJS): `pg.Pool`, `pg.Client`. */
export const pg = pgMod.default ?? pgMod;

const sioMod = await load(fromApi, 'socket.io-client');
/** socket.io-client's `io()`. */
export const io = sioMod.io ?? sioMod.default?.io ?? sioMod.default;

const argonMod = await load(fromDb, 'argon2');
/** argon2 (`hash`, `argon2id`) for the load seed's credentials. */
export const argon2 = argonMod.default ?? argonMod;

/** A file of the production build; refuses to go on when it is missing (`pnpm ops:load` builds first). */
export function distPath(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`${rel} is missing: build the backend first (pnpm ops:load builds it)`);
  return p;
}

/** Imports an ES module of the production build by its repository path. */
export function importDist(rel) {
  return import(pathToFileURL(distPath(rel)).href);
}
