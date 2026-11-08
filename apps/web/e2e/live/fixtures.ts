import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { actorContext } from '../support/actors';
import { uiSignIn, WEB_ORIGIN } from '../support/backend';
import { BrowserCommandLog } from '../support/commandLog';
import type { SeedUserKey } from '../support/fake/seed';
import type { G1Actor } from '../support/g1';

/**
 * The live-API fixtures (PNT-036): one real API per worker (e2e/live/api-server.mjs on a fresh seeded
 * database), SQL access to that database for the assertions, and driver pages signed in through D-01 whose
 * `/v1` traffic is logged in the browser (BrowserCommandLog) and whose photo uploads reach the API's private
 * in-memory bucket.
 */
export interface LiveApi {
  apiOrigin: string;
  databaseUrl: string;
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BUILT = [
  'packages/shared/dist/index.js',
  'packages/db/dist/index.js',
  'packages/server/dist/index.js',
  'apps/api/dist/bootstrap.js',
];

async function startApi(): Promise<{ apiOrigin: string; databaseUrl: string; stop: () => Promise<void> }> {
  const missing = BUILT.filter((p) => !existsSync(`${ROOT}${p}`));
  if (missing.length)
    throw new Error(
      `the live run needs the backend built (pnpm --filter @point/web test:e2e:live does it): ${missing.join(', ')}`,
    );
  const child = spawn(process.execPath, [fileURLToPath(new URL('./api-server.mjs', import.meta.url))], {
    env: { ...process.env, E2E_WEB_ORIGIN: WEB_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  const ready = await new Promise<{ apiOrigin: string; databaseUrl: string }>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`api-server did not start: ${stderr}`)), 90_000);
    child.stdout.on('data', (d) => {
      stdout += String(d);
      const line = stdout.split('\n').find((l) => l.startsWith('{"ready":true'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`api-server exited with ${code}: ${stderr}`));
    });
  });
  return {
    ...ready,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      // the server drops its database and exits within 10 s; past 20 s it is killed so the teardown never hangs
      const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      await exited;
      clearTimeout(killer);
    },
  };
}

export const test = base.extend<object, { live: LiveApi }>({
  live: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as the first argument
    async ({}, use) => {
      const api = await startApi();
      const pool = new pg.Pool({ connectionString: api.databaseUrl, max: 2 });
      try {
        await use({
          apiOrigin: api.apiOrigin,
          databaseUrl: api.databaseUrl,
          sql: async <T>(text: string, params: unknown[] = []) =>
            (await pool.query(text, params)).rows as T[],
        });
      } finally {
        await pool.end();
        await api.stop();
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

/**
 * The browser side of the private bucket: the presigned URLs of the API's in-memory storage
 * (`http://object-storage.invalid/…`) are answered by the API's `/__e2e/storage` (signature, expiry and
 * length checked there), with the CORS headers a real bucket configured for the web origin sends.
 */
export async function routeStorage(page: Page, live: LiveApi): Promise<void> {
  await page.route('http://object-storage.invalid/**', async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': WEB_ORIGIN,
      'access-control-allow-methods': 'GET, HEAD, PUT',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type',
      'access-control-max-age': '600',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const headers: Record<string, string> = { ...request.headers(), 'x-e2e-url': request.url() };
    delete headers.host;
    const response = await route.fetch({ url: `${live.apiOrigin}/__e2e/storage`, headers });
    const out: Record<string, string> = { ...response.headers(), ...cors };
    delete out['cross-origin-resource-policy']; // the API's own helmet header, not the bucket's
    await route.fulfill({ status: response.status(), headers: out, body: await response.body() });
  });
}

/** A driver's page: own context, `/v1` logged in the browser, the bucket routed, signed in through D-01. */
export async function livePage(browser: Browser, live: LiveApi, as: SeedUserKey): Promise<G1Actor> {
  const page = await (await actorContext(browser)).newPage();
  const log = await BrowserCommandLog.attach(page);
  await routeStorage(page, live);
  await uiSignIn(page, as);
  return { page, log };
}
