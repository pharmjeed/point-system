import { describe, expect, it } from 'vitest';
import { staleBlocksCommands } from '@/features/supervisor/commandReady';

/** Audit A-SHELL-2 (02 §1.6, §1.7): staff commands wait for the resync once a first sync has completed. */
describe('staff commands and the stale / resync state', () => {
  const synced = '2026-11-03T18:00:00.000Z';
  it('blocks while stale or resyncing after a first sync', () => {
    expect(staleBlocksCommands({ stale: true, syncing: false, lastSyncAt: synced })).toBe(true);
    expect(staleBlocksCommands({ stale: false, syncing: true, lastSyncAt: synced })).toBe(true);
  });
  it('does not block a synced screen', () => {
    expect(staleBlocksCommands({ stale: false, syncing: false, lastSyncAt: synced })).toBe(false);
  });
  it('does not hold the first reads behind a socket that never connected (no «قديم» banner either)', () => {
    expect(staleBlocksCommands({ stale: true, syncing: false, lastSyncAt: null })).toBe(false);
    expect(staleBlocksCommands({ stale: true, syncing: true, lastSyncAt: null })).toBe(false);
  });
});
