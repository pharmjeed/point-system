import { Activity, Building2, CarFront, ChartColumn, Menu, ShieldCheck, Users } from 'lucide-react';
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
import { useConnection } from '@/features/session/useConnection';
import { useLogout } from '@/features/session/useLogout';
import { useBrand } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { d14, d15, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { THEME_PREFS, type ThemePref } from '@/lib/theme';
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
          <Banner kind="offline" message={fmt(d15.offline, { time: connection.lastSync ?? '—' })} />
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
