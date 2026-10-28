import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { DriverLoginPage } from '@/features/auth/DriverLoginPage';
import { AccountPage } from '@/features/driver/AccountPage';
import { DriverHomePage } from '@/features/driver/DriverHomePage';
import { DriverLayout } from '@/features/driver/DriverLayout';
import { StartShiftPage } from '@/features/driver/StartShiftPage';
import { VehiclesPage } from '@/features/driver/VehiclesPage';
import { BootSkeleton, NotFoundPage, RootRedirect, SessionEndedPage } from '@/features/system/SystemPages';
import { paths } from './paths';
import { RootLayout } from './RootLayout';

/**
 * Component gallery (design-system comparison, e2e screenshots). Only in builds with
 * VITE_ENABLE_GALLERY=true; otherwise the branch is dead code and the chunk is not emitted.
 */
const galleryRoutes: RouteObject[] =
  import.meta.env.VITE_ENABLE_GALLERY === 'true'
    ? [{ path: paths.gallery, lazy: async () => ({ Component: (await import('@/dev/Gallery')).default }) }]
    : [];

/**
 * Routes from 02 §9.1 (`/change-secret` and `/s` are aliases kept from the PNT-021/022 brief).
 * The driver's sign-in and shell are in the main chunk (first load on a weak network); D-02 (forms +
 * zod), S-01 (QR generation) and the staff area load on demand.
 */
export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    // First paint while a lazy route chunk loads: content-shaped skeleton, never a spinner (02 §1.6).
    hydrateFallbackElement: <BootSkeleton />,
    children: [
      { index: true, element: <RootRedirect /> },
      { path: paths.login, element: <DriverLoginPage /> },
      {
        path: paths.staffLogin,
        lazy: async () => ({ Component: (await import('@/features/auth/StaffLoginPage')).StaffLoginPage }),
      },
      {
        path: paths.changeSecret,
        lazy: async () => ({
          Component: (await import('@/features/auth/ChangeSecretPage')).ChangeSecretPage,
        }),
      },
      { path: '/change-secret', element: <Navigate to={paths.changeSecret} replace /> },
      { path: paths.sessionEnded, element: <SessionEndedPage /> },
      { path: paths.driverStart, element: <StartShiftPage /> },
      {
        path: paths.driverHome,
        element: <DriverLayout />,
        children: [
          { index: true, element: <DriverHomePage /> },
          { path: 'vehicles', element: <VehiclesPage /> },
          { path: 'account', element: <AccountPage /> },
        ],
      },
      {
        lazy: async () => ({ Component: (await import('@/features/ops/StaffLayout')).StaffLayout }),
        children: [
          {
            path: paths.ops,
            lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).OpsPage }),
          },
          {
            path: paths.drivers,
            lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).DriversPage }),
          },
          {
            path: paths.venues,
            lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).VenuesPage }),
          },
          {
            path: paths.reports,
            lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).ReportsPage }),
          },
          {
            path: paths.admin,
            lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).AdminPage }),
          },
        ],
      },
      { path: '/s', element: <Navigate to={paths.ops} replace /> },
      ...galleryRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
