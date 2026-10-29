import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import type { Alert, Me } from '@/api/types';
import { Banner } from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { staff } from '@/i18n/ar.staff';
import { AlertSoundController, htmlAudioPlayer, SOUND_FILES } from './alertSound';
import { can } from './permissions';
import { fetchAlerts, LIVE_REFETCH_MS, staffKeys, type AlertFilters } from './staffApi';

/**
 * «التشغيل» destination (02 §1.4: S-02 and its S-03, S-04, S-12). A pathless layout under the staff shell that
 * keeps the live alert list and the supervisor alert sound (14 §7) running while the supervisor moves between
 * these screens. The audio unlock is in memory only: after a reload the banner asks for the tap again
 * (autoplay rules, 02 §1.10).
 */

export const LIVE_ALERT_FILTERS: AlertFilters = { status: ['open', 'acknowledged'] };

interface AlertSoundContextValue {
  enabled: boolean;
  enable: () => void;
}

const AlertSoundContext = createContext<AlertSoundContextValue>({
  enabled: false,
  enable: () => undefined,
});

export const useAlertSound = () => useContext(AlertSoundContext);

/** Live alerts of the scope (every venue), refreshed with the board (15 §11.1). */
export function useLiveAlerts(me: Me) {
  return useQuery({
    queryKey: staffKeys.alerts(LIVE_ALERT_FILTERS),
    queryFn: ({ signal }) => fetchAlerts(LIVE_ALERT_FILTERS, signal),
    enabled: can(me, 'alert.read'),
    refetchInterval: LIVE_REFETCH_MS,
  });
}

export function OpsArea() {
  const me = useStaffMe();
  const alerts = useLiveAlerts(me);
  const [enabled, setEnabled] = useState(false);
  const players = useMemo(
    () => ({
      escalation: htmlAudioPlayer(SOUND_FILES.escalation),
      reminder: htmlAudioPlayer(SOUND_FILES.reminder),
      test: htmlAudioPlayer(SOUND_FILES.test),
    }),
    [],
  );
  const controller = useRef<AlertSoundController | null>(null);
  if (!controller.current)
    controller.current = new AlertSoundController({
      escalation: players.escalation,
      reminder: players.reminder,
      // the browser refused to play again: back to the unlock banner
      onBlocked: () => setEnabled(false),
    });

  const items: Alert[] | undefined = alerts.data?.items;
  useEffect(() => {
    if (items) controller.current?.sync(items);
  }, [items]);

  useEffect(
    () => () => {
      controller.current?.disable();
    },
    [],
  );

  // inside the click handler: the user gesture that unlocks audio (D-15 د: plays `test`); the alert sounds are
  // primed in the same gesture so a timer may play them later
  const enable = useCallback(() => {
    const primed = Promise.all([players.escalation.prime(), players.reminder.prime()]);
    void players.test.play().then(async (ok) => {
      if (!ok) return;
      await primed;
      setEnabled(true);
      controller.current?.enable();
    });
  }, [players]);

  const value = useMemo(() => ({ enabled, enable }), [enabled, enable]);
  return (
    <AlertSoundContext.Provider value={value}>
      <Outlet context={me} />
    </AlertSoundContext.Provider>
  );
}

/** «تفعيل صوت التنبيهات» at the top of S-02 / S-04 until audio is on (02 S-01, S-02; D-15 د). */
export function AlertSoundBanner() {
  const { enabled, enable } = useAlertSound();
  if (enabled) return null;
  return <Banner kind="audio" rounded actionLabel={staff.enableAlertSound} onAction={enable} />;
}
