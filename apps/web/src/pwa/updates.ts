import { create } from 'zustand';

/**
 * «يتوفر تحديث» (02 D-15 و, 05 §11.2 item 5): a new Service Worker finished installing while an older one
 * controls the page. The update is applied only by the user's tap (never during a running task or an unsaved
 * form — the banner is not offered then): the waiting worker is told to take over and the page reloads once
 * it controls the page.
 */
interface UpdateState {
  waiting: ServiceWorker | null;
  setWaiting: (worker: ServiceWorker | null) => void;
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  waiting: null,
  setWaiting: (waiting) => set({ waiting }),
}));

let reloading = false;

/** «تحديث الآن». */
export function applyUpdate(): void {
  const worker = useUpdateStore.getState().waiting;
  if (!worker || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  worker.postMessage({ type: 'SKIP_WAITING' });
}
