import { create } from 'zustand';
import { CommandSession } from '@/api/command';
import type { IntakePatch } from '@/api/field';
import type { MediaKind } from '@/api/types';
import { useFieldStore } from '@/stores/field';
import type { PlateForm, VehicleForm } from './fieldModel';

/**
 * The open intake drafts of this app session, in memory only (02 D-05 asks for IndexedDB autosave and a
 * persistent upload queue: PNT-071). The D-05 values survive a trip to D-06 or D-04; the step-1 PATCH whose
 * reply never arrived is kept with its CommandSession, so D-06 resends it with the same Idempotency-Key
 * and body (02 §1.8 items 3–4); photo tiles keep their state while uploads run in the background.
 */
export type PhotoState = 'empty' | 'uploading' | 'uploaded' | 'failed';

export interface PhotoSlot {
  /** `photo_front` … for the mandatory angles; `photo_extra:<n>` / `photo_damage:<n>` for extras. */
  slot: string;
  kind: MediaKind;
  state: PhotoState;
  progress: number;
  /** Object URL of the compressed photo: memory only, never a signed URL (02 §1.11). */
  src?: string;
  mediaId?: string;
  error?: string;
}

export interface IntakeDraft {
  plate?: PlateForm;
  vehicle?: VehicleForm;
  paperSerial?: string;
  keyTag?: string;
  notes?: string;
  /** D-05 «التالي» sent without a reply (offline / timeout): retried from D-06. */
  pendingSave: IntakePatch | null;
  /** A business error of that retried PATCH, shown back on D-05 (02 D-06 table). */
  step1Error: { code: string; message: string } | null;
  photos: Record<string, PhotoSlot>;
}

const EMPTY: IntakeDraft = { pendingSave: null, step1Error: null, photos: {} };

interface IntakeState {
  drafts: Record<string, IntakeDraft>;
  update: (ticketId: string, patch: Partial<IntakeDraft>) => void;
  putPhoto: (ticketId: string, photo: PhotoSlot) => void;
  patchPhoto: (ticketId: string, slot: string, patch: Partial<PhotoSlot>) => void;
  clear: (ticketId: string) => void;
  clearAll: () => void;
}

const revoke = (draft: IntakeDraft | undefined) => {
  for (const p of Object.values(draft?.photos ?? {})) if (p.src) URL.revokeObjectURL(p.src);
};

const saveSessions = new Map<string, CommandSession<IntakePatch>>();

export const useIntakeStore = create<IntakeState>()((set, get) => ({
  drafts: {},
  update: (ticketId, patch) =>
    set((s) => ({ drafts: { ...s.drafts, [ticketId]: { ...(s.drafts[ticketId] ?? EMPTY), ...patch } } })),
  putPhoto: (ticketId, photo) =>
    set((s) => {
      const draft = s.drafts[ticketId] ?? EMPTY;
      const previous = draft.photos[photo.slot];
      if (previous?.src && previous.src !== photo.src) URL.revokeObjectURL(previous.src);
      return {
        drafts: { ...s.drafts, [ticketId]: { ...draft, photos: { ...draft.photos, [photo.slot]: photo } } },
      };
    }),
  patchPhoto: (ticketId, slot, patch) =>
    set((s) => {
      const draft = s.drafts[ticketId];
      const current = draft?.photos[slot];
      if (!draft || !current) return s;
      return {
        drafts: {
          ...s.drafts,
          [ticketId]: { ...draft, photos: { ...draft.photos, [slot]: { ...current, ...patch } } },
        },
      };
    }),
  clear: (ticketId) => {
    revoke(get().drafts[ticketId]);
    saveSessions.delete(ticketId);
    set((s) => {
      const { [ticketId]: _gone, ...rest } = s.drafts;
      return { drafts: rest };
    });
  },
  clearAll: () => {
    for (const d of Object.values(get().drafts)) revoke(d);
    saveSessions.clear();
    set({ drafts: {} });
  },
}));

export const useIntakeDraft = (ticketId: string): IntakeDraft =>
  useIntakeStore((s) => s.drafts[ticketId]) ?? EMPTY;

/** The step-1 save of a ticket: one CommandSession for D-05 and D-06 (same key for the same body). */
export function step1Session(ticketId: string): CommandSession<IntakePatch> {
  let session = saveSessions.get(ticketId);
  if (!session) {
    session = new CommandSession<IntakePatch>();
    saveSessions.set(ticketId, session);
  }
  return session;
}

/** Sign-out and session end clear the driver's in-memory field data (02 D-15 c, 02 §1.11). */
export function clearFieldData(): void {
  useIntakeStore.getState().clearAll();
  useFieldStore.getState().reset();
}
