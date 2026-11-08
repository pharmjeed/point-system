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
 * - a pending photo keeps its compressed bytes here until the server confirmed it — also after the intake
 *   was submitted («المتابعة دون انتظار»: 09 §6.2 accepts the upload while the ticket is `parking`, and a
 *   photo that finishes later completes the inspection, 02 D-06); the driver frame resumes those
 *   (`settleLocalIntake`) after a reload, whatever screen is open;
 * - the draft row goes when the draft ends (submitted, discarded, the ticket left `received`), a pending
 *   photo when the server confirmed or refused it or its ticket can no longer take it; every row goes at
 *   sign-out and when the session was revoked for a transfer or a disabled account (02 §1.11 «بيانات موقع
 *   سابق بعد نقل السائق … تُمسح من التخزين المحلي عند الإبطال»); a session that expired or was ended by an
 *   admin keeps them for the same user (02 §1.9, DEC-88);
 * - rows of a ticket the driver never reopens (voided by a supervisor, finished on another device) are
 *   removed by `settleLocalIntake` at the first snapshot of an app session.
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
  channel?: IntakeDraft['channel'];
  method?: IntakeDraft['method'];
  phone?: string;
  consent?: boolean;
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
/** draft id → the last time its intake ended: a hydration that started before never brings it back. */
const ended = new Map<string, number>();
let endSeq = 0;
/** Users whose local rows were settled at the first snapshot of this app session (`claimSettle`). */
const settled = new Set<string>();

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
    channel: draft.channel,
    method: draft.method,
    phone: draft.phone,
    consent: draft.consent,
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

/** A photo still worth uploading: uploading, or failed on the network or the storage (not refused). */
export const isPendingPhoto = (row: Pick<PhotoRow, 'state' | 'retriable'>): boolean =>
  row.state === 'uploading' || row.retriable;

/**
 * The draft of a ticket ends: its row goes, and its photos unless `keepPending` (the intake was submitted:
 * the pending ones still upload); a refused photo goes either way.
 */
async function removeRows(userId: string, ticketId: string, keepPending: boolean): Promise<void> {
  const id = draftId(userId, ticketId);
  clearTimeout(timers.get(id));
  timers.delete(id);
  hydrated.delete(id);
  endSeq += 1;
  ended.set(id, endSeq);
  await localDb.delete('drafts', id);
  if (!keepPending) {
    await localDb.deletePrefix('photos', `${id}:`);
    return;
  }
  for (const photo of await localDb.photosOf<PhotoRow>(id))
    if (!isPendingPhoto(photo)) await localDb.delete('photos', photo.id);
}

/** Every change of an in-memory draft is written 300 ms later; removals are explicit (`forgetIntake`). */
function follow(): void {
  if (unsubscribe) return;
  unsubscribe = useIntakeStore.subscribe((state, prev) => {
    const userId = owner;
    if (!userId) return;
    for (const ticketId of Object.keys(state.drafts)) {
      if (state.drafts[ticketId] !== prev.drafts[ticketId]) schedule(userId, ticketId);
    }
  });
}

/** The user whose rows are mirrored from now on (an intake screen, or the frame resuming photos). */
export function attachOwner(userId: string): void {
  if (owner !== userId) hydrated.clear();
  owner = userId;
  follow();
}

/**
 * Brings the saved draft of this ticket back into memory (once per app session) and returns its pending
 * photos, for the upload queue to resume. A draft already in memory wins: it is newer.
 */
export async function hydrateIntake(userId: string, ticketId: string): Promise<PhotoRow[]> {
  attachOwner(userId);
  const id = draftId(userId, ticketId);
  if (hydrated.has(id)) return [];
  hydrated.add(id);
  const epoch = ended.get(id);
  const [row, photos] = await Promise.all([
    localDb.get<DraftRow>('drafts', id),
    localDb.photosOf<PhotoRow>(id),
  ]);
  // the intake ended while reading (submitted, seen outside `received`): its memory stays empty
  if (ended.get(id) !== epoch || owner !== userId) return [];
  const store = useIntakeStore.getState();
  if (store.drafts[ticketId]) return [];
  if (!row && photos.length === 0) return [];
  store.update(ticketId, {
    plate: row?.plate,
    vehicle: row?.vehicle,
    channel: row?.channel,
    method: row?.method,
    phone: row?.phone,
    consent: row?.consent,
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
  // one read-modify-write transaction: the intent and the state of a photo are written by two callers
  await localDb.patch('photos', photoId(userId, ticketId, slot), { ...patch, savedAt: Date.now() });
}

/** The server holds the photo now: its local copy goes. */
export async function forgetPhoto(ticketId: string, slot: string): Promise<void> {
  const userId = owner;
  if (userId) await localDb.delete('photos', photoId(userId, ticketId, slot));
}

/**
 * The intake ended (submitted, discarded, no longer `received`): the draft goes, in memory and on disk.
 * `keepPendingPhotos` when the ticket goes on to `parking` (submitted, or seen in `parking`): the photos
 * still uploading stay until the server confirmed them (02 D-06); a discarded or voided ticket takes them.
 */
export async function forgetIntake(
  ticketId: string,
  options: { keepPendingPhotos: boolean } = { keepPendingPhotos: false },
): Promise<void> {
  useIntakeStore.getState().clear(ticketId);
  if (owner) await removeRows(owner, ticketId, options.keepPendingPhotos);
}

/** The photo rows of this user (the frame resumes or removes them). */
export async function userPhotos(userId: string): Promise<PhotoRow[]> {
  return (await localDb.all<PhotoRow>('photos')).filter((p) => p.userId === userId);
}

/** The draft rows of this user. */
export async function userDraftTickets(userId: string): Promise<string[]> {
  return (await localDb.all<DraftRow>('drafts')).filter((d) => d.userId === userId).map((d) => d.ticketId);
}

/** Removes the draft row of a ticket the driver never reopens (not his current intake any more). */
export async function forgetDraftRow(userId: string, ticketId: string): Promise<void> {
  if (useIntakeStore.getState().drafts[ticketId]) return; // open on screen: the intake screens decide
  const id = draftId(userId, ticketId);
  clearTimeout(timers.get(id));
  timers.delete(id);
  await localDb.delete('drafts', id);
}

/** Removes the photo rows of a ticket that can no longer take them (closed, voided, not found). */
export async function forgetTicketPhotos(userId: string, ticketId: string): Promise<void> {
  await localDb.deletePrefix('photos', `${draftId(userId, ticketId)}:`);
}

/**
 * The frame settles this user's local rows once per app session (at the first snapshot): true the first
 * time only. A sign-out or a session end lets the next session settle again.
 */
export function claimSettle(userId: string): boolean {
  if (settled.has(userId)) return false;
  settled.add(userId);
  return true;
}

/** Sign-out (02 D-14, 05 §14), or a session revoked for a transfer or a disabled account (02 §1.11). */
export async function forgetUserDrafts(userId: string | null | undefined): Promise<void> {
  if (owner === userId) owner = null;
  hydrated.clear();
  settled.clear();
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
  settled.clear();
}
