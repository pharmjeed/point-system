import { createCustomerApi } from '../src/api/client';
import { createFakeBackend, type FakeBackendOptions } from '../src/api/fake/backend';
import type { Transport } from '../src/api/transport';
import { memoryTokenStore } from '../src/session/tokenStore';

/** Deterministic random (mulberry32). */
export function seeded(seed = 42): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock the test moves by hand. */
export function manualClock(start = Date.parse('2026-11-07T09:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export const PHONE = '+966512345678';

export function setup(options: FakeBackendOptions & { transport?: (t: Transport) => Transport } = {}) {
  const clock = manualClock();
  const backend = createFakeBackend({ now: clock.now, random: seeded(), ...options });
  const tokens = memoryTokenStore();
  let keys = 0;
  const signedOut: string[] = [];
  const transport = options.transport ? options.transport(backend.transport) : backend.transport;
  const api = createCustomerApi({
    transport,
    tokens,
    device: { id: 'device-test-0001', platform: 'ios' },
    newKey: () => `key-${++keys}`,
    now: clock.now,
    onSignedOut: (r) => signedOut.push(r),
  });
  return { api, backend, tokens, clock, signedOut };
}

/** Signs in through the fake (code read from the WhatsApp simulator inbox). */
export async function signIn(ctx: ReturnType<typeof setup>, phone = PHONE) {
  await ctx.api.requestOtp(phone, 'ar');
  const code = ctx.backend.lastCode(phone);
  if (!code) throw new Error('no code in the inbox');
  return ctx.api.verifyOtp(phone, code);
}

/** Signs in and completes C-04 (name, terms, privacy, marketing declined). */
export async function onboard(ctx: ReturnType<typeof setup>, phone = PHONE) {
  const { account } = await signIn(ctx, phone);
  await ctx.api.updateMe({ display_name: 'سارة' });
  return ctx.api.submitConsents({
    consents: [
      { kind: 'terms', version: account.consents.terms.current_version, granted: true },
      { kind: 'privacy', version: account.consents.privacy.current_version, granted: true },
      { kind: 'marketing', version: account.consents.marketing.current_version, granted: false },
    ],
  });
}
