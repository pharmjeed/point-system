import type { ReactNode } from 'react';
import type { ConnectionState, DriverState } from '@/api/types';
import { ConnectionIndicator } from './ConnectionIndicator';
import { DriverStateChip } from './DriverStateChip';
import { Logo } from './Logo';

export interface TopBarProps {
  /** Venue name, or the staff brand name (live text 18/700 next to the 28px mark — BRAND §2.3). */
  title: string;
  driverState?: DriverState | null;
  connection?: ConnectionState;
  /** Shown next to the connection state when not online. */
  lastSync?: string | null;
  onConnectionClick?: () => void;
  /** Before the brand (e.g. the ☰ menu button for staff, 02 §1.3). */
  leading?: ReactNode;
  /** Extra items at the end (e.g. alerts). */
  actions?: ReactNode;
}

/** 56px top bar: mark + title at the start; driver state and connection at the end (03 §3.2). */
export function TopBar({
  title,
  driverState,
  connection = 'online',
  lastSync,
  onConnectionClick,
  leading,
  actions,
}: TopBarProps) {
  return (
    <header className="pt-topbar">
      <div className="pt-topbar__brand">
        {leading}
        <Logo variant="mark" height={28} alt="" />
        <span className="pt-topbar__title">{title}</span>
      </div>
      <div className="pt-topbar__end">
        {driverState ? <DriverStateChip state={driverState} /> : null}
        {actions}
        <ConnectionIndicator state={connection} lastSync={lastSync} onClick={onConnectionClick} />
      </div>
    </header>
  );
}
