import type { CommandIntent } from '@/api/command';
import type { MediaKind } from '@/api/types';
import { localDb } from '@/lib/localDb';
import { restoreIntents, useIntakeStore, type IntakeDraft } from './intakeStore';

/**
 * IndexedDB mirror of the intake drafts (02 D-05 «كل تعديل يُحفظ في IndexedDB بعد 300ms تحت مفتاح خاص
 * بالتذكرة، ويُستعاد عند إعادة فتح التطبيق»; 02 D-06 «الملفات المعلقة تُحفظ في IndexedDB وتُستأنف
 * تلقائيًا»; 03 §4.3; PNT-071):
 * - rows are per user and ticket, written 300 ms after the last change of the in-memory draft;
 * - a reload brings the draft back before the screen shows its form (`hydrateIntake`);
 * - a pending photo keeps its compressed bytes here until the server confirmed it;
 * - the rows go when the draft ends (submitted, discarded, the ticket left `received`) and at sign-out;
 *   a session that ends by itself keeps them for the same user (02 §1.9, DEC-88).
 * Never a session secret, a signed URL or a server copy: only what the driver typed and photographed.
 */
export const SAVE_DELAY_MS = 300;

interface DraftRow {
  id: string;
  userId: string;
  ticketId: string;
  savedAt: number;
  plate?: IntakeDraft['plate'];
  vehicle?: IntakeDraft['vehicle'];
  paperSerial?: string;
  keyTag?: string;
  notes?: string;
  pendingSave: IntakeDraft['pendingSave'];
  step1Error: IntakeDraft['step1Error'];
  intents?: IntakeDraft['intents'];
}

export interface PhotoRow {
  id: string;
  draftId: string;
  userId: string;
  ticketId: string;
  slot: string;
  kind: MediaKind;
  blob: Blob;
  capturedAt: string;
  state: 'uploading' | 'failed';
  error?: string;
  /** A network or storage failure: resumed after a reload (a photo the server refused is not). */
  retriable: boolean;
  /** The `POST /tickets/{id}/media` intent: the same photo asks again with the same key. */
  intent: CommandIntent | null;
  savedAt: number;
}

let owner: string | null = null;
const hydrated = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;

const draftId = (userId: string, ticketId: string) => `${userId}:${ticketId}`;
const photoId = (userId: string, ticketId: string, slot: string) => `${userId}:${ticketId}:${slot}`;

/** The user whose drafts are mirrored (set by the intake screens; null after a session end). */
export const currentOwner = (): string | null => owner;

function rowOf(userId: string, ticketId: string, draft: IntakeDraft): DraftRow {
  return {
    id: draftId(userId, ticketId),
    userId,
    ticketId,
    savedAt: Date.now(),
    plate: draft.plate,
    vehicle: draft.vehicle,
    paperSerial: draft.paperSerial,
    keyTag: draft.keyTag,
    notes: draft.notes,
    pendingSave: draft.pendingSave,
    step1Error: draft.step1Error,
    intents: draft.intents,
  };
}

function schedule(userId: string, ticketId: string): void {
  const id = draftId(userId, ticketId);
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      const draft = useIntakeStore.getState().drafts[ticketId];
      if (draft && owner === userId) void localDb.put('drafts', rowOf(userId, ticketId, draft));
    }, SAVE_DELAY_MS),
  );
}

async function removeRows(userId: string, ticketId: string): Promise<void> {
  const id = draftId(userId, ticketId);
  clearTimeout(timers.get(id));
  timers.delete(id);
  await localDb.delete('drafts', id);
  await localDb.deletePrefix('photos', `${id}:`);
}

function follow(): void {
  if (unsubscribe) return;
  unsubscribe = useIntakeStore.subscribe((state, prev) => {
    const userId = owner;
    if (!userId) return;
    for (const ticketId of new Set([...Object.keys(state.drafts), ...Object.keys(prev.drafts)])) {
      const next = state.drafts[ticketId];
      if (next === prev.drafts[ticketId]) continue;
      if (!next) void removeRows(userId, ticketId);
      else schedule(userId, ticketId);
    }
  });
}

