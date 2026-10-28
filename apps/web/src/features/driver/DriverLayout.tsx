import { Car, House, User } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import type { Me } from '@/api/types';
import { RequireDriver } from '@/app/guards';
import { paths } from '@/app/paths';
import { AppShell, Banner, BottomNav, ToastViewport, TopBar, type NavItem } from '@/components';
import { useBrand } from '@/hooks/useMe';
import { useThemeArea } from '@/hooks/useThemeArea';
import { d15, nav } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { ConnectionSheet } from '@/features/session/ConnectionSheet';
import { useConnection } from '@/features/session/useConnection';
import { useCachedHome } from './useDriverHome';

/** Exactly three destinations for the driver (02 §1.4, 03 §3.2). */
export const DRIVER_NAV: NavItem[] = [
  { to: paths.driverHome, label: nav.home, icon: House, end: true },
  { to: paths.driverVehicles, label: nav.vehicles, icon: Car },
  { to: paths.driverAccount, label: nav.account, icon: User },
];

/**
 * TopBar + offline banner + content (+ BottomNav). D-03 and the task screens (D-05 … D-11) use it without
 * the navigation. The driver state follows the latest `GET /v1/me/home` snapshot when there is one.
 */
export function DriverFrame({ me, withNav, children }: { me: Me; withNav: boolean; children: ReactNode }) {
  const brand = useBrand();
  const connection = useConnection();
  const home = useCachedHome();
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
        connection.state === 'offline' ? (
          <Banner
            kind="offline"
            message={fmt(d15.offline, { time: connection.lastSync ?? '—' })}
            detail={d15.offlineDetail}
          />
        ) : null
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
