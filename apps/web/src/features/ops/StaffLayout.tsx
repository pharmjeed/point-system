import { Activity, Bell, Building2, CarFront, ChartColumn, Menu, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import type { Me } from '@/api/types';
import { RequireStaff } from '@/app/guards';
import { canAdmin, canUseDriverShell, paths } from '@/app/paths';
import {
  Banner,
  BottomNav,
  Button,
  IconButton,
  ListItem,
  SegmentedControl,
  Sheet,
  SideNav,
  StaffShell,
  ToastViewport,
  TopBar,
  type NavItem,
} from '@/components';
import { ConnectionSheet } from '@/features/session/ConnectionSheet';
import { useNotificationSetup, usePushRelink } from '@/features/session/pushSetup';
import { useConnection } from '@/features/session/useConnection';
import { useLogout } from '@/features/session/useLogout';
import { useBrand } from '@/hooks/useMe';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons, d03, d14, d15, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { THEME_PREFS, type ThemePref } from '@/lib/theme';
import { useRealtime } from '@/realtime/hooks';
import { requestResync } from '@/realtime/manager';
import { useSyncStore } from '@/realtime/syncStore';
import { useUiStore } from '@/stores/ui';

/** The four staff destinations (02 §1.4); «الإدارة» is added for whoever holds its permissions. */
export const STAFF_NAV: NavItem[] = [
  { to: paths.ops, label: nav.ops, icon: Activity },
  { to: paths.drivers, label: nav.drivers, icon: Users },
  { to: paths.venues, label: nav.venues, icon: Building2 },
  { to: paths.reports, label: nav.reports, icon: ChartColumn },
];

const THEME_LABEL: Record<ThemePref, string> = {
  system: d14.themeSystem,
  light: d14.themeLight,
  dark: d14.themeDark,
};

/**
 * «إشعارات الجهاز» in the staff menu (realtime:RT-5, DEC-PROPOSED-4 of int-web): the server pushes critical
 * alerts (`escalation`, 14 §6.1) to supervisors, admins and the owner, and the only subscription path was
 * the driver shell. The same tap-driven setup as D-03 / D-14: the permission is asked inside the tap, the
 * subscription goes to the session's device; the texts are D-03's and D-14's.
 */
function StaffNotifications({ me }: { me: Me }) {
  const brand = useBrand();
  const setup = useNotificationSetup(me, 'account');
  const check = setup.check;
  const hint =
    check === 'denied'
      ? d03.deniedHint
      : check === 'needsInstall'
        ? fmt(d14.guide.iphoneNote, { brand: brand.staffNameAr })
        : null;
  return (
    <div className="flex flex-col gap-2" data-row="notifications">
      <ListItem icon={Bell} title={d03.checks.notifications} meta={d03.notifications[check]} />
      {hint ? <p className="m-0 text-sm text-text-muted">{hint}</p> : null}
      {check === 'off' || check === 'on' ? (
        <Button
          variant="secondary"
          fullWidth
          id="staff-notifications-setup"
          loading={setup.pending}
          onClick={setup.enable}
        >
          {check === 'off' ? d03.enableNotifications : d14.setup}
        </Button>
      ) : null}
    </div>
  );
}

function StaffMenu({
  me,
  open,
  onOpenChange,
}: {
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const theme = useUiStore((s) => s.themes.staff);
  const setTheme = useUiStore((s) => s.setTheme);
  const signOut = useLogout('staff');
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={nav.menu}>
      <StaffNotifications me={me} />
      <div className="flex flex-col gap-2">
        <span className="pt-section-title">{d14.appearance}</span>
        <SegmentedControl
          label={d14.appearance}
          value={theme}
          onChange={(v) => setTheme('staff', v)}
          options={THEME_PREFS.map((v) => ({ value: v, label: THEME_LABEL[v] }))}
        />
      </div>
      {canAdmin(me) || canUseDriverShell(me) ? (
        <ul className="pt-list">
          {canAdmin(me) ? (
            <li>
              <ListItem icon={ShieldCheck} title={nav.admin} to={paths.admin} />
            </li>
          ) : null}
          {canUseDriverShell(me) ? (
            <li>
              <ListItem icon={CarFront} title={nav.switchToDriver} to={paths.driverStart} />
            </li>
          ) : null}
        </ul>
      ) : null}
      <Button variant="secondary" fullWidth loading={signOut.pending} onClick={() => signOut.run()}>
        {nav.logout}
      </Button>
    </Sheet>
  );
}

/** `/ops`, `/drivers`, `/venues`, `/reports`, `/admin` — supervisor/admin/owner shell (light by default). */
export function StaffLayout() {
  useThemeArea('staff');
  return <RequireStaff>{(me) => <StaffFrame me={me} />}</RequireStaff>;
}

function StaffFrame({ me }: { me: Me }) {
  const brand = useBrand();
  const connection = useConnection();
  // live updates of the staff screens (PNT-065): the open screens' React Query keys follow the events
  useRealtime('staff', me);
  useTelemetry(me); // 15 §8 measurements of this session (decisions:F5)
  // a new sign-in links a new device row: the subscription this browser holds goes to it, no prompt (RT-5)
  usePushRelink(me, true);
  const stale = useSyncStore((s) => s.stale && s.lastSyncAt !== null);
  const signOut = useLogout('staff');
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const items = canAdmin(me)
    ? [...STAFF_NAV, { to: paths.admin, label: nav.admin, icon: ShieldCheck }]
    : STAFF_NAV;
  return (
    <StaffShell
      sideNav={<SideNav items={items} brandName={brand.staffNameAr} onLogout={() => void signOut.run()} />}
      topBar={
        <TopBar
          title={brand.staffNameAr}
          leading={<IconButton icon={Menu} label={nav.menu} onClick={() => setMenuOpen(true)} />}
          connection={connection.state}
          lastSync={connection.lastSync}
          onConnectionClick={() => setSheetOpen(true)}
        />
      }
      banner={
        connection.state === 'offline' ? (
          <Banner
            kind="offline"
            message={fmt(d15.offline, { time: connection.lastSync ?? '—' })}
            actionLabel={buttons.retry}
            onAction={() => requestResync('manual')}
          />
        ) : stale ? (
          <Banner kind="stale" />
        ) : null
      }
      bottomNav={<BottomNav items={STAFF_NAV} />}
      toast={<ToastViewport aboveNav />}
    >
      <Outlet context={me} />
      <StaffMenu me={me} open={menuOpen} onOpenChange={setMenuOpen} />
      <ConnectionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        state={connection.state}
        lastSync={connection.lastSync}
      />
    </StaffShell>
  );
}

export function useStaffMe(): Me {
  return useOutletContext<Me>();
}
