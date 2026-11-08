import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import {
  chosenVehicle,
  loadPass,
  parsePassCache,
  passCacheFrom,
  passIsStale,
  passQr,
  qrRuns,
  secondsLeft,
  type PassStore,
} from '../src/features/pass';
import { ar } from '../src/i18n/ar';
import { en } from '../src/i18n/en';
import { onboard, PHONE, setup } from './helpers';

/**
 * V2-013 — C-11 بطاقة الدخول (V2-D14): `GET /v1/customer/pass` through the app's client and fake backend, the cache
 * in secure storage, the QR that changes every 30 s on the device clock corrected by the server's, offline use, the
 * vehicle choice, and the token the driver's scan accepts (the shared verifier the server runs).
 */
function memoryPassStore(): PassStore & { value: string | null } {
  const s = {
    value: null as string | null,
    async load() {
      return s.value;
    },
    async save(json: string) {
      s.value = json;
    },
  };
  return s;
}

async function signedInWithCars(n: number) {
  const ctx = setup();
  const me = await onboard(ctx);
  for (let i = 0; i < n; i++)
    await ctx.api.addVehicle({ plate: { country: 'SA', digits: String(4000 + i), letters_ar: 'ب ح د' } });
  return { ctx, me };
}

describe('C-11 — the pass from the API', () => {
  it('online: fetches the secret, caches it, draws a token the scan accepts; it changes every 30 s', async () => {
    const { ctx, me } = await signedInWithCars(2);
    const store = memoryPassStore();
    const r = await loadPass({
      fetchPass: () => ctx.api.pass(),
      store,
      accountId: me.id,
      now: ctx.clock.now,
    });
    expect(r.kind).toBe('online');
    if (r.kind === 'unavailable') return;
    expect(r.cache.pass.account_id).toBe(me.id);
    expect(r.cache.pass.vehicles).toHaveLength(2);
    expect(parsePassCache(store.value)).toEqual(r.cache);
    // the same secret on the next fetch
    expect((await ctx.api.pass()).secret).toBe(r.cache.pass.secret);

    const v = chosenVehicle(r.cache, null)!;
    const a = passQr(r.cache, v.vehicle_id, ctx.clock.now());
    expect(ctx.backend.verifyPass(a.token)).toMatchObject({
      ok: true,
      accountId: me.id,
      vehicleId: v.vehicle_id,
    });
    expect(secondsLeft(a)).toBeGreaterThanOrEqual(1);
    expect(secondsLeft(a)).toBeLessThanOrEqual(30);
    ctx.clock.advance(30_000);
    const b = passQr(r.cache, v.vehicle_id, ctx.clock.now());
    expect(b.token).not.toBe(a.token);
    expect(b.step).toBe(a.step + 1);
    // a screenshot two steps old no longer verifies
    ctx.clock.advance(60_000);
    expect(ctx.backend.verifyPass(a.token)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('offline: the cached secret keeps drawing valid codes; never fetched → unavailable; another account’s cache is not used', async () => {
    const { ctx, me } = await signedInWithCars(1);
    const store = memoryPassStore();
    await loadPass({ fetchPass: () => ctx.api.pass(), store, accountId: me.id, now: ctx.clock.now });
    const down = () => Promise.reject(new TypeError('Network request failed'));
    ctx.clock.advance(5 * 60_000);
    const off = await loadPass({ fetchPass: down, store, accountId: me.id, now: ctx.clock.now });
    expect(off.kind).toBe('offline');
    if (off.kind !== 'offline') return;
    const qr = passQr(off.cache, chosenVehicle(off.cache, null)!.vehicle_id, ctx.clock.now());
    expect(ctx.backend.verifyPass(qr.token).ok).toBe(true);
    // the app started offline (the account could not be read): the device's cache is used
    expect((await loadPass({ fetchPass: down, store, accountId: null, now: ctx.clock.now })).kind).toBe(
      'offline',
    );
    expect(
      (
        await loadPass({
          fetchPass: down,
          store,
          accountId: 'b1f7c3e2-0000-4000-8000-000000000000',
          now: ctx.clock.now,
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (await loadPass({ fetchPass: down, store: memoryPassStore(), accountId: me.id, now: ctx.clock.now }))
        .kind,
    ).toBe('unavailable');
    // a damaged cache is ignored
    expect(parsePassCache('{"pass":1}')).toBeNull();
    expect(parsePassCache('not json')).toBeNull();
  });

  it('a phone clock that is off still shows the server’s step (the offset measured at the fetch)', async () => {
    const { ctx } = await signedInWithCars(0);
    const pass = await ctx.api.pass();
    // the device clock runs 4 minutes and 10 s ahead of the server
    const skew = 250_000;
    const cache = passCacheFrom(pass, ctx.clock.now() + skew);
    expect(cache.offsetMs).toBe(-skew);
    ctx.clock.advance(20_000);
    const qr = passQr(cache, null, ctx.clock.now() + skew);
    expect(ctx.backend.verifyPass(qr.token)).toMatchObject({ ok: true, vehicleId: null });
    // without the correction the code would be eight steps ahead and refused
    const naive = passQr({ ...cache, offsetMs: 0 }, null, ctx.clock.now() + skew);
    expect(ctx.backend.verifyPass(naive.token)).toMatchObject({ ok: false, reason: 'future' });
    expect(passIsStale(cache, ctx.clock.now() + skew)).toBe(false);
    expect(passIsStale(cache, Date.parse(pass.refresh_after) + skew)).toBe(true);
  });

  it('the vehicle choice: the chosen one while it is in the pass, else the first; none without cars', async () => {
    const { ctx } = await signedInWithCars(3);
    const cache = passCacheFrom(await ctx.api.pass(), ctx.clock.now());
    const [first, second] = cache.pass.vehicles;
    expect(chosenVehicle(cache, second!.vehicle_id)).toEqual(second);
    expect(chosenVehicle(cache, 'gone')).toEqual(first);
    const none = passCacheFrom(await (await signedInWithCars(0)).ctx.api.pass(), 0);
    expect(chosenVehicle(none, null)).toBeNull();
    void PHONE;
  });
});

describe('C-11 — drawing', () => {
  it('qrRuns covers exactly the dark modules of the matrix', () => {
    const m = QRCode.create('P1.D5wrfj1BSluMbX6PmgscLQ.-.59434520.Ms0tUo6SXfOVXZ2Pdjw', {
      errorCorrectionLevel: 'M',
    }).modules;
    const runs = qrRuns(m);
    expect(runs).toHaveLength(m.size);
    let dark = 0;
    for (let i = 0; i < m.size * m.size; i++) dark += m.data[i] ? 1 : 0;
    expect(runs.flat().reduce((n, [, len]) => n + len, 0)).toBe(dark);
    // the finder pattern's top row: seven dark modules from the start
    expect(runs[0]![0]).toEqual([0, 7]);
  });

  it('the screen has its copy in both languages and no fixed colour or size outside the tokens', () => {
    for (const d of [ar, en])
      for (const k of [
        'title',
        'hint',
        'vehicle',
        'noVehicle',
        'changesIn',
        'offline',
        'unavailable',
      ] as const)
        expect(d.pass[k], k).toBeTruthy();
    const source = readFileSync(new URL('../src/app/pass.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(source).toMatch(/setBrightnessAsync\(1\)/);
    expect(source).toMatch(/securePassStore/);
  });
});
