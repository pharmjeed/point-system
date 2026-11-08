/**
 * C-11 بطاقة الدخول (V2-013, V2-D14; DEC-500): a QR that changes every 30 seconds, drawn on the device without a
 * network once `GET /v1/customer/pass` has been cached in secure storage. The token is the shared pure generator's
 * (`generatePassToken`, docs/v2/05 §1.3), at the device time corrected by the offset to the server's clock measured
 * on the last fetch, so a phone whose clock is a few minutes off still shows the step the server expects. Pure (the
 * screen only renders it); the storage and the API are injected.
 */
import {
  CustomerPassSchema,
  generatePassToken,
  msUntilNextPassStep,
  passStep,
  type CustomerPass,
  type CustomerPassVehicle,
} from '@point/shared/customer';
import { z } from 'zod';

/** What the device keeps: the server's answer, and how far the device clock was from the server's then. */
export interface PassCache {
  pass: CustomerPass;
  /** server_time − device time at the fetch, in ms */
  offsetMs: number;
  /** device time of the fetch */
  fetchedAt: number;
}

const PassCacheSchema = z.object({
  pass: CustomerPassSchema,
  offsetMs: z.number().finite(),
  fetchedAt: z.number().finite(),
});

export function passCacheFrom(pass: CustomerPass, deviceNowMs: number): PassCache {
  return { pass, offsetMs: Date.parse(pass.server_time) - deviceNowMs, fetchedAt: deviceNowMs };
}

/** The stored JSON back, or null when it is missing, damaged or of another contract version. */
export function parsePassCache(raw: string | null): PassCache | null {
  if (!raw) return null;
  try {
    const r = PassCacheSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The vehicle shown: the one chosen if it is still in the pass, else the first; null for an account without one. */
export function chosenVehicle(cache: PassCache, chosenId: string | null): CustomerPassVehicle | null {
  const vs = cache.pass.vehicles;
  return vs.find((v) => v.vehicle_id === chosenId) ?? vs[0] ?? null;
}

export interface PassQr {
  /** the text drawn as QR */
  token: string;
  step: number;
  /** ms until the next code (the countdown under the QR) */
  msLeft: number;
}

/** The QR of this instant (device time + the measured offset). */
export function passQr(cache: PassCache, vehicleId: string | null, deviceNowMs: number): PassQr {
  const serverNow = deviceNowMs + cache.offsetMs;
  return {
    token: generatePassToken({
      secret: cache.pass.secret,
      accountId: cache.pass.account_id,
      vehicleId,
      nowMs: serverNow,
    }),
    step: passStep(serverNow),
    msLeft: msUntilNextPassStep(serverNow),
  };
}

/** Whole seconds left before the code changes (1…30). */
export const secondsLeft = (qr: PassQr): number => Math.max(1, Math.ceil(qr.msLeft / 1000));

/** Past the server's refresh time: the next online open fetches the rotated secret (the old one stays valid a while). */
export function passIsStale(cache: PassCache, deviceNowMs: number): boolean {
  return deviceNowMs + cache.offsetMs >= Date.parse(cache.pass.refresh_after);
}

/** One cache per device (a sign-out or another account drops it): JSON of {@link PassCache}. */
export interface PassStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

export type PassLoad =
  | { kind: 'online'; cache: PassCache }
  /** no network (or the server failed): the cached secret still draws valid codes */
  | { kind: 'offline'; cache: PassCache }
  /** never fetched on this device and no network: nothing to show yet */
  | { kind: 'unavailable'; error: unknown };

/**
 * Fetches the pass when it can and caches it; falls back to the cached one (V2-D14 «يعمل بلا إنترنت»). `accountId` is
 * the signed-in account when the app could read it, `null` when it started offline: a cache of another account is
 * never used.
 */
export async function loadPass(deps: {
  fetchPass: () => Promise<CustomerPass>;
  store: PassStore;
  accountId: string | null;
  now: () => number;
}): Promise<PassLoad> {
  try {
    const pass = await deps.fetchPass();
    const cache = passCacheFrom(pass, deps.now());
    await deps.store.save(JSON.stringify(cache));
    return { kind: 'online', cache };
  } catch (error) {
    const cached = parsePassCache(await deps.store.load().catch(() => null));
    if (cached && (deps.accountId === null || cached.pass.account_id === deps.accountId))
      return { kind: 'offline', cache: cached };
    return { kind: 'unavailable', error };
  }
}

/**
 * The QR modules as runs of dark cells per row (a View per run instead of one per module): `[row][i] = [x, length]`.
 * `modules` is the `qrcode` encoder's square bit matrix.
 */
export function qrRuns(modules: { size: number; data: ArrayLike<number | boolean> }): [number, number][][] {
  const rows: [number, number][][] = [];
  for (let y = 0; y < modules.size; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= modules.size; x++) {
      const dark = x < modules.size && !!modules.data[y * modules.size + x];
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push([start, x - start]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  return rows;
}
