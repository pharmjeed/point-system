import { useQueryClient } from '@tanstack/react-query';
import { Car, House, ServerOff, User } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useMatch, useNavigate, useOutletContext } from 'react-router';
import { recordAudioTest } from '@/api/field';
import { newIdempotencyKey } from '@/api/command';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, Me } from '@/api/types';
import { RequireDriver } from '@/app/guards';
import { hasOpenDuty, paths } from '@/app/paths';
import { AppShell, Banner, BottomNav, EmptyState, ToastViewport, TopBar, type NavItem } from '@/components';
import { useBrand } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d08, d15, live, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { runAudioTest } from '@/lib/audio';
import { usePrefs } from '@/lib/prefs';
import { useScreenWakeLock } from '@/lib/wakeLock';
import { applyUpdate, useUpdateStore } from '@/pwa/updates';
import { useRealtime } from '@/realtime/hooks';
import { heartbeatNow, requestResync } from '@/realtime/manager';
import { useSyncStore } from '@/realtime/syncStore';
import { useAudioStore } from '@/stores/audio';
import { useFieldStore, type DriverNotice } from '@/stores/field';
import { ConnectionSheet } from '@/features/session/ConnectionSheet';
import { useConnection } from '@/features/session/useConnection';
import { usePushRelink } from './deviceSetup';
import { driverPaths, offerAction } from './fieldModel';
import { claimSettle } from './intakePersistence';
import { OfferSheetBanner, useOfferAlerts } from './LiveOffer';
import { FramePromotion } from './PromotionDialog';
import { useDriverHome } from './useDriverHome';

/** Exactly three destinations for the driver (02 §1.4, 03 §3.2). */
export const DRIVER_NAV: NavItem[] = [
  { to: paths.driverHome, label: nav.home, icon: House, end: true },
  { to: paths.driverVehicles, label: nav.vehicles, icon: Car },
  { to: paths.driverAccount, label: nav.account, icon: User },
];

/**
 * The three tabs with 02 §1.4's «شارة رقمية على «الرئيسية» عند وجود طلب قابل للقبول»: the snapshot shows one
 * request at most (the oldest the driver may act on), so the badge says 1 while it can be accepted or
 * reserved.
 */
export function driverNav(home: DriverHome | undefined): NavItem[] {
  const actionable = !!home?.offer && offerAction(home.offer) !== 'none';
  return DRIVER_NAV.map((item) =>
    item.to === paths.driverHome && actionable ? { ...item, badge: 1 } : item,
  );
}

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

/**
 * The live notices of 14 §5.1 over every driver screen (driverRuntime raises them): withdrawn (red, with
 * `reminder`), canceled (no sound), the DEC-30 repark with «فتح» → D-08, the early request during parking
 * (02 D-08's sentence; on that D-08 its own banner says it). A notice whose cause is gone leaves by itself.
 */
function DriverNotices({ home }: { home: DriverHome | undefined }) {
  const navigate = useNavigate();
  const notices = useFieldStore((s) => s.notices);
  const dismiss = useFieldStore((s) => s.dismissNotice);
  const prune = useFieldStore((s) => s.pruneNotices);
  const parkMatch = useMatch('/d/tasks/:taskId/park');
  useEffect(() => {
    if (!home) return;
    const live = (taskId: string) =>
      home.current_task?.task.id === taskId || home.next_task?.task.id === taskId;
    // the repark and the early request concern a task still in the driver's hands
    prune((n) => (n.kind === 'repark' || n.kind === 'early' ? live(n.taskId) : true));
  }, [home, prune]);
  const shown = notices.filter((n) => !(n.kind === 'early' && parkMatch?.params.taskId === n.taskId));
  if (!shown.length) return null;
  const banner = (n: DriverNotice) => {
    const close = () => dismiss(n.key);
    switch (n.kind) {
      case 'withdrawn':
        return (
          <Banner
            kind="error"
            message={fmt(live.withdrawn, { n: n.ticketNumber })}
            actionLabel={buttons.gotIt}
            onAction={close}
          />
        );
      case 'canceled':
        return (
          <Banner
            kind="info"
            message={fmt(live.canceled, { n: n.ticketNumber })}
            actionLabel={buttons.gotIt}
            onAction={close}
          />
        );
      case 'repark':
        return (
          <Banner
            kind="warning"
            message={fmt(live.repark, { n: n.ticketNumber })}
            actionLabel={buttons.open}
            onAction={() => {
              close();
              navigate(driverPaths.park(n.taskId));
            }}
          />
        );
      case 'early':
        return <Banner kind="warning" message={d08.early} actionLabel={buttons.gotIt} onAction={close} />;
    }
  };
  return (
    <div data-driver-notices>
      {shown.map((n) => (
        <div key={n.key} data-notice={n.kind}>
          {banner(n)}
        </div>
      ))}
    </div>
  );
}

