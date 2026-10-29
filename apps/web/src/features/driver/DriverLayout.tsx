import { Car, House, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import { recordAudioTest } from '@/api/field';
import { newIdempotencyKey } from '@/api/command';
import type { DriverHome, Me } from '@/api/types';
import { RequireDriver } from '@/app/guards';
import { hasOpenDuty, paths } from '@/app/paths';
import { AppShell, Banner, BottomNav, ToastViewport, TopBar, type NavItem } from '@/components';
import { useBrand } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d15, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { runAudioTest } from '@/lib/audio';
import { usePrefs } from '@/lib/prefs';
import { useScreenWakeLock } from '@/lib/wakeLock';
import { applyUpdate, useUpdateStore } from '@/pwa/updates';
import { useRealtime } from '@/realtime/hooks';
import { heartbeatNow, requestResync } from '@/realtime/manager';
import { useSyncStore } from '@/realtime/syncStore';
import { useAudioStore } from '@/stores/audio';
import { ConnectionSheet } from '@/features/session/ConnectionSheet';
import { useConnection } from '@/features/session/useConnection';
import { OfferSheetBanner, useOfferAlerts } from './LiveOffer';
import { useDriverHome } from './useDriverHome';

/** Exactly three destinations for the driver (02 §1.4, 03 §3.2). */
export const DRIVER_NAV: NavItem[] = [
  { to: paths.driverHome, label: nav.home, icon: House, end: true },
  { to: paths.driverVehicles, label: nav.vehicles, icon: Car },
  { to: paths.driverAccount, label: nav.account, icon: User },
];

/** WhatsApp health from `channel.status` when newer than the snapshot's `channel_health` (07 §4.3). */
function useChannelHealth(home: DriverHome | undefined) {
  const channel = useSyncStore((s) => s.channel);
  if (channel && (!home || Date.parse(channel.changedAt) >= Date.parse(home.server_time)))
    return channel.health;
  return home?.channel_health ?? channel?.health ?? 'healthy';
}

/**
 * The D-15 banners over every driver screen (02 D-15 أ، د، ز، و; PNT-068): offline (with the time of the data
 * on screen) or the thin «جارٍ المزامنة…» strip while a resync is pending; sound off during a duty («الصوت
 * متوقف — اضغط هنا لتفعيله.»: the tap resumes the AudioContext and plays `test`); WhatsApp down
 * (`channel.status`); an app update (applied only by a tap, never during a task or an unsaved form).
 */
function DriverBanners({ me, home }: { me: Me; home: DriverHome | undefined }) {
  const connection = useConnection();
  const stale = useSyncStore((s) => s.stale);
  const audio = useAudioStore((s) => s.status);
  const waiting = useUpdateStore((s) => s.waiting);
  const health = useChannelHealth(home);
  const onDuty = hasOpenDuty(me);
  const busy = !!home?.current_task || !!home?.draft_ticket_id;
  const [enabling, setEnabling] = useState(false);
  const enableAudio = () => {
    setEnabling(true);
    // synchronous up to runAudioTest(): the AudioContext resumes inside the tap (02 D-15 د)
    void runAudioTest().finally(() => {
      setEnabling(false);
      heartbeatNow(); // audio_unlocked changed
    });
  };
  return (
    <>
      {connection.state === 'offline' ? (
        <Banner
          kind="offline"
          message={fmt(d15.offline, { time: connection.lastSync ?? '—' })}
          detail={d15.offlineDetail}
          actionLabel={buttons.retry}
          onAction={() => requestResync('manual')}
        />
      ) : stale && home ? (
        <Banner kind="stale" />
      ) : null}
      {onDuty && audio !== 'running' ? (
        <Banner kind="audio" message={d15.audio} loading={enabling} onAction={enableAudio} />
      ) : null}
      {health === 'down' ? <Banner kind="whatsapp" /> : null}
      {waiting && !busy ? <Banner kind="update" onAction={applyUpdate} /> : null}
    </>
  );
}

/** 14 §7 rule 2: a sound that was due on a stopped AudioContext is recorded once as `blocked`. */
function useReportBlockedAudio(me: Me) {
  const status = useAudioStore((s) => s.status);
  const reported = useRef(false);
  const deviceId = me.session.device_id ?? null;
  useEffect(() => {
    if (status !== 'blocked' || reported.current || !deviceId || !hasOpenDuty(me)) return;
    reported.current = true;
    void recordAudioTest({ device_id: deviceId, result: 'blocked' }, newIdempotencyKey()).catch(() => {
      reported.current = false;
    });
  }, [status, deviceId, me]);
}

/**
 * TopBar + D-15 banners + content (+ BottomNav). D-03 and the task screens (D-05 … D-11) use it without the
 * navigation. The frame owns the live parts of the driver app: the realtime connection (PNT-065), the home
 * snapshot every driver screen reads, the sounds of the head request (PNT-066/067), the screen wake lock
 * during a duty (PNT-068) and, over the task screens, the request banner that opens D-09 in a Sheet.
 */
export function DriverFrame({ me, withNav, children }: { me: Me; withNav: boolean; children: ReactNode }) {
  const brand = useBrand();
  const connection = useConnection();
  useRealtime('driver', me);
  const home = useDriverHome().data;
  const wakeLockPref = usePrefs((s) => s.wakeLock);
  const onDuty = hasOpenDuty(me);
  useScreenWakeLock(onDuty && wakeLockPref);
  useOfferAlerts(onDuty ? home?.offer : null);
  useReportBlockedAudio(me);
  const [sheetOpen, setSheetOpen] = useState(false);
  const title = home?.venue?.name_ar || me.active_assignment?.venue_name_ar || brand.staffNameAr;
  return (
    <AppShell
      topBar={
        <TopBar
          title={title}
          driverState={home?.driver_state ?? me.driver_state ?? 'off_duty'}
          connection={connection.state}
          lastSync={connection.lastSync}
          onConnectionClick={() => setSheetOpen(true)}
        />
      }
      banner={
        <>
          <DriverBanners me={me} home={home} />
          {!withNav && onDuty ? <OfferSheetBanner offer={home?.offer} /> : null}
        </>
      }
      toast={<ToastViewport aboveNav={withNav} />}
      bottomNav={withNav ? <BottomNav items={DRIVER_NAV} /> : null}
    >
      {children}
      <ConnectionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        state={connection.state}
        lastSync={connection.lastSync}
        driver
      />
    </AppShell>
  );
}

/** `/d/*` — the driver shell with three tabs; pages read the user with `useDriverMe()`. */
export function DriverLayout() {
  useThemeArea('driver');
  return (
    <RequireDriver>
      {(me) => (
        <DriverFrame me={me} withNav>
          <Outlet context={me} />
        </DriverFrame>
      )}
    </RequireDriver>
  );
}

/** The task screens D-05 … D-11: same TopBar, no BottomNav (02 §3 wireframes), a Header per screen. */
export function DriverTaskLayout() {
  useThemeArea('driver');
  return (
    <RequireDriver>
      {(me) => (
        <DriverFrame me={me} withNav={false}>
          <Outlet context={me} />
        </DriverFrame>
      )}
    </RequireDriver>
  );
}

export function useDriverMe(): Me {
  return useOutletContext<Me>();
}
