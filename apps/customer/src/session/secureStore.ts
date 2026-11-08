/**
 * Device storage on expo-secure-store (iOS Keychain, Android Keystore-encrypted preferences): the session tokens,
 * the install's device id, two small flags and the language chosen on C-19. Nothing here goes to AsyncStorage or
 * logs.
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { parseStoredSession, type StoredSession, type TokenStore } from './tokenStore';

const KEYS = {
  session: 'customer.session',
  deviceId: 'customer.device_id',
  welcomeSeen: 'customer.welcome_seen',
  locale: 'customer.locale',
  vehiclePrompt: (accountId: string) => `customer.vehicle_prompt.${accountId}`,
} as const;

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureTokenStore: TokenStore = {
  async load(): Promise<StoredSession | null> {
    return parseStoredSession(await SecureStore.getItemAsync(KEYS.session, options));
  },
  async save(session) {
    await SecureStore.setItemAsync(KEYS.session, JSON.stringify(session), options);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEYS.session, options);
  },
};

/** A random id per install (rate limits per device on the server, C-02); never derived from hardware ids. */
export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEYS.deviceId, options);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(KEYS.deviceId, id, options);
  return id;
}

async function flag(key: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(key, options)) === '1';
}

export const flags = {
  welcomeSeen: () => flag(KEYS.welcomeSeen),
  setWelcomeSeen: () => SecureStore.setItemAsync(KEYS.welcomeSeen, '1', options),
  vehiclePromptDone: (accountId: string) => flag(KEYS.vehiclePrompt(accountId)),
  setVehiclePromptDone: (accountId: string) =>
    SecureStore.setItemAsync(KEYS.vehiclePrompt(accountId), '1', options),
  /** C-19: the language chosen in the app (V2-017), or null to follow the device (DEC-481). */
  locale: () => SecureStore.getItemAsync(KEYS.locale, options),
  setLocale: (locale: 'ar' | 'en') => SecureStore.setItemAsync(KEYS.locale, locale, options),
};

export const newIdempotencyKey = (): string => Crypto.randomUUID();
