/**
 * V2-010: the app against a real, locally running API (README «الخادم الحقيقي»). Skipped unless
 * `CUSTOMER_LIVE_API_URL` (the API origin the app's `CUSTOMER_API_BASE_URL` would hold) and `WA_SIMULATOR_URL` (the
 * WhatsApp simulator that plays the Point number) are set. It drives R1 (C-02 … C-06) with the app's own client and
 * transport, unchanged: the code comes from the simulator's inbox, never from the API.
 */
import { describe, expect, it } from 'vitest';
import { createCustomerApi } from '../src/api/client';
import { httpTransport } from '../src/api/transport';
import { memoryTokenStore } from '../src/session/tokenStore';

const API = process.env.CUSTOMER_LIVE_API_URL;
const SIM = process.env.WA_SIMULATOR_URL;

async function codeFromSimulator(phone: string): Promise<string> {
  const to = phone.replace(/^\+/, '');
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${SIM}/_sim/messages?to=${to}`);
    const body = (await res.json()) as {
      data: { templateName: string | null; bodyParams: string[]; seq: number }[];
    };
    const last = body.data
      .filter((m) => m.templateName === 'point_customer_otp_v1')
      .sort((a, b) => a.seq - b.seq)
      .at(-1);
    if (last?.bodyParams[0]) return last.bodyParams[0];
    await new Promise((r) => setTimeout(r, 200)); // the worker sends after COMMIT
  }
  throw new Error(`no sign-in code reached ${phone} in the simulator`);
}

describe.skipIf(!API || !SIM)('the app on the real API (CUSTOMER_LIVE_API_URL)', () => {
  it('R1: WhatsApp code → account → profile → consents → vehicle → home', async () => {
    const tokens = memoryTokenStore();
    let n = 0;
    const api = createCustomerApi({
      transport: httpTransport({ baseUrl: API as string }),
      tokens,
      device: { id: `live-smoke-${Date.now().toString(36)}`, platform: 'ios' },
      newKey: () => `live-${Date.now().toString(36)}-${++n}`,
    });
    const phone = `+9665${String(Date.now()).slice(-8)}`;
    const challenge = await api.requestOtp(phone, 'ar');
    expect(challenge.channel).toBe('whatsapp');
    const auth = await api.verifyOtp(phone, await codeFromSimulator(phone));
    expect(auth.is_new_account).toBe(true);
    const named = await api.updateMe({ display_name: 'عميل تجريبي' });
    const me = await api.submitConsents({
      consents: [
        { kind: 'terms', version: named.consents.terms.current_version, granted: true },
        { kind: 'privacy', version: named.consents.privacy.current_version, granted: true },
      ],
    });
    expect(me.profile_complete).toBe(true);
    const car = await api.addVehicle({ plate: { country: 'SA', digits: '1234', letters_ar: 'ا ب ح' } });
    expect(car.plate.display).toBe('1234 ا ب ح');
    const home = await api.home();
    expect(home.vehicles_count).toBe(1);
    await api.logout();
    expect(await tokens.load()).toBeNull();
  });
});
