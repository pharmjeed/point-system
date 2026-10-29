import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntakePatch } from '@/api/field';

/**
 * PNT-071: the intake drafts mirrored per user and ticket (02 D-05 «بعد 300ms تحت مفتاح خاص بالتذكرة»,
 * D-06 pending photos, 03 §4.3), on an in-memory stand-in for IndexedDB (the real database is exercised by
 * e2e/driver-persistence.spec.ts in Chromium).
 */
const rows = {
  drafts: new Map<string, Record<string, unknown>>(),
  photos: new Map<string, Record<string, unknown>>(),
};

vi.mock('@/lib/localDb', () => ({
  localDb: {
    get: async (store: 'drafts' | 'photos', id: string) => structuredClone(rows[store].get(id)),
    put: async (store: 'drafts' | 'photos', value: { id: string }) => {
      rows[store].set(value.id, structuredClone(value) as Record<string, unknown>);
    },
    delete: async (store: 'drafts' | 'photos', id: string) => {
      rows[store].delete(id);
    },
    photosOf: async (draftId: string) =>
      [...rows.photos.values()].filter((p) => p.draftId === draftId).map((p) => structuredClone(p)),
    all: async (store: 'drafts' | 'photos') => [...rows[store].values()],
    deletePrefix: async (store: 'drafts' | 'photos', prefix: string) => {
      for (const id of [...rows[store].keys()]) if (id.startsWith(prefix)) rows[store].delete(id);
    },
  },
}));

const { detachDrafts, forgetIntake, forgetUserDrafts, hydrateIntake, savePhoto, SAVE_DELAY_MS } =
  await import('@/features/driver/intakePersistence');
const { clearFieldData, step1Session, useIntakeStore } = await import('@/features/driver/intakeStore');

const DRV1 = '11111111-1111-4111-8111-111111111111';
const DRV2 = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BODY: IntakePatch = { expected_version: 1, channel: 'paper', paper_serial: '004521' };

const flush = async () => {
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 1);
};

beforeEach(() => {
  vi.useFakeTimers();
  rows.drafts.clear();
  rows.photos.clear();
});

afterEach(async () => {
  await forgetUserDrafts(DRV1);
  await forgetUserDrafts(DRV2);
  clearFieldData();
  vi.useRealTimers();
});

describe('intake drafts in IndexedDB (PNT-071)', () => {
  it('writes a draft 300 ms after the last change, under the user and the ticket', async () => {
    await hydrateIntake(DRV1, T1);
    const store = useIntakeStore.getState();
    store.update(T1, { paperSerial: '00' });
    await vi.advanceTimersByTimeAsync(200);
    store.update(T1, { paperSerial: '004521', keyTag: '57' });
    await vi.advanceTimersByTimeAsync(200);
    expect(rows.drafts.size).toBe(0); // still typing
    await flush();
    expect(rows.drafts.get(`${DRV1}:${T1}`)).toMatchObject({
      userId: DRV1,
      ticketId: T1,
      paperSerial: '004521',
      keyTag: '57',
    });
  });

  it('a reload brings the inputs, the unsent step and its key back: the same body is sent with the same key', async () => {
    await hydrateIntake(DRV1, T1);
    const sent: string[] = [];
    useIntakeStore.getState().update(T1, { paperSerial: '004521', pendingSave: BODY });
    const first = step1Session(T1);
    await expect(
      first.run(
        BODY,
        async (_, key) => {
          sent.push(key);
          throw new (await import('@/api/errors')).NetworkError('offline');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow();
    await flush();

    // reload: memory is gone, the rows stay
    detachDrafts();
    clearFieldData();
    expect(useIntakeStore.getState().drafts[T1]).toBeUndefined();
    await hydrateIntake(DRV1, T1);
    expect(useIntakeStore.getState().drafts[T1]).toMatchObject({ paperSerial: '004521', pendingSave: BODY });
    await step1Session(T1).run(BODY, async (_, key) => sent.push(key), { sleep: async () => {} });
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent).size).toBe(1);
  });

  it('a draft already in memory is newer than the saved one', async () => {
    rows.drafts.set(`${DRV1}:${T1}`, {
      id: `${DRV1}:${T1}`,
      keyTag: 'old',
      pendingSave: null,
      step1Error: null,
    });
    useIntakeStore.getState().update(T1, { keyTag: 'new' });
    await hydrateIntake(DRV1, T1);
    expect(useIntakeStore.getState().drafts[T1]?.keyTag).toBe('new');
  });

  it('the pending photos come back with their bytes and their media intent', async () => {
    await hydrateIntake(DRV1, T1);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await savePhoto(T1, {
      slot: 'photo_front',
      kind: 'photo_front',
      blob,
      capturedAt: '2026-10-29T18:00:00.000Z',
      state: 'uploading',
      retriable: true,
      intent: { key: 'k-1', print: 'p' },
    });
    detachDrafts();
    clearFieldData();
    const photos = await hydrateIntake(DRV1, T1);
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ slot: 'photo_front', intent: { key: 'k-1', print: 'p' } });
    expect(useIntakeStore.getState().drafts[T1]?.photos.photo_front).toMatchObject({
      state: 'uploading',
      kind: 'photo_front',
    });
  });

  it('a finished intake takes its rows with it; sign-out takes every row of that user only', async () => {
    await hydrateIntake(DRV1, T1);
    useIntakeStore.getState().update(T1, { keyTag: '57' });
    useIntakeStore.getState().update(T2, { keyTag: '58' });
    await flush();
    await savePhoto(T1, {
      slot: 'photo_rear',
      kind: 'photo_rear',
      blob: new Blob([new Uint8Array([9])]),
      capturedAt: '2026-10-29T18:00:00.000Z',
      state: 'failed',
      retriable: true,
      intent: null,
    });
    rows.drafts.set(`${DRV2}:${T1}`, { id: `${DRV2}:${T1}`, keyTag: 'other user' });

    await forgetIntake(T1); // submitted / discarded / no longer `received`
    expect(rows.drafts.has(`${DRV1}:${T1}`)).toBe(false);
    expect([...rows.photos.keys()]).toEqual([]);
    expect(rows.drafts.has(`${DRV1}:${T2}`)).toBe(true);

    await forgetUserDrafts(DRV1); // «تسجيل الخروج»
    expect([...rows.drafts.keys()]).toEqual([`${DRV2}:${T1}`]);
  });

  it('a session that ends by itself writes the last keystrokes now and keeps the rows (02 §1.9)', async () => {
    await hydrateIntake(DRV1, T1);
    useIntakeStore.getState().update(T1, { notes: 'خدش' });
    detachDrafts(); // before the 300 ms
    clearFieldData();
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.drafts.get(`${DRV1}:${T1}`)).toMatchObject({ notes: 'خدش' });
    await flush();
    expect(rows.drafts.has(`${DRV1}:${T1}`)).toBe(true); // the memory wipe did not delete it
  });
});
