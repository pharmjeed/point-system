import { useQueryClient } from '@tanstack/react-query';
import { Building2, CreditCard, LayoutDashboard, LogOut, MapPin, Users } from 'lucide-react';
import { Navigate, Outlet, useNavigate, useOutletContext } from 'react-router';
import { ApiError } from '@/api/errors';
import {
  PLATFORM_SIGNED_OUT_CODES,
  platformLogout,
  platformPendingStep,
  type PlatformMe,
} from '@/api/platform';
import { paths } from '@/app/paths';
import {
  AppShell,
  BottomNav,
  Button,
  EmptyState,
  SideNav,
  StaffShell,
  ToastViewport,
  TopBar,
  type NavItem,
} from '@/components';
import { BootSkeleton } from '@/features/system/SystemPages';
import { useSubmitGuard } from '@/hooks/useCommand';
import { useThemeArea } from '@/hooks/useThemeArea';
import { buttons } from '@/i18n/ar';
import { p01 } from '@/i18n/ar.staff';
import { platformNav } from './platformModel';
import { usePlatformMe } from './usePlatformMe';
import '@/features/supervisor/staff.css';

const NAV_ICON = {
  overview: LayoutDashboard,
  operators: Building2,
  venues: MapPin,
  customers: Users,
  payments: CreditCard,
} as const;
const NAV_PATH = {
  overview: paths.platform,
  operators: paths.platformOperators,
  venues: paths.platformVenues,
  customers: paths.platformCustomers,
  payments: paths.platformPayments,
} as const;

/**
 * `/platform/*` — the platform console shell (V2-002 sign-in, V2-003 screens): its own session (`GET
 * /v1/platform/me`), the staff theme, SideNav from 1024px and the BottomNav below, the destinations this platform
 * role may open (P-01 for everyone, P-02 / P-03 with `platform.operator_read`, P-04 with `platform.venue_review`, P-06
 * with `platform.customer_read`, P-08 with `platform.payment_read`). No platform session, or a restricted
 * one, goes to /platform/login. It never touches the staff session (DEC-462).
 */
export function PlatformLayout() {
  useThemeArea('staff');
  const me = usePlatformMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { guard, pending } = useSubmitGuard();

  if (me.isPending) return <BootSkeleton />;
  if (me.error) {
    const code = me.error instanceof ApiError ? me.error.code : null;
    if (code && PLATFORM_SIGNED_OUT_CODES.includes(code))
      return <Navigate to={paths.platformLogin} replace />;
    return (
      <AppShell topBar={<TopBar title={p01.shellTitle} />}>
        <EmptyState title={me.error instanceof ApiError ? me.error.message_ar : p01.shellTitle}>
          <Button variant="secondary" onClick={() => void me.refetch()}>
            {buttons.retry}
          </Button>
        </EmptyState>
      </AppShell>
    );
  }
  if (platformPendingStep(me.data)) return <Navigate to={paths.platformLogin} replace />;

  const logout = () =>
    guard(async () => {
      try {
        await platformLogout();
      } finally {
        qc.removeQueries({ queryKey: ['platform'] });
        navigate(paths.platformLogin, { replace: true });
      }
    });
  const items: NavItem[] = platformNav(me.data).map((k) => ({
    to: NAV_PATH[k],
    label: p01.nav[k],
    icon: NAV_ICON[k],
    end: k === 'overview',
  }));

  return (
    <StaffShell
      sideNav={
        <SideNav items={items} brandName={me.data.brand.staff_name_ar} onLogout={() => void logout()} />
      }
      topBar={
        <TopBar
          title={p01.shellTitle}
          actions={
            <Button
              variant="secondary"
              compact
              iconStart={LogOut}
              loading={pending}
              onClick={() => void logout()}
            >
              {p01.logout}
            </Button>
          }
        />
      }
      bottomNav={items.length > 1 ? <BottomNav items={items} label={p01.nav.menu} /> : null}
      toast={<ToastViewport aboveNav={items.length > 1} />}
    >
      <Outlet context={me.data} />
    </StaffShell>
  );
}

export function usePlatformAccount(): PlatformMe {
  return useOutletContext<PlatformMe>();
}
