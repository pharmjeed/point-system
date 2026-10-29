import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Screen Wake Lock, best effort (02 §1.10, 05 §15.5; PNT-068): requested while the driver works (an open
 * duty, the D-14 setting on, the page visible) and requested again whenever the page becomes visible (the
 * browser releases it when the page is hidden). A refusal or a missing API is never shown as an error: the
 * state is only listed in the connection sheet (02 §1.10 «فشل الطلب لا يظهر إلا في Sheet حالة الاتصال»).
 */
export type WakeLockStatus = 'off' | 'active' | 'unsupported' | 'failed';

interface WakeLockState {
  status: WakeLockStatus;
  setStatus: (status: WakeLockStatus) => void;
}

export const useWakeLockStore = create<WakeLockState>()((set) => ({
  status: 'off',
  setStatus: (status) => set((s) => (s.status === status ? s : { status })),
}));

interface SentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

interface WakeLockApi {
  request(type: 'screen'): Promise<SentinelLike>;
}

function wakeLockApi(): WakeLockApi | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  return api && typeof api.request === 'function' ? api : null;
}

export function useScreenWakeLock(enabled: boolean): void {
  useEffect(() => {
    const setStatus = useWakeLockStore.getState().setStatus;
    if (!enabled) {
      setStatus('off');
      return;
    }
    const api = wakeLockApi();
    if (!api) {
      setStatus('unsupported');
      return;
    }
    let sentinel: SentinelLike | null = null;
    let active = true;
    let requesting = false;
    const request = async () => {
      if (!active || requesting || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      requesting = true;
      try {
        const next = await api.request('screen');
        if (!active) {
          void next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
        setStatus('active');
        next.addEventListener?.('release', () => {
          if (active && sentinel === next) setStatus('off');
        });
      } catch {
        setStatus('failed'); // e.g. battery saver or a browser policy: listed in the sheet only
      } finally {
        requesting = false;
      }
    };
    void request();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      const held = sentinel;
      sentinel = null;
      if (held && !held.released) void held.release().catch(() => undefined);
      setStatus('off');
    };
  }, [enabled]);
}
