import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  CircleCheck,
  CircleSlash,
  MapPin,
  Smartphone,
  Sun,
  TriangleAlert,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { startDuty } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { DriverHome, Me } from '@/api/types';
import { RequireDriver } from '@/app/guards';
import { hasOpenDuty, paths } from '@/app/paths';
import { Banner, Button, Card, Dialog, EmptyState, ListItem, Skeleton } from '@/components';
import { LoadError } from '@/features/common/QueryView';
import { StateChip, type ChipTone } from '@/features/common/StateChip';
import { useLogout } from '@/features/session/useLogout';
import { useCommand } from '@/hooks/useCommand';
import { useBrand } from '@/hooks/useMe';
import { useCommandGate } from '@/realtime/hooks';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d03 } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { wakeLockSupported, type NotificationCheck } from '@/lib/deviceChecks';
import { formatTime } from '@/lib/format';
import type { AudioCheck } from '@/stores/field';
import { useAudioCheck, useNotificationSetup } from './deviceSetup';
import { DriverFrame } from './DriverLayout';
import { intakeEvents } from './fieldModel';
import { InstallGuideSheet } from './InstallGuideSheet';
import { useDriverHome } from './useDriverHome';

/**
 * D-03 — بدء الوردية واختبار الصوت: assignment, shift and open events from `GET /v1/me/home`, the device
 * checklist (audio test, notifications with the Web Push subscription, screen wake lock — ./deviceSetup.tsx,
 * shared with D-14) and «بدء الوردية» (`POST /v1/me/duty/start`).
 */
export function StartShiftPage() {
  useThemeArea('driver');
  return (
    <RequireDriver>
      {(me) =>
        hasOpenDuty(me) ? (
          <Navigate to={paths.driverHome} replace />
        ) : (
          <DriverFrame me={me} withNav={false}>
            <StartShift me={me} />
          </DriverFrame>
        )
      }
    </RequireDriver>
  );
}

const AUDIO_CHIP: Record<AudioCheck, [ChipTone, LucideIcon]> = {
  untested: ['neutral', Volume2],
  ok: ['success', CircleCheck],
  notHeard: ['warning', TriangleAlert],
  blocked: ['danger', VolumeX],
};

const NOTIFICATION_CHIP: Record<NotificationCheck, [ChipTone, LucideIcon]> = {
  off: ['neutral', BellOff],
  on: ['success', CircleCheck],
  denied: ['danger', BellOff],
  unsupported: ['neutral', CircleSlash],
  needsInstall: ['warning', Smartphone],
};

const AUDIO_TEXT: Record<AudioCheck, string> = {
  untested: d03.audio.untested,
  ok: d03.audio.ok,
  notHeard: d03.audio.notHeard,
  blocked: d03.audio.blocked,
};

const NOTIFICATION_TEXT: Record<NotificationCheck, string> = {
  off: d03.notifications.off,
  on: d03.notifications.on,
  denied: d03.notifications.denied,
  unsupported: d03.notifications.unsupported,
  needsInstall: d03.notifications.needsInstall,
};

function CheckRow({
  n,
  icon,
  title,
  chip,
  children,
}: {
  n: number;
  icon: LucideIcon;
  title: string;
  chip: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 pb-3" data-check={n}>
      <ListItem icon={icon} title={`${n} · ${title}`} trailing={chip} />
      {children ? <div className="flex flex-col gap-2 px-4">{children}</div> : null}
    </li>
  );
}