/**
 * 02 D-15 ح — «النظام غير متاح مؤقتًا. اتبع الإجراء الورقي حتى عودة الخدمة.» with «إعادة المحاولة», the
 * full screen while the snapshot answers SERVICE_UNAVAILABLE; the next read that succeeds (the retry, the
 * resync retries, the polling) brings the screens back with their drafts.
 */
function ServiceUnavailable() {
  const qc = useQueryClient();
  const retry = () => {
    requestResync('manual');
    return qc.refetchQueries({ queryKey: queryKeys.home, exact: true });
  };
  return (
    <section
      className="flex flex-col gap-4 py-8"
      role="alert"
      aria-live="assertive"
      data-screen="d15-service"
    >
      <EmptyState
        icon={ServerOff}
        title={d15.serviceUnavailable}
        actionLabel={buttons.retry}
        onAction={retry}
      />
    </section>
  );
}

/**
 * PNT-071: the local rows of intakes no longer open on a screen are settled at the first snapshot of an app
 * session and whenever the browser is back online — pending photos of a submitted intake upload on their
 * own, rows of tickets that can no longer take them go (./tasks/uploads.ts `settleLocalIntake`, a lazy
 * chunk).
 */
function useLocalIntake(me: Me, home: DriverHome | undefined) {
  const userId = me.user.id;
  const draft = useRef<string | null>(null);
  draft.current = home?.draft_ticket_id ?? null;
  const ready = !!home;
  useEffect(() => {
    const settle = () =>
      void import('./tasks/uploads')
        .then((m) => m.settleLocalIntake(userId, draft.current))
        .catch(() => undefined); // IndexedDB or the chunk unavailable: the next attempt
    if (ready && claimSettle(userId)) settle();
    window.addEventListener('online', settle);
    return () => window.removeEventListener('online', settle);
  }, [ready, userId]);
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
 * during a duty (PNT-068), the notices and the promotion dialog of 14 §5.1 / 02 D-04 on every screen, D-15 ح
 * and, over every screen but D-04 (where the card is inline), the request banner that opens D-09 in a Sheet
 * (02 D-09 «في Sheet فوق الشاشات الأخرى»).
 */
export function DriverFrame({ me, withNav, children }: { me: Me; withNav: boolean; children: ReactNode }) {
  const brand = useBrand();
  const connection = useConnection();
  useRealtime('driver', me);
  const home = useDriverHome().data;
  const wakeLockPref = usePrefs((s) => s.wakeLock);
  const serviceDown = useSyncStore((s) => s.serviceDown);
  const onHome = !!useMatch({ path: paths.driverHome, end: true });
  const onDuty = hasOpenDuty(me);
  useScreenWakeLock(onDuty && wakeLockPref);
  useOfferAlerts(onDuty ? home?.offer : null);
  useReportBlockedAudio(me);
  useLocalIntake(me, home);
  usePushRelink(me, home);
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
        serviceDown ? null : (
          <>
            <DriverBanners me={me} home={home} />
            {onDuty ? <DriverNotices home={home} /> : null}
            {onDuty && !onHome ? <OfferSheetBanner offer={home?.offer} /> : null}
          </>
        )
      }
      toast={<ToastViewport aboveNav={withNav && !serviceDown} />}
      bottomNav={withNav && !serviceDown ? <BottomNav items={driverNav(onDuty ? home : undefined)} /> : null}
    >
      {serviceDown ? <ServiceUnavailable /> : children}
      {serviceDown ? null : <FramePromotion />}
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
