import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys } from '@/api/queryClient';
import type { ConnectionState } from '@/api/types';
import { Button, Sheet } from '@/components';
import { buttons, connectionState, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';

/**
 * Connection details (02 §1.3): last sync and «مزامنة الآن». Audio and notification status join it with
 * PNT-066 / PNT-070.
 */
export function ConnectionSheet({
  open,
  onOpenChange,
  state,
  lastSync,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConnectionState;
  lastSync: string | null;
}) {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    setSyncing(true);
    try {
      await qc.refetchQueries({ queryKey: queryKeys.me, type: 'active' });
    } finally {
      setSyncing(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={connectionState[state]}>
      {lastSync ? <p className="m-0">{fmt(ui.lastSync, { time: lastSync })}</p> : null}
      <Button variant="secondary" fullWidth loading={syncing} onClick={syncNow}>
        {buttons.syncNow}
      </Button>
    </Sheet>
  );
}
