import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';

export interface AppShellProps {
  topBar?: ReactNode;
  bottomNav?: ReactNode;
  banner?: ReactNode;
  /** OfferLayer above the content (--pt-z-offer): an OfferCard never clears the form under it (03 §4.3). */
  offer?: ReactNode;
  toast?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Driver/mobile shell (03 §2.4, §3.2): max width 480px centred, 16px padding, 12px gap, safe-area aware,
 * TopBar 56px and BottomNav 64px + safe-area. No horizontal scroll at 360/390/430px.
 */
export function AppShell({ topBar, bottomNav, banner, offer, toast, children, className }: AppShellProps) {
  return (
    <div className={cx('pt-shell', className)}>
      {topBar}
      {banner}
      <main className="pt-shell__main" id="main">
        {children}
      </main>
      {offer ? (
        <div className="pt-offerlayer" role="region" aria-label={components.offer.layer}>
          {offer}
        </div>
      ) : null}
      {toast}
      {bottomNav}
    </div>
  );
}

export interface StaffShellProps {
  sideNav: ReactNode;
  topBar?: ReactNode;
  banner?: ReactNode;
  bottomNav?: ReactNode;
  toast?: ReactNode;
  children: ReactNode;
}

/**
 * Supervisor/admin shell: cards and a bottom navigation below 1024px, SideNav at the inline start and
 * wider content from 1024px (02 §1.4, 03 §2.4).
 */
export function StaffShell({ sideNav, topBar, banner, bottomNav, toast, children }: StaffShellProps) {
  return (
    <div className="pt-staffshell">
      {sideNav}
      <div className="pt-staffshell__column">
        {topBar}
        {banner}
        <main className="pt-staffshell__main" id="main">
          {children}
        </main>
        {toast}
        {bottomNav}
      </div>
    </div>
  );
}
