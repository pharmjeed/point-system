import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SEED_CREDENTIALS, type SeedUserKey } from './fake/seed';
import { totp } from './totp';

/**
 * Which backend the e2e specs talk to.
 *
 * - `fake` (default): the stateful fake of ./fake answering `/v1/*` inside the browser (`page.route`) — no
 *   server, deterministic, faults and latency injectable, the world readable by the spec.
 * - `live` (`E2E_BACKEND=live`, the `g1-live` project, PNT-036): the real API on a freshly migrated and
 *   seeded database (e2e/live/api-server.mjs), reached through the same-origin proxy of `vite preview`
 *   (vite.config.ts → `localhost:API_PORT`). The fake starts from that same seed (packages/db/src/seed:
 *   ids, fixtures, development credentials), so a scenario reads the same on both: `fake.attach(page, as)`
 *   becomes `uiSignIn(page, as)` (D-01) or `liveSignIn(request, as)`, `fake.exec(…)` becomes `liveExec(…)`,
 *   and assertions on `fake.world` become SQL.
 */
export type BackendKind = 'fake' | 'live';

export const BACKEND: BackendKind = process.env.E2E_BACKEND === 'live' ? 'live' : 'fake';

/** The web app's origin (`vite preview`); the API's CSRF guard requires it as `Origin` (DEC-29). */
export const WEB_ORIGIN = `http://localhost:${Number(process.env.E2E_PORT ?? 5317)}`;

/** For a spec that injects faults or reads the fake's world: skipped in a live run. */
export function fakeOnly(): void {
  test.skip(BACKEND === 'live', 'needs the fake backend (fault injection or world inspection)');
}

const CSRF = { 'X-Requested-With': 'point-web', Origin: WEB_ORIGIN };

async function postJson(request: APIRequestContext, path: string, data: unknown) {
  const res = await request.post(path, { data, headers: CSRF });
  const body = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    error?: { code?: string };
  } | null;
  if (!res.ok()) throw new Error(`live ${path} → ${res.status()} ${body?.error?.code ?? ''}`);
  return body?.data ?? {};
}

/**
 * Signs the context of `request` in as a seeded user: `POST /v1/auth/login` with the development
 * credentials, then the TOTP step for MFA accounts (OWN1, ADM1). With `page.request` the page shares the
 * cookie. Development seed only — never real credentials.
 */
export async function liveSignIn(request: APIRequestContext, as: SeedUserKey): Promise<void> {
  const cred = SEED_CREDENTIALS[as];
  const login = await postJson(request, '/v1/auth/login', { phone: cred.phone, secret: cred.secret });
  if (login.mfa_required) {
    if (!cred.totpSecret) throw new Error(`live sign-in ${as}: MFA required, no seeded TOTP secret`);
    await postJson(request, '/v1/auth/mfa/verify', {
      mfa_token: login.mfa_token,
      code: totp(cred.totpSecret),
    });
  } else if (login.mfa_setup_required || login.must_change_secret) {
    throw new Error(`live sign-in ${as}: the seeded account must finish MFA setup or a secret change first`);
  }
}

/** A driver signs in through D-01 (phone + PIN of the development seed) and lands on D-03. */
export async function uiSignIn(page: Page, as: SeedUserKey): Promise<void> {
  const cred = SEED_CREDENTIALS[as];
  await page.goto('/login');
  await page.getByLabel('رقم الجوال').fill(cred.phone.replace(/^\+966/, '0'));
  await page.getByLabel('الرقم السري', { exact: true }).fill(cred.secret);
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page).toHaveURL(/\/d\/start$/);
}

/**
 * One command or read as the signed-in actor of `request`, like `fake.exec`: the spec's `:params` are
 * filled in, unsafe methods carry the CSRF headers and a fresh UUIDv4 Idempotency-Key (07 §1.3, §1.4).
 * Returns `data`; throws on an error reply.
 */
export async function liveExec<T = unknown>(
  request: APIRequestContext,
  spec: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const [method = 'GET', template = ''] = spec.split(' ');
  const path = template.replace(/:([A-Za-z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
  const unsafe = method !== 'GET';
  const res = await request.fetch(path, {
    method,
    data: body,
    headers: unsafe ? { ...CSRF, 'Idempotency-Key': randomUUID() } : {},
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string } } | null;
  if (!res.ok()) throw new Error(`live ${spec} → ${res.status()} ${json?.error?.code ?? ''}`);
  return json?.data as T;
}
