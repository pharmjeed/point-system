import { KeyRound, LayoutDashboard } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/api/client';
import { displayMessage } from '@/api/errors';
import { hasOpenDuty, paths } from '@/app/paths';
import { Button, Card, Dialog, ListItem, SegmentedControl } from '@/components';
import { useCommand } from '@/hooks/useCommand';
import { d14, nav } from '@/i18n/ar';
import { THEME_PREFS, type ThemePref } from '@/lib/theme';
import { useLogout } from '@/features/session/useLogout';
import { useUiStore } from '@/stores/ui';
import { useDriverMe } from './DriverLayout';

const THEME_LABEL: Record<ThemePref, string> = {
  system: d14.themeSystem,
  light: d14.themeLight,
  dark: d14.themeDark,
};

/**
 * D-14 (partial, PNT-021/022): identity, the appearance switch «تلقائي / فاتح / داكن» (DEC-19), PIN change
 * (D-02) and sign-out. Duty, break, audio and notifications arrive with PNT-024/066/070.
 */
export function AccountPage() {
  const me = useDriverMe();
  const theme = useUiStore((s) => s.themes.driver);
  const setTheme = useUiStore((s) => s.setTheme);
  const signOut = useLogout('driver');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const endDuty = useCommand((_: Record<string, never>, key: string) =>
    api.post('/v1/me/duty/end', { body: {}, idempotencyKey: key }),
  );

  const onLogout = () => {
    if (hasOpenDuty(me)) setConfirmOpen(true);
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
        {me.active_assignment?.venue_name_ar ? (
          <p className="m-0 text-sm text-text-muted">{me.active_assignment.venue_name_ar}</p>
        ) : null}
      </Card>

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

      <Button variant="ghost" fullWidth loading={signOut.pending} onClick={onLogout}>
        {d14.logout}
      </Button>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={d14.logoutDuringDuty}
        confirmLabel={d14.endAndLogout}
        loading={endDuty.pending || signOut.pending}
        error={endDuty.error ? displayMessage(endDuty.error) : undefined}
        onConfirm={async () => {
          await endDuty.run({});
          await signOut.run();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
