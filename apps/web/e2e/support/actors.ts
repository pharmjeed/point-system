import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CommandLog } from './commandLog';
import type { FakeServer, SeedUserKey, Session } from './fake';

/**
 * One browser context per actor (a supervisor and an admin, two drivers…), with the project's device,
 * locale and time zone, attached to the same fake backend (each context = its own session).
 */
export async function actorPage(
  browser: Browser,
  fake: FakeServer,
  as: SeedUserKey | null,
): Promise<{ page: Page; session: Session }> {
  const page = await (await actorContext(browser)).newPage();
  const session = await fake.attach(page, as ?? undefined);
  return { page, session };
}

/** A fresh context with the project's device, locale and time zone (one actor = one context). */
export function actorContext(browser: Browser): Promise<BrowserContext> {
  const use = test.info().project.use;
  return browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    locale: use.locale,
    timezoneId: use.timezoneId,
    colorScheme: use.colorScheme,
  });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 07 §1.3/§1.4 for every command the UI sent through the fake: CSRF header, a UUIDv4 Idempotency-Key on
 * each required command, and a new key per intent (two different bodies never share a key).
 */
export function expectCommandContract(fake: CommandLog, routes: string[] = []): void {
  const commands = fake.calls.filter(
    (c) =>
      c.method !== 'GET' &&
      c.route &&
      !c.path.startsWith('/__e2e_storage/') &&
      !c.path.startsWith('/v1/auth/') &&
      // the HTTP fallback of client.heartbeat is not a command (canon §9: not ✓, no Idempotency-Key)
      c.path !== '/v1/me/heartbeat' &&
      // nor are the batches of client measurements (15 §9, DEC-149)
      c.path !== '/v1/telemetry',
  );
  expect(commands.length).toBeGreaterThan(0);
  const byKey = new Map<string, string>();
  for (const c of commands) {
    expect(c.headers['x-requested-with'], `${c.method} ${c.path}`).toBe('point-web');
    const key = c.headers['idempotency-key'];
    expect(key, `${c.method} ${c.path} Idempotency-Key`).toMatch(UUID_V4);
    const fingerprint = `${c.method} ${c.path}|${JSON.stringify(c.body ?? null)}`;
    const previous = byKey.get(key as string);
    if (previous)
      expect(previous, `key reused for a different intent: ${c.method} ${c.path}`).toBe(fingerprint);
    byKey.set(key as string, fingerprint);
    expect(c.status, `${c.method} ${c.path} was not refused for a missing key`).not.toBe(428);
  }
  for (const route of routes) expect(fake.callsTo(route).length, route).toBeGreaterThan(0);
}
