import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { ConnectionState } from '@/api/types';
import { readThemePref, writeThemePref, type ThemeArea, type ThemePref } from '@/lib/theme';

/** Local UI state (05 §5: zustand): toasts, theme, connectivity, last sync. */
export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  /** Text, or text with an isolated ticket number (`withTicket`, 02 §1.2). */
  message: ReactNode;
  tone: ToastTone;
  durationMs: number;
}

interface UiState {
  toasts: ToastItem[];
  pushToast: (toast: { message: ReactNode; tone?: ToastTone; durationMs?: number }) => number;
  dismissToast: (id: number) => void;

  themeArea: ThemeArea;
  themes: Record<ThemeArea, ThemePref>;
  setThemeArea: (area: ThemeArea) => void;
  setTheme: (area: ThemeArea, pref: ThemePref) => void;

  /** Browser connectivity (navigator.onLine). The realtime heartbeat adds `uncertain` in PNT-064/065. */
  online: boolean;
  setOnline: (online: boolean) => void;
  /** Server time of the last successful reply (02 §1.3 «آخر مزامنة»). */
  lastSyncAt: string | null;
  markSynced: (serverTime: string) => void;
}

let toastSeq = 0;

/** 03 §3.14: 4 s; 02 §1.6: success toasts 3 s. */
export const TOAST_MS = { default: 4000, success: 3000 } as const;

export const useUiStore = create<UiState>()((set) => ({
  toasts: [],
  pushToast: ({ message, tone = 'info', durationMs }) => {
    toastSeq += 1;
    const id = toastSeq;
    const ms = durationMs ?? (tone === 'success' ? TOAST_MS.success : TOAST_MS.default);
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, tone, durationMs: ms }] }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  themeArea: 'driver',
  themes: { driver: readThemePref('driver'), staff: readThemePref('staff') },
  setThemeArea: (themeArea) => set({ themeArea }),
  setTheme: (area, pref) => {
    writeThemePref(area, pref);
    set((s) => ({ themes: { ...s.themes, [area]: pref } }));
  },

  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  setOnline: (online) => set({ online }),
  lastSyncAt: null,
  markSynced: (lastSyncAt) => set({ lastSyncAt }),
}));

export function connectionFrom(online: boolean): ConnectionState {
  return online ? 'online' : 'offline';
}