/**
 * Brings the saved draft of this ticket back into memory (once per app session) and returns its pending
 * photos, for the upload queue to resume. A draft already in memory wins: it is newer.
 */
export async function hydrateIntake(userId: string, ticketId: string): Promise<PhotoRow[]> {
  if (owner !== userId) hydrated.clear();
  owner = userId;
  follow();
  const id = draftId(userId, ticketId);
  if (hydrated.has(id)) return [];
  hydrated.add(id);
  const [row, photos] = await Promise.all([
    localDb.get<DraftRow>('drafts', id),
    localDb.photosOf<PhotoRow>(id),
  ]);
  const store = useIntakeStore.getState();
  if (store.drafts[ticketId]) return [];
  if (!row && photos.length === 0) return [];
  store.update(ticketId, {
    plate: row?.plate,
    vehicle: row?.vehicle,
    paperSerial: row?.paperSerial,
    keyTag: row?.keyTag,
    notes: row?.notes,
    pendingSave: row?.pendingSave ?? null,
    step1Error: row?.step1Error ?? null,
    intents: row?.intents,
  });
  restoreIntents(ticketId, row?.intents);
  for (const p of photos)
    useIntakeStore.getState().putPhoto(ticketId, {
      slot: p.slot,
      kind: p.kind,
      state: p.state,
      progress: 0,
      src: URL.createObjectURL(p.blob),
      error: p.error,
    });
  return photos;
}

/** Keeps a compressed photo until the server confirmed it (02 D-06). */
export async function savePhoto(
  ticketId: string,
  photo: Omit<PhotoRow, 'id' | 'draftId' | 'userId' | 'ticketId' | 'savedAt'>,
): Promise<void> {
  const userId = owner;
  if (!userId) return;
  await localDb.put('photos', {
    ...photo,
    id: photoId(userId, ticketId, photo.slot),
    draftId: draftId(userId, ticketId),
    userId,
    ticketId,
    savedAt: Date.now(),
  } satisfies PhotoRow);
}

export async function updatePhoto(ticketId: string, slot: string, patch: Partial<PhotoRow>): Promise<void> {
  const userId = owner;
  if (!userId) return;
  const id = photoId(userId, ticketId, slot);
  const row = await localDb.get<PhotoRow>('photos', id);
  if (row) await localDb.put('photos', { ...row, ...patch, id, savedAt: Date.now() });
}

/** The server holds the photo now: its local copy goes. */
export async function forgetPhoto(ticketId: string, slot: string): Promise<void> {
  const userId = owner;
  if (userId) await localDb.delete('photos', photoId(userId, ticketId, slot));
}

/** The intake ended (submitted, discarded, no longer `received`): the draft goes, in memory and on disk. */
export async function forgetIntake(ticketId: string): Promise<void> {
  useIntakeStore.getState().clear(ticketId);
  if (owner) await removeRows(owner, ticketId);
}

/** Sign-out (02 D-14, 05 §14): every local draft of this user goes. */
export async function forgetUserDrafts(userId: string | null | undefined): Promise<void> {
  if (owner === userId) owner = null;
  hydrated.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (!userId) return;
  await localDb.deletePrefix('drafts', `${userId}:`);
  await localDb.deletePrefix('photos', `${userId}:`);
}

/**
 * A session that ended by itself (02 §1.9 «حفظ المسودات المحلية…», DEC-88): the changes still waiting for
 * their 300 ms are written now, then the mirror stops — the memory is cleared, the saved drafts stay.
 */
export function detachDrafts(): void {
  const userId = owner;
  if (userId)
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      const ticketId = id.slice(userId.length + 1);
      const draft = useIntakeStore.getState().drafts[ticketId];
      if (draft) void localDb.put('drafts', rowOf(userId, ticketId, draft));
    }
  timers.clear();
  owner = null;
  hydrated.clear();
}
