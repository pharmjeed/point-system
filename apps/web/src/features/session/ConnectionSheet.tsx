import { useState } from 'react';
import type { ConnectionState } from '@/api/types';
import { Button, Sheet } from '@/components';
import { buttons, connectionState, connectionSheet, d03, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { notificationCheck } from '@/lib/deviceChecks';
import { useWakeLockStore, type WakeLockStatus } from '@/lib/wakeLock';
import { requestResync } from '@/realtime/manager';
import { useSyncStore } from '@/realtime/syncStore';
import { useAudioStore, type AudioStatus } from '@/stores/audio';

const AUDIO_TEXT: Record<AudioStatus, string> = {
  running: d03.audio.ok,
  blocked: d03.audio.blocked,
  locked: d03.audio.untested,
};

const WAKE_TEXT: Record<WakeLockStatus, string> = {
  active: connectionSheet.wakeActive,
  off: connectionSheet.wakeOff,
  unsupported: d03.wakeLock.unsupported,
  failed: connectionSheet.wakeFailed,
};

function Row({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <p className="m-0 flex justify-between gap-3" data-row={id}>
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </p>
  );
}

/**
 * Connection details (02 §1.3): last sync, the sound and device-notification states and, for drivers, the
 * screen wake lock (02 §1.10: its failure is shown here only), then «مزامنة الآن» — a full resync before any
 * command (02 §1.7).
 */
export function ConnectionSheet({
  open,
  onOpenChange,
  state,
  lastSync,
  driver = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConnectionState;
  lastSync: string | null;
  driver?: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const syncing = useSyncStore((s) => s.syncing || s.stale);
  const audio = useAudioStore((s) => s.status);
  const wake = useWakeLockStore((s) => s.status);
  const syncNow = () => {
    setRequested(true);
    requestResync('manual');
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={connectionState[state]}>
      {lastSync ? <p className="m-0">{fmt(ui.lastSync, { time: lastSync })}</p> : null}
      {driver ? (
        <div className="flex flex-col gap-2">
          <Row id="audio" label={d03.checks.audio} value={AUDIO_TEXT[audio]} />
          <Row
            id="notifications"
            label={d03.checks.notifications}
            value={d03.notifications[notificationCheck()]}
          />
          <Row id="wake-lock" label={d03.checks.wakeLock} value={WAKE_TEXT[wake]} />
        </div>
      ) : null}
      <Button variant="secondary" fullWidth loading={requested && syncing} onClick={syncNow}>
        {buttons.syncNow}
      </Button>
    </Sheet>
  );
}
