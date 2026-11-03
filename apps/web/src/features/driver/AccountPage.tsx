import { useQueryClient } from '@tanstack/react-query';
import { Bell, CirclePlay, KeyRound, LayoutDashboard, Smartphone, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, displayMessage, isApiError } from '@/api/errors';
import { endDuty, setBreak } from '@/api/field';
import { queryKeys } from '@/api/queryClient';
import type { CustodyItem } from '@/api/types';
import { hasOpenDuty, paths } from '@/app/paths';
import { Banner, Button, Card, Dialog, ListItem, SegmentedControl, Toggle } from '@/components';
import { FieldError } from '@/components/Field';
import { useCommand } from '@/hooks/useCommand';
import { useBrand } from '@/hooks/useMe';
import { buttons, d03, d14, d15, live, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { isStandalone } from '@/lib/deviceChecks';
import { formatHalalas, formatTime } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { THEME_PREFS, type ThemePref } from '@/lib/theme';
import { useCommandGate } from '@/realtime/hooks';
import { useLogout } from '@/features/session/useLogout';
import { useUiStore } from '@/stores/ui';
import { pushNotReaching, useAudioCheck, useNotificationSetup } from './deviceSetup';
import { useDriverMe } from './DriverLayout';
import { InstallGuideSheet } from './InstallGuideSheet';
import { useCachedHome } from './useDriverHome';

const THEME_LABEL: Record<ThemePref, string> = {
  system: d14.themeSystem,
  light: d14.themeLight,
  dark: d14.themeDark,
};

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0';

/** «مفتاح #125 · مهمة تالية #131» from DUTY_END_BLOCKED_CUSTODY `details.items` (02 D-14). */
export function custodyItemsText(items: CustodyItem[]): string {
  return items
    .map((item) => {
      const label = (d14.custodyItem as Record<string, string>)[item.type] ?? item.type;
      return item.display_number ? `${label} #${item.display_number}` : label;
    })
    .join(' · ');
}

/**
 * D-14 — حسابي (PNT-070): who and where (with the duty start time), the cash in hand when there is some (13 §9),
 * the break switch, the sound test and the device notifications (the same tap-only flows as D-03, with the Web
 * Push subscription — PNT-072), the screen wake lock setting, the «أضف إلى الشاشة الرئيسية» guide (only
 * outside the installed app), the appearance, the PIN, «إنهاء الوردية» and the sign-out. Without notifications
 * the in-page alert mode is stated plainly (AC-22).
 */
export function AccountPage() {
  const me = useDriverMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const brand = useBrand();
  const home = useCachedHome();
  const gate = useCommandGate();
  const theme = useUiStore((s) => s.themes.driver);
  const setTheme = useUiStore((s) => s.setTheme);
  const wakeLock = usePrefs((s) => s.wakeLock);
  const setWakeLock = usePrefs((s) => s.setWakeLock);
  const signOut = useLogout('driver');
  const audioCheck = useAudioCheck(me);
  const notifications = useNotificationSetup(me);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [blocked, setBlocked] = useState<CustodyItem[] | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const endShift = useCommand((_: Record<string, never>, key: string) => endDuty(key));
  const breakCmd = useCommand((body: { active: boolean }, key: string) => setBreak(body.active, key));

  const onDuty = hasOpenDuty(me);
  const duty = home?.duty_session ?? me.duty_session ?? null;
  const onBreak = (home?.driver_state ?? me.driver_state) === 'on_break' || duty?.status === 'on_break';
  const venue = home?.venue?.name_ar ?? me.active_assignment?.venue_name_ar ?? '';
  const cash = home?.cash_outstanding_halalas ?? 0;
  // «نقد بعهدتك: {المبلغ}» (02 D-14) — also in the end-of-shift dialogs (13 §8.7): it goes to the supervisor (S-10)
  const cashLine = cash > 0 ? fmt(d14.cash, { amount: formatHalalas(cash) }) : undefined;
  const b = { brand: brand.staffNameAr };
  const deviceId = me.session.device_id ?? null;
  const check = notifications.check;
  const inPageOnly = check === 'denied' || check === 'unsupported' || check === 'needsInstall';
  // permission granted, nothing stored for this device (a new sign-in, or 14 §6.6 a dropped subscription)
  const notReaching = pushNotReaching(check, home, notifications.subscribed);

  const refreshMe = () => qc.invalidateQueries({ queryKey: queryKeys.me });

  const onBreakChange = (active: boolean) => {
    breakCmd.run({ active }).then(
      () => {
        void refreshMe();
      },
      () => undefined, // the server's text is shown under the switch
    );
  };

  const runEndShift = async () => {
    try {
      await endShift.run({});
      setConfirmEnd(false);
      await refreshMe();
    } catch (error) {
      if (isApiError(error, 'DUTY_END_BLOCKED_CUSTODY')) {
        setConfirmEnd(false);
        const items = (error as ApiError).details.items;
        setBlocked(Array.isArray(items) ? (items as CustodyItem[]) : []);
      }
    }
  };

  const onLogout = () => {
    if (onDuty) setConfirmLogout(true);
    else void signOut.run();
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="page-title">
      <h1 className="pt-page-title" id="page-title">
        {d14.title}
      </h1>
      <Card>
        <p className="m-0 font-semibold">
          {me.user.full_name} · <bdi dir="ltr">{me.user.employee_code}</bdi>
        </p>
        {venue ? (
          <p className="m-0 text-sm text-text-muted">
            {onDuty && duty?.started_at
              ? fmt(d14.venueLine, { venue, time: formatTime(duty.started_at) })
              : fmt(d14.venueOnly, { venue })}
          </p>
        ) : null}
      </Card>

      {cash > 0 ? (
        <p className="m-0 font-semibold" data-row="cash">
          {fmt(d14.cash, { amount: formatHalalas(cash) })}
        </p>
      ) : null}

      {onDuty ? (
        <div className="flex flex-col gap-1">
          <Toggle
            id="break-toggle"
            label={d14.breakToggle}
            checked={onBreak}
            disabled={!gate.ready || breakCmd.pending}
            onChange={onBreakChange}
          />
          {breakCmd.error ? <FieldError id="break-error">{displayMessage(breakCmd.error)}</FieldError> : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="alerts-title">
        <h2 className="pt-section-title" id="alerts-title">
          {d14.alerts}
        </h2>
        {inPageOnly ? (
          <Banner
            kind="notifications"
            rounded
            message={live.inPageOnly}
            detail={check === 'denied' ? fmt(d15.notificationsDenied, b) : undefined}
          />
        ) : null}
        {notReaching ? (
          <Banner
            kind="notifications"
            rounded
            message={live.pushNotReaching}
            actionLabel={d14.setup}
            loading={notifications.pending}
            onAction={notifications.enable}
          />
        ) : null}
        <ul className="pt-list">
          <li className="flex flex-col gap-2 pb-3" data-row="audio">
            <ListItem
              icon={Volume2}
              title={d03.checks.audio}
              meta={
                audioCheck.audio === 'ok' && audioCheck.testedAt
                  ? `${d03.audio.ok} · ${fmt(d14.lastTest, { time: formatTime(audioCheck.testedAt) })}`
                  : {
                      untested: d03.audio.untested,
                      ok: d03.audio.ok,
                      notHeard: d03.audio.notHeard,
                      blocked: d03.audio.blocked,
                    }[audioCheck.audio]
              }
            />
            <Button variant="secondary" fullWidth iconStart={CirclePlay} onClick={audioCheck.test}>
              {d03.testAudio}
            </Button>
          </li>
          <li className="flex flex-col gap-2 pb-3" data-row="notifications">
            <ListItem icon={Bell} title={d03.checks.notifications} meta={d03.notifications[check]} />
            {check === 'off' || check === 'on' ? (
              <Button
                variant="secondary"
                fullWidth
                id="notifications-setup"
                loading={notifications.pending}
                onClick={notifications.enable}
              >
                {check === 'off' ? d03.enableNotifications : d14.setup}
              </Button>
            ) : null}
          </li>
          <li className="pb-3">
            <Toggle id="wake-lock-toggle" label={d14.wakeLock} checked={wakeLock} onChange={setWakeLock} />
          </li>
          {!isStandalone() ? (
            <li>
              <ListItem
                icon={Smartphone}
                title={fmt(d14.addToHomeLink, b)}
                onClick={() => setGuideOpen(true)}
              />
            </li>
          ) : null}
        </ul>
      </section>

      <div className="flex flex-col gap-2">
        <h2 className="pt-section-title">{d14.appearance}</h2>
        <SegmentedControl
          label={d14.appearance}
          value={theme}
          onChange={(v) => setTheme('driver', v)}
          options={THEME_PREFS.map((v) => ({ value: v, label: THEME_LABEL[v] }))}
        />
      </div>

      <ul className="pt-list">
        <li>
          <ListItem icon={KeyRound} title={d14.changeSecret} to={paths.changeSecret} />
        </li>
        {me.user.role === 'supervisor' ? (
          <li>
            <ListItem icon={LayoutDashboard} title={nav.backToOps} to={paths.ops} />
          </li>
        ) : null}
      </ul>

      {onDuty ? (
        <Button
          variant="secondary"
          fullWidth
          id="end-shift"
          disabled={!gate.ready}
          onClick={() => {
            endShift.reset();
            setConfirmEnd(true);
          }}
        >
          {d14.endShift}
        </Button>
      ) : (
        <Button variant="secondary" fullWidth onClick={() => navigate(paths.driverStart)}>
          {d03.start}
        </Button>
      )}
      <Button variant="ghost" fullWidth loading={signOut.pending} onClick={onLogout}>
        {d14.logout}
      </Button>
      <p className="m-0 text-center text-sm text-text-muted" data-row="version">
        {fmt(d14.version, { version: APP_VERSION, device: deviceId ? deviceId.slice(0, 8) : '—' })}
      </p>

      {audioCheck.dialog}
      <Dialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={d14.endShiftConfirm}
        // 13 §8.7: the cash in hand does not block the end of the shift; D-14 reminds the driver of it first
        body={cashLine}
        confirmLabel={d14.endShift}
        loading={endShift.pending}
        error={
          endShift.error && !isApiError(endShift.error, 'DUTY_END_BLOCKED_CUSTODY')
            ? displayMessage(endShift.error)
            : undefined
        }
        onConfirm={runEndShift}
        onCancel={() => setConfirmEnd(false)}
      />
      <Dialog
        open={blocked !== null}
        onOpenChange={(open) => {
          if (!open) setBlocked(null);
        }}
        title={fmt(d14.endBlocked, { items: custodyItemsText(blocked ?? []) })}
        confirmLabel={buttons.gotIt}
        hideCancel
        onConfirm={() => setBlocked(null)}
      />
      <Dialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title={d14.logoutDuringDuty}
        body={cashLine}
        confirmLabel={d14.endAndLogout}
        loading={endShift.pending || signOut.pending}
        error={endShift.error ? displayMessage(endShift.error) : undefined}
        onConfirm={async () => {
          await endShift.run({});
          await signOut.run();
        }}
        onCancel={() => setConfirmLogout(false)}
      />
      <InstallGuideSheet open={guideOpen} onOpenChange={setGuideOpen} />
    </section>
  );
}
