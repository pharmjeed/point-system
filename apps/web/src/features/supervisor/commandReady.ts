import { useOnline } from '@/hooks/useOnline';
import { useConnectionState } from '@/realtime/hooks';
import { useSyncStore, type SyncState } from '@/realtime/syncStore';

/**
 * Whether the stale/resync state blocks staff commands (02 §1.6 «إعادة المزامنة … الأوامر معطلة حتى تكتمل»,
 * §1.7): once the staff engine has completed a first sync, a later trigger (reconnection, `sync.required`, a
 * heartbeat gap, the return to the foreground) blocks every command until the resync has re-read the screens. Before
 * the first sync the shell shows no «قديم» banner either (StaffLayout), so the first read of a screen is not
 * held behind a socket that may never connect (the reads themselves are the state shown).
 */
export const staleBlocksCommands = (s: Pick<SyncState, 'stale' | 'syncing' | 'lastSyncAt'>): boolean =>
  (s.stale || s.syncing) && s.lastSyncAt !== null;

/**
 * Staff command buttons (S-02, S-03, S-04, S-07, S-10, S-12; audit A-SHELL-2): enabled only with the browser
 * online, a confirmed connection by heartbeat (not `uncertain` / `offline`, 02 §1.3, 07 §4.5) and no pending
 * resync — the same state the shell's offline / «قديم» banner shows. The server checks every command anyway.
 */
export function useStaffCommandsReady(): boolean {
  const online = useOnline();
  const connection = useConnectionState();
  const blocked = useSyncStore(staleBlocksCommands);
  return online && connection === 'online' && !blocked;
}
