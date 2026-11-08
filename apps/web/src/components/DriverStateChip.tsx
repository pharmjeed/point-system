import { User } from 'lucide-react';
import type { DriverState } from '@/api/types';
import { driverState } from '@/i18n/ar';
import { Icon } from './Icon';
import { DRIVER_STATE_ICON, tokenKey } from './statusMaps';

export interface DriverStateChipProps {
  state: DriverState;
}

/** Driver state from --pt-driver-* with an icon per state (03 §3.3, canon §5.6). Violet = "next task" only. */
export function DriverStateChip({ state }: DriverStateChipProps) {
  const key = tokenKey(state);
  return (
    <span
      className="pt-chip"
      data-state={state}
      style={{ background: `var(--pt-driver-${key}-bg)`, color: `var(--pt-driver-${key}-fg)` }}
    >
      <Icon icon={DRIVER_STATE_ICON[state] ?? User} size={16} />
      <span>{(driverState as Record<string, string>)[state] ?? state}</span>
    </span>
  );
}
