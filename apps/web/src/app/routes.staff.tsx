import type { RouteObject } from 'react-router';
import { routePatterns } from '@/features/supervisor/staffPaths';
import { paths } from './paths';

/**
 * Supervisor/admin/owner screens (02 §9.1), children of the staff shell (`StaffLayout`). Every screen is a lazy
 * chunk. The «التشغيل» destination (S-02 and its S-03, S-04, S-12 — 02 §1.4) shares one pathless layout that
 * keeps the live alerts and their sound running between those screens.
 */
export const staffRoutes: RouteObject[] = [
  {
    lazy: async () => ({ Component: (await import('@/features/supervisor/OpsArea')).OpsArea }),
    children: [
      {
        path: paths.ops,
        lazy: async () => ({ Component: (await import('@/features/supervisor/OpsBoardPage')).OpsBoardPage }),
      },
      {
        path: routePatterns.ticket,
        lazy: async () => ({ Component: (await import('@/features/supervisor/TicketPage')).TicketPage }),
      },
      {
        path: paths.opsAlerts,
        lazy: async () => ({ Component: (await import('@/features/supervisor/AlertsPage')).AlertsPage }),
      },
      {
        path: paths.incidents,
        lazy: async () => ({
          Component: (await import('@/features/supervisor/IncidentsPage')).IncidentsPage,
        }),
      },
      {
        path: routePatterns.incident,
        lazy: async () => ({ Component: (await import('@/features/supervisor/IncidentsPage')).IncidentPage }),
      },
    ],
  },
  {
    path: routePatterns.transfer,
    lazy: async () => ({ Component: (await import('@/features/supervisor/TransferPage')).TransferPage }),
  },
  // S-11 is built in a later commit of this stream: the PNT-021 placeholder until then
  {
    path: paths.reports,
    lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).ReportsPage }),
  },
  // S-13 is built in a later commit of this stream: the PNT-021 placeholder until then
  {
    path: paths.admin,
    lazy: async () => ({ Component: (await import('@/features/ops/StaffPages')).AdminPage }),
  },
];
