import { useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '@/api/client';
import { displayMessage, isApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import type { Me } from '@/api/types';
import { RequireDriver } from '@/app/guards';
import { hasOpenDuty, paths } from '@/app/paths';
import { Banner, Button, Card, EmptyState } from '@/components';
import { useCommand } from '@/hooks/useCommand';
import { useBrand } from '@/hooks/useMe';
import { useOnline } from '@/hooks/useOnline';
import { useThemeArea } from '@/hooks/useThemeArea';
import { d03 } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { useLogout } from '@/features/session/useLogout';
import { DriverFrame } from './DriverLayout';

/**
 * D-03 shell (PNT-022 hands the first-login driver here). The device checklist (audio test, notifications,
 * wake lock) is PNT-066/070; «بدء الوردية» already sends POST /v1/me/duty/start with an Idempotency-Key.
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

function StartShift({ me }: { me: Me }) {
  const brand = useBrand();
  const online = useOnline();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signOut = useLogout('driver');
  const start = useCommand((body: Record<string, never>, key: string) =>
    api.post('/v1/me/duty/start', { body, idempotencyKey: key }),
  );

  const onStart = async () => {
    try {
      await start.run({});
    } catch (error) {
      if (!isApiError(error, 'DUTY_ALREADY_STARTED')) return; // shown under the button
    }
    await qc.invalidateQueries({ queryKey: queryKeys.me });
    navigate(paths.driverHome, { replace: true });
  };

  const venue = me.active_assignment?.venue_name_ar;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="page-title">
      <h1 className="pt-page-title" id="page-title">
        {d03.title}
      </h1>
      {venue ? (
        <Card>
          <p className="m-0 font-semibold">{fmt(d03.assignment, { venue })}</p>
        </Card>
      ) : (
        <EmptyState icon={MapPin} title={d03.noAssignment} />
      )}
      <Banner kind="info" rounded message={fmt(d03.notificationsBanner, { brand: brand.staffNameAr })} />
      <Button
        size="lg"
        loading={start.pending}
        disabled={!online || !venue}
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
    </section>
  );
}
