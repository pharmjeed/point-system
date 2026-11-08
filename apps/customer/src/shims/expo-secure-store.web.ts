/**
 * Web stand-in for expo-secure-store, used only by the one web export (`export:web`: the e2e suite V2-018 and the
 * store screenshots V2-052; DEC-551 as unified in DEC-568): metro.config.js maps `expo-secure-store` here for
 * `platform === 'web'`; iOS and Android keep the Keychain / Keystore module untouched, and ../session/secureStore.ts
 * stays the one place of the keys. expo-secure-store has no web implementation (every call throws), and nothing may
 * go to localStorage, sessionStorage or cookies either, so values live in memory for the page's lifetime — the same
 * lifetime as the in-memory fake backend the export runs against (a reload starts a fresh install).
 */
export type SecureStoreOptions = { keychainAccessible?: number; keychainService?: string };

export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 0;

const values = new Map<string, string>();

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

export async function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
  return values.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
  values.set(key, value);
}

export async function deleteItemAsync(key: string, _options?: SecureStoreOptions): Promise<void> {
  values.delete(key);
}
