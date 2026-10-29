import { create } from 'zustand';

/**
 * Per-device driver preferences of D-14 (05 §14.2: preferences may live in localStorage, behind try/catch —
 * never a secret): «إبقاء الشاشة مضاءة أثناء الوردية» (on by default, 02 D-14 shows it on).
 */
const WAKE_LOCK_KEY = 'point.wakeLock.driver';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // storage blocked
  }
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0');
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

interface PrefsState {
  wakeLock: boolean;
  setWakeLock: (on: boolean) => void;
}

export const usePrefs = create<PrefsState>()((set) => ({
  wakeLock: readBool(WAKE_LOCK_KEY, true),
  setWakeLock: (wakeLock) => {
    writeBool(WAKE_LOCK_KEY, wakeLock);
    set({ wakeLock });
  },
}));
