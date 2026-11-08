/**
 * Web stand-in of ./secureStore.ts, used ONLY by the store-screenshot export (V2-052, DEC-568,
 * `scripts/store-screenshots.mjs`): the customer app ships on iOS and Android only and never as a web page
 * (CLAUDE.md §1). expo-secure-store has no web implementation, so this keeps the same API in memory: nothing is
 * written to localStorage, sessionStorage or cookies, and everything is gone when the page closes — like the fake
 * backend the screenshots run against.
 */
import { parseStoredSession, type StoredSession, type TokenStore } from './tokenStore';

const memory = new Map<string, string>();

const get = async (key: string): Promise<string | null> => memory.get(key) ?? null;
const set = async (key: string, value: string): Promise<void> => {
  memory.set(key, value);
};
const del = async (key: string): Promise<void> => {
  memory.delete(key);
};

const uuid = (): string => globalThis.crypto.randomUUID();

export const secureTokenStore: TokenStore = {
  async load(): Promise<StoredSession | null> {
    return parseStoredSession(await get('customer.session'));
  },
  async save(session) {
    await set('customer.session', JSON.stringify(session));
  },
  async clear() {
    await del('customer.session');
  },
};

export async function deviceId(): Promise<string> {
  const existing = await get('customer.device_id');
  if (existing) return existing;
  const id = uuid();
  await set('customer.device_id', id);
  return id;
}

const flag = async (key: string): Promise<boolean> => (await get(key)) === '1';

export const flags = {
  welcomeSeen: () => flag('customer.welcome_seen'),
  setWelcomeSeen: () => set('customer.welcome_seen', '1'),
  vehiclePromptDone: (accountId: string) => flag(`customer.vehicle_prompt.${accountId}`),
  setVehiclePromptDone: (accountId: string) => set(`customer.vehicle_prompt.${accountId}`, '1'),
  locale: () => get('customer.locale'),
  setLocale: (locale: 'ar' | 'en') => set('customer.locale', locale),
  pushOffered: () => flag('customer.push_offered'),
  setPushOffered: () => set('customer.push_offered', '1'),
  pushRegistered: () => flag('customer.push_registered'),
  setPushRegistered: (on: boolean) =>
    on ? set('customer.push_registered', '1') : del('customer.push_registered'),
};

export const newIdempotencyKey = (): string => uuid();

export const securePassStore = {
  load: () => get('customer.pass'),
  save: (json: string) => set('customer.pass', json),
  clear: () => del('customer.pass'),
};
