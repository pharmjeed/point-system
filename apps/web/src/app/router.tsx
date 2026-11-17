import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { DriverLoginPage } from '@/features/auth/DriverLoginPage';
import { AccountPage } from '@/features/driver/AccountPage';
import { DriverHomePage } from '@/features/driver/DriverHomePage';
import { DriverLayout, DriverTaskLayout } from '@/features/driver/DriverLayout';
import { StartShiftPage } from '@/features/driver/StartShiftPage';
import { BootSkeleton, NotFoundPage, RootRedirect, SessionEndedPage } from '@/features/system/SystemPages';
import { paths } from './paths';
import { RootLayout } from './RootLayout';
import { staffRoutes } from './routes.staff';

/**
 * Component gallery (design-system comparison, e2e screenshots). Only in builds with
 * VITE_ENABLE_GALLERY=true; otherwise the branch is dead code and the chunk is not emitted.
 */
const tasks = () => import('@/features/driver/tasks');
const vehicles = () => import('@/features/driver/vehicles');

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
          // D-12 / D-13: one lazy chunk (the bundle budget of the first load)
          { path: 'vehicles', lazy: async () => ({ Component: (await vehicles()).VehiclesPage }) },
          { path: 'vehicles/:ticketId', lazy: async () => ({ Component: (await vehicles()).VehiclePage }) },
          { path: 'account', element: <AccountPage /> },
        ],
      },
      {
        // D-05 … D-11: one lazy chunk (prefetched by D-04), no BottomNav
        element: <DriverTaskLayout />,
        children: [
          {
            path: '/d/intake/:ticketId/vehicle',
            lazy: async () => ({ Component: (await tasks()).IntakeVehiclePage }),
          },
          {
            path: '/d/intake/:ticketId/key-photos',
            lazy: async () => ({ Component: (await tasks()).IntakeKeyPhotosPage }),
          },
          {
            path: '/d/intake/:ticketId/link',
            lazy: async () => ({ Component: (await tasks()).IntakeLinkPage }),
          },
          { path: '/d/tasks/:taskId/park', lazy: async () => ({ Component: (await tasks()).ParkPage }) },
          { path: '/d/tasks/:taskId', lazy: async () => ({ Component: (await tasks()).RetrievalPage }) },
          {
            path: '/d/tickets/:ticketId/handover',
            lazy: async () => ({ Component: (await tasks()).HandoverPage }),
          },
        ],
      },
      {
        lazy: async () => ({ Component: (await import('@/features/ops/StaffLayout')).StaffLayout }),
        children: [
          ...staffRoutes,
          {
            path: paths.drivers,
            lazy: async () => ({ Component: (await import('@/features/drivers/DriversPage')).DriversPage }),
          },
          {
            path: `${paths.drivers}/:driverId`,
            lazy: async () => ({
              Component: (await import('@/features/drivers/DriverProfilePage')).DriverProfilePage,
            }),
          },
          {
            path: paths.venues,
            lazy: async () => ({ Component: (await import('@/features/venues/VenuesPage')).VenuesPage }),
          },
          {
            path: `${paths.venues}/:venueId`,
            lazy: async () => ({ Component: (await import('@/features/venues/VenuePage')).VenuePage }),
          },
          {
            path: `${paths.venues}/:venueId/setup`,
            lazy: async () => ({
              Component: (await import('@/features/venues/VenueSetupPage')).VenueSetupPage,
            }),
          },
        ],
      },
      { path: '/s', element: <Navigate to={paths.ops} replace /> },
      // V2 platform console (docs/v2/02 §2): its own session, one lazy chunk
      {
        path: paths.platformLogin,
        lazy: async () => ({
          Component: (await import('@/features/platform/PlatformLoginPage')).PlatformLoginPage,
        }),
      },
      {
        path: paths.platform,
        lazy: async () => ({
          Component: (await import('@/features/platform/PlatformLayout')).PlatformLayout,
        }),
        children: [
          {
            index: true,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformOverviewPage')).PlatformOverviewPage,
            }),
          },
          {
            path: paths.platformOperators,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformOperatorsPage')).PlatformOperatorsPage,
            }),
          },
          {
            path: `${paths.platformOperators}/:orgId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformOperatorPage')).PlatformOperatorPage,
            }),
          },
          // P-04 (V2-004)
          {
            path: paths.platformVenues,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformVenuesPage')).PlatformVenuesPage,
            }),
          },
          {
            path: `${paths.platformVenues}/:venueId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformVenuesPage')).PlatformVenuePage,
            }),
          },
          // P-06 and P-08 (V2-024)
          {
            path: paths.platformCustomers,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformCustomersPage')).PlatformCustomersPage,
            }),
          },
          {
            path: `${paths.platformCustomers}/:accountId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformCustomersPage')).PlatformCustomerPage,
            }),
          },
          {
            path: paths.platformPayments,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPaymentsPage')).PlatformPaymentsPage,
            }),
          },
          {
            path: `${paths.platformPayments}/reconciliation`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPaymentsPage'))
                .PlatformReconciliationPage,
            }),
          },
          {
            path: `${paths.platformPayments}/reconciliation/:runId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPaymentsPage'))
                .PlatformReconciliationRunPage,
            }),
          },
          {
            path: `${paths.platformPayments}/alerts`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPaymentsPage')).PlatformAlertsPage,
            }),
          },
          {
            path: paths.platformSettlements,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformBillingPages')).PlatformSettlementsPage,
            }),
          },
          {
            path: `${paths.platformSettlements}/:statementId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformBillingPages')).PlatformSettlementPage,
            }),
          },
          {
            path: paths.platformInvoices,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformBillingPages')).PlatformInvoicesPage,
            }),
          },
          {
            path: `${paths.platformInvoices}/:invoiceId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformBillingPages')).PlatformInvoicePage,
            }),
          },
          {
            path: `${paths.platformPayments}/:paymentId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPaymentsPage')).PlatformPaymentPage,
            }),
          },
          // P-05 and P-07 (V2-030, V2-035)
          {
            path: paths.platformPlans,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformPlansPage')).PlatformPlansPage,
            }),
          },
          {
            path: paths.platformSubscriptions,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformSubscriptionsPage'))
                .PlatformSubscriptionsPage,
            }),
          },
          {
            path: `${paths.platformSubscriptions}/:subscriptionId`,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformSubscriptionsPage'))
                .PlatformSubscriptionPage,
            }),
          },
          // P-13 (V2-037)
          {
            path: paths.platformComplaints,
            lazy: async () => ({
              Component: (await import('@/features/platform/PlatformComplaintsPage')).PlatformComplaintsPage,
            }),
          },
        ],
      },
      ...galleryRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