function StartShift({ me }: { me: Me }) {
  const brand = useBrand();
  // 02 §1.6/§1.7: offline or stale data → commands wait (PNT-065)
  const gate = useCommandGate();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signOut = useLogout('driver');
  const home = useDriverHome({ poll: false });
  const { audio, test: onTestAudio, dialog: heardDialog } = useAudioCheck(me);
  const notificationSetup = useNotificationSetup(me);
  const notifications = notificationSetup.check;
  const [untestedOpen, setUntestedOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const deviceId = me.session.device_id ?? null;

  const start = useCommand((body: { device_id?: string | null }, key: string) => startDuty(body, key));

  const runStart = async () => {
    try {
      await start.run(deviceId ? { device_id: deviceId } : {});
    } catch (error) {
      // the shift closed since the last read: re-read it so the card shows the 02 D-03 state + «تحديث»
      if (isApiError(error, 'SHIFT_NOT_OPEN', 'ASSIGNMENT_REQUIRED')) void home.refetch();
      if (!isApiError(error, 'DUTY_ALREADY_STARTED')) return; // shown under the button
    }
    await qc.invalidateQueries({ queryKey: queryKeys.me });
    navigate(paths.driverHome, { replace: true });
  };

  const onStart = () => {
    if (audio !== 'ok') {
      setUntestedOpen(true);
      return;
    }
    return runStart();
  };

  if (home.error && !(home.error instanceof ApiError && home.error.is('ASSIGNMENT_REQUIRED'))) {
    return <LoadError error={home.error} onRetry={() => void home.refetch()} />;
  }
  const noAssignment =
    (home.error instanceof ApiError && home.error.is('ASSIGNMENT_REQUIRED')) ||
    (!!home.data && !home.data.venue && !me.active_assignment);
  const venue = home.data?.venue?.name_ar ?? me.active_assignment?.venue_name_ar ?? '';
  const shiftOpen = home.data?.shift_open ?? false;
  const [audioTone, audioIcon] = AUDIO_CHIP[audio];
  const [notifTone, notifIcon] = NOTIFICATION_CHIP[notifications];
  const wake = wakeLockSupported();

  return (
    <section className="flex flex-col gap-4" aria-labelledby="page-title">
      <h1 className="pt-page-title" id="page-title">
        {d03.title}
      </h1>
      {noAssignment ? (
        <EmptyState icon={MapPin} title={d03.noAssignment} />
      ) : home.data ? (
        <AssignmentCard home={home.data} venue={venue} onRefresh={() => home.refetch()} />
      ) : (
        <Skeleton />
      )}

      <ul className="pt-list" aria-label={d03.title}>
        <CheckRow
          n={1}
          icon={Volume2}
          title={d03.checks.audio}
          chip={<StateChip label={AUDIO_TEXT[audio]} tone={audioTone} icon={audioIcon} />}
        >
          {audio === 'notHeard' ? <p className="m-0 text-sm text-text-muted">{d03.notHeardHint}</p> : null}
          <Button variant="secondary" fullWidth id="audio-test" onClick={onTestAudio}>
            {d03.testAudio}
          </Button>
        </CheckRow>
        <CheckRow
          n={2}
          icon={Bell}
          title={d03.checks.notifications}
          chip={<StateChip label={NOTIFICATION_TEXT[notifications]} tone={notifTone} icon={notifIcon} />}
        >
          {notifications === 'denied' ? (
            <p className="m-0 text-sm text-text-muted">{d03.deniedHint}</p>
          ) : null}
          {notifications === 'off' ? (
            <Button
              variant="secondary"
              fullWidth
              id="notifications-enable"
              loading={notificationSetup.pending}
              onClick={notificationSetup.enable}
            >
              {d03.enableNotifications}
            </Button>
          ) : null}
          {notifications === 'needsInstall' ? (
            <Button variant="secondary" fullWidth onClick={() => setGuideOpen(true)}>
              {d03.how}
            </Button>
          ) : null}
        </CheckRow>
        <CheckRow
          n={3}
          icon={Sun}
          title={d03.checks.wakeLock}
          chip={
            wake ? (
              <StateChip label={d03.wakeLock.supported} tone="success" icon={CircleCheck} />
            ) : (
              <StateChip label={d03.wakeLock.unsupported} tone="neutral" icon={CircleSlash} />
            )
          }
        />
      </ul>

      <Banner kind="info" rounded message={fmt(d03.notificationsBanner, { brand: brand.staffNameAr })} />
      <Button
        size="lg"
        loading={start.pending}
        disabled={!gate.ready || noAssignment || !home.data || !shiftOpen}
        error={
          start.error && !isApiError(start.error, 'DUTY_ALREADY_STARTED')
            ? displayMessage(start.error)
            : undefined
        }
        id="duty-start"
        onClick={onStart}
      >
        {d03.start}
      </Button>
      <Button variant="ghost" fullWidth loading={signOut.pending} onClick={() => signOut.run()}>
        {d03.logout}
      </Button>

      {heardDialog}
      <Dialog
        open={untestedOpen}
        onOpenChange={setUntestedOpen}
        title={d03.untestedConfirm}
        confirmLabel={d03.startWithoutTest}
        cancelLabel={d03.testNow}
        onConfirm={() => {
          setUntestedOpen(false);
          void runStart();
        }}
        onCancel={() => {
          setUntestedOpen(false);
          onTestAudio();
        }}
        onDismiss={() => setUntestedOpen(false)}
      />
      <InstallGuideSheet open={guideOpen} onOpenChange={setGuideOpen} />
    </section>
  );
}

function AssignmentCard({
  home,
  venue,
  onRefresh,
}: {
  home: DriverHome;
  venue: string;
  onRefresh: () => Promise<unknown>;
}) {
  const shiftSince = home.shift?.opened_at;
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="m-0 font-semibold">{fmt(d03.assignment, { venue })}</p>
        {home.shift_open ? (
          <p className="m-0">
            {shiftSince ? fmt(d03.shiftOpenSince, { time: formatTime(shiftSince) }) : d03.shiftOpen}
          </p>
        ) : (
          <>
            <p className="m-0 text-danger-text" role="status">
              {fmt(d03.shiftNotOpen, { venue })}
            </p>
            <Button variant="secondary" onClick={onRefresh}>
              {buttons.refresh}
            </Button>
          </>
        )}
        {intakeEvents(home).length > 0 ? (
          <p className="m-0 text-sm text-text-muted">
            {fmt(d03.openEvents, {
              events: intakeEvents(home)
                .map((e) => e.name_ar)
                .join('، '),
            })}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
