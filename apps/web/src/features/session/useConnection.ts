import type { ConnectionState } from '@/api/types';
import { formatTime } from '@/lib/format';
import { useUiStore } from '@/stores/ui';

/**
 * Connection indicator state. Until the realtime channel lands (PNT-064/065) it reflects the browser's
 * connectivity; `uncertain` will come from late heartbeats (`heartbeat.uncertain_after_s`).
 */
export function useConnection(): { state: ConnectionState; lastSync: string | null } {
  const online = useUiStore((s) => s.online);
  const lastSyncAt = useUiStore((s) => s.lastSyncAt);
  return { state: online ? 'online' : 'offline', lastSync: lastSyncAt ? formatTime(lastSyncAt) : null };
}
