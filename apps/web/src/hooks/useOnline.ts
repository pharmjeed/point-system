import { useEffect } from 'react';
import { useUiStore } from '@/stores/ui';

/** Keeps `online` in the UI store in step with the browser (D-01: offline banner, button disabled). */
export function useOnlineListener(): void {
  const setOnline = useUiStore((s) => s.setOnline);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [setOnline]);
}

export function useOnline(): boolean {
  return useUiStore((s) => s.online);
}
