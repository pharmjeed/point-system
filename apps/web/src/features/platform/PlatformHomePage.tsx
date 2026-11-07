import { LayoutDashboard, MapPin } from 'lucide-react';
import { paths } from '@/app/paths';
import { Card, EmptyState, ListItem } from '@/components';
import { p01, p04 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { PlatformShell } from './PlatformShell';

/**
 * `/platform` — the platform console (V2-002). P-01 is a placeholder with the signed-in account; the screens of
 * P-02 … P-12 (docs/v2/02 §2) appear as their tickets land, each listed for the roles that hold its permission
 * (P-04 «المواقع», V2-004). Without a platform session (or with a restricted one) it sends to /platform/login.
 */
export function PlatformHomePage() {
  return (
    <PlatformShell>
      {(me) => (
        <>
          <h1 className="pt-page-title">{p01.overviewTitle}</h1>
          <Card>
            <p className="m-0 font-bold">{fmt(p01.welcome, { name: me.user.full_name })}</p>
            <p className="m-0 text-sm text-text-muted">{p01.role[me.user.role]}</p>
          </Card>
          {me.permissions.includes('platform.venue_review') ? (
            <ul className="pt-list">
              <li>
                <ListItem icon={MapPin} title={p04.navLabel} to={paths.platformVenues} />
              </li>
            </ul>
          ) : null}
          <EmptyState icon={LayoutDashboard} title={p01.placeholder} />
        </>
      )}
    </PlatformShell>
  );
}
