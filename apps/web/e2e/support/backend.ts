import { randomUUID } from 'node:crypto';
import { test, type APIRequestContext } from '@playwright/test';
import { SEED_CREDENTIALS, type SeedUserKey } from './fake';
import { totp } from './totp';

/**
 * Which backend the e2e specs talk to.
 *
 * - `fake` (default, PNT-021…035): the stateful fake of ./fake answering `/v1/*` inside the browser
 *   (`page.route`) — no server, deterministic, faults and latency injectable, the world readable by the spec.
 * - `live` (`E2E_BACKEND=live`, PNT-036): the real API seeded with `pnpm db:seed`, behind the same-origin
 *   proxy of `vite preview` (vite.config.ts → `localhost:API_PORT`). The fake starts from that same seed
 *   (packages/db/src/seed: ids, fixtures, dev credentials), so a scenario that signs seeded actors in,
 *   presses buttons and arranges its world with API calls reads the same on both: `fake.attach(page, as)`
 *   becomes `liveSignIn(page.request, as)` and `fake.exec(as, spec, params, body)` becomes
 *   `liveExec(actorRequest, spec, params, body)`. Assertions on `fake.world` become API reads.
 */
export type BackendKind = 'fake' | 'live';

export const BACKEND: BackendKind = process.env.E2E_BACKEND === 'live' ? 'live' : 'fake';

/** For a spec that injects faults or reads the fake's world: skipped in a live run. */
export function fakeOnly(): void {
  test.skip(BACKEND === 'live', 'needs the fake backend (fault injection or world inspection)');
}

const CSRF = { 'X-Requested-With': 'point-web' };

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
 * Signs the context of `request` (`page.request` shares the page's cookie jar) in as a seeded user:
 * `POST /v1/auth/login` with the development credentials, then the TOTP step for MFA accounts (OWN1,
 * ADM1). The next navigation of the page is signed in. Development seed only — never real credentials.
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

/**
 * One command or read as the signed-in actor of `request`, like `fake.exec`: the spec's `:params` are
 * filled in, unsafe methods carry the CSRF header and a fresh UUIDv4 Idempotency-Key (07 §1.3, §1.4).
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
