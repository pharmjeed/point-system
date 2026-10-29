import { create } from 'zustand';
import { CommandSession, type CommandIntent } from '@/api/command';
import type { IntakePatch } from '@/api/field';
import type { MediaKind } from '@/api/types';
import { useFieldStore } from '@/stores/field';
import type { PlateForm, VehicleForm } from './fieldModel';

/**
 * The open intake drafts (02 D-05, D-06). In memory they follow the screens; ./intakePersistence.ts mirrors
 * them per user and ticket into IndexedDB (300 ms after each change) and brings them back after a reload
 * (PNT-071): the D-05/D-06 inputs, the step-1 PATCH whose reply never arrived, the photo tiles (the photos
 * themselves stay in IndexedDB until the server confirmed them) and the unfinished intake commands with
 * their Idempotency-Key, so a resend after a reload is the same intent (02 §1.8 items 1, 3–4).
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

/** The intake commands whose unfinished intent survives a reload. */
export type IntakeCommand = 'step1' | 'save' | 'submit';

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
  /** The unfinished commands of this intake (key + body fingerprint). */
  intents?: Partial<Record<IntakeCommand, CommandIntent>>;
}

const EMPTY: IntakeDraft = { pendingSave: null, step1Error: null, photos: {} };

interface IntakeState {
  drafts: Record<string, IntakeDraft>;
  update: (ticketId: string, patch: Partial<IntakeDraft>) => void;
  putPhoto: (ticketId: string, photo: PhotoSlot) => void;
  patchPhoto: (ticketId: string, slot: string, patch: Partial<PhotoSlot>) => void;
  setIntent: (ticketId: string, command: IntakeCommand, intent: CommandIntent | null) => void;
  clear: (ticketId: string) => void;
  clearAll: () => void;
}

const revoke = (draft: IntakeDraft | undefined) => {
  for (const p of Object.values(draft?.photos ?? {})) if (p.src) URL.revokeObjectURL(p.src);
};

const sessions = new Map<string, CommandSession<unknown>>();
const sessionId = (ticketId: string, command: IntakeCommand) => `${ticketId}:${command}`;

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
  setIntent: (ticketId, command, intent) =>
    set((s) => {
      const draft = s.drafts[ticketId];
      if (!draft && !intent) return s;
      const intents = { ...(draft?.intents ?? {}) };
      if (intent) intents[command] = intent;
      else delete intents[command];
      return { drafts: { ...s.drafts, [ticketId]: { ...(draft ?? EMPTY), intents } } };
    }),
  clear: (ticketId) => {
    revoke(get().drafts[ticketId]);
    for (const command of ['step1', 'save', 'submit'] as const) sessions.delete(sessionId(ticketId, command));
    set((s) => {
      const { [ticketId]: _gone, ...rest } = s.drafts;
      return { drafts: rest };
    });
  },
  clearAll: () => {
    for (const d of Object.values(get().drafts)) revoke(d);
    sessions.clear();
    set({ drafts: {} });
  },
}));

export const useIntakeDraft = (ticketId: string): IntakeDraft =>
  useIntakeStore((s) => s.drafts[ticketId]) ?? EMPTY;

/**
 * The CommandSession of one intake command, shared by D-05 and D-06 (same key for the same body) and
 * resumed from the saved draft after a reload.
 */
export function intakeSession<TInput>(ticketId: string, command: IntakeCommand): CommandSession<TInput> {
  const id = sessionId(ticketId, command);
  let session = sessions.get(id) as CommandSession<TInput> | undefined;
  if (!session) {
    session = new CommandSession<TInput>({
      onIntent: (intent) => useIntakeStore.getState().setIntent(ticketId, command, intent),
    });
    session.restore(useIntakeStore.getState().drafts[ticketId]?.intents?.[command] ?? null);
    sessions.set(id, session as CommandSession<unknown>);
  }
  return session;
}

/** A draft brought back from IndexedDB: sessions created before it arrived take its intents. */
export function restoreIntents(ticketId: string, intents: IntakeDraft['intents']): void {
  for (const command of ['step1', 'save', 'submit'] as const) {
    const intent = intents?.[command];
    if (intent) sessions.get(sessionId(ticketId, command))?.restore(intent);
  }
}

/** The step-1 save of a ticket: one CommandSession for D-05 and D-06 (same key for the same body). */
export function step1Session(ticketId: string): CommandSession<IntakePatch> {
  return intakeSession<IntakePatch>(ticketId, 'step1');
}

/** Sign-out and session end clear the driver's in-memory field data (02 D-15 c, 02 §1.11). */
export function clearFieldData(): void {
  useIntakeStore.getState().clearAll();
  useFieldStore.getState().reset();
}
