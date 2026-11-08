import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PNT-071, the review's critical finding: the photos of a submitted intake («المتابعة دون انتظار») stay in
 * IndexedDB until the server confirmed them and the driver frame resumes them after a reload, whatever screen
 * is open (`settleLocalIntake`); the rows of tickets the driver never reopens go (03 §4.3). On an in-memory
 * stand-in for IndexedDB and a stubbed upload path (the real database and network: driver-persistence.spec.ts).
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
    patch: async (store: 'drafts' | 'photos', id: string, patch: Record<string, unknown>) => {
      const row = rows[store].get(id);
      if (row) rows[store].set(id, { ...row, ...structuredClone(patch), id });
    },
    photosOf: async (draftId: string) =>
      [...rows.photos.values()].filter((p) => p.draftId === draftId).map((p) => structuredClone(p)),
    all: async (store: 'drafts' | 'photos') => [...rows[store].values()].map((r) => structuredClone(r)),
    deletePrefix: async (store: 'drafts' | 'photos', prefix: string) => {
      for (const id of [...rows[store].keys()]) if (id.startsWith(prefix)) rows[store].delete(id);
    },
  },
}));

const uploaded: string[] = [];
vi.mock('@/api/field', async (original) => ({
  ...(await original<typeof import('@/api/field')>()),
  requestUpload: vi.fn(async (ticketId: string, body: { kind: string }) => ({
    media: { id: `media-${ticketId}-${body.kind}` },
    upload: { method: 'PUT', url: 'https://storage.test/x', headers: {} },
  })),
  putToStorage: vi.fn(async () => undefined),
  completeMedia: vi.fn(async (mediaId: string) => {
    uploaded.push(mediaId);
    return { id: mediaId, upload_status: 'uploaded' };
  }),
}));

const { forgetUserDrafts } = await import('@/features/driver/intakePersistence');
const { settleLocalIntake } = await import('@/features/driver/tasks/uploads');
const { clearFieldData } = await import('@/features/driver/intakeStore');

const DRV1 = '11111111-1111-4111-8111-111111111111';
const DRV2 = '22222222-2222-4222-8222-222222222222';
const CURRENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARKING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLOSED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNREADABLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function draftRow(userId: string, ticketId: string) {
  rows.drafts.set(`${userId}:${ticketId}`, { id: `${userId}:${ticketId}`, userId, ticketId, keyTag: '57' });
}

function photoRow(
  userId: string,
  ticketId: string,
  kind: string,
  state: 'uploading' | 'failed' = 'uploading',
  retriable = true,
) {
  const id = `${userId}:${ticketId}:${kind}`;
  rows.photos.set(id, {
    id,
    draftId: `${userId}:${ticketId}`,
    userId,
    ticketId,
    slot: kind,
    kind,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    capturedAt: '2026-10-29T18:00:00.000Z',
    state,
    retriable,
    intent: null,
    savedAt: 0,
  });
}

const STATUS: Record<string, string | null> = {
  [PARKING]: 'parking',
  [CLOSED]: 'delivered',
};

const ticketStatus = vi.fn(async (ticketId: string) => {
  if (ticketId === UNREADABLE) throw new Error('offline');
  return STATUS[ticketId] ?? null;
});

beforeEach(() => {
  rows.drafts.clear();
  rows.photos.clear();
  uploaded.length = 0;
  ticketStatus.mockClear();
});

afterEach(async () => {
  await forgetUserDrafts(DRV1);
  clearFieldData();
});

describe('settleLocalIntake (the driver frame, first snapshot of an app session)', () => {
  it('uploads the photos of a submitted intake that is `parking`, then forgets them', async () => {
    photoRow(DRV1, PARKING, 'photo_right'); // «المتابعة دون انتظار», then a reload
    photoRow(DRV1, PARKING, 'photo_rear', 'failed', true); // dropped on the network before the reload
    photoRow(DRV1, PARKING, 'photo_left', 'failed', false); // refused: nobody will show it any more
    await settleLocalIntake(DRV1, null, { ticketStatus });
    await vi.waitFor(() =>
      expect(uploaded.sort()).toEqual([`media-${PARKING}-photo_rear`, `media-${PARKING}-photo_right`]),
    );
    await vi.waitFor(() => expect([...rows.photos.keys()]).toEqual([]));
  });

  it("removes the rows of tickets the driver never reopens; keeps the current intake's and an unreadable one's", async () => {
    draftRow(DRV1, CURRENT);
    draftRow(DRV1, CLOSED); // voided by a supervisor / finished on another device
    draftRow(DRV2, CLOSED); // another user of this browser: untouched
    photoRow(DRV1, CURRENT, 'photo_front'); // D-05/D-06 resume those
    photoRow(DRV1, CLOSED, 'photo_front');
    photoRow(DRV1, UNREADABLE, 'photo_front');
    await settleLocalIntake(DRV1, CURRENT, { ticketStatus });
    expect([...rows.drafts.keys()].sort()).toEqual([`${DRV1}:${CURRENT}`, `${DRV2}:${CLOSED}`].sort());
    expect([...rows.photos.keys()].sort()).toEqual(
      [`${DRV1}:${CURRENT}:photo_front`, `${DRV1}:${UNREADABLE}:photo_front`].sort(),
    );
    expect(ticketStatus).not.toHaveBeenCalledWith(CURRENT);
    expect(uploaded).toEqual([]);
  });
});
