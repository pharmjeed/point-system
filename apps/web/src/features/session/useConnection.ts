import type { ConnectionState } from '@/api/types';
import { formatTime } from '@/lib/format';
import { useConnectionState } from '@/realtime/hooks';
import { useSyncStore } from '@/realtime/syncStore';
import { useUiStore } from '@/stores/ui';

/**
 * Connection indicator state (02 §1.3, D-15 أ/ب): offline when the browser says so or nothing confirmed the
 * connection for `heartbeat.offline_after_s`; uncertain after `heartbeat.uncertain_after_s` (07 §4.5).
 * «آخر مزامنة» is the server time of the last full snapshot (else of the last reply).
 */
export function useConnection(): { state: ConnectionState; lastSync: string | null } {
  const state = useConnectionState();
  const synced = useSyncStore((s) => s.lastSyncAt);
  const replied = useUiStore((s) => s.lastSyncAt);
  const at = synced ?? replied;
  return { state, lastSync: at ? formatTime(at) : null };
}
