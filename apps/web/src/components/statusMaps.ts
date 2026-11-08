import {
  Bookmark,
  CarFront,
  CheckCheck,
  CircleCheck,
  CircleParking,
  CircleX,
  Coffee,
  Layers,
  Navigation,
  Power,
  RotateCcw,
  SquareParking,
  UserCheck,
  BellRing,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { ConnectionState, DriverState, TicketStatus } from '@/api/types';

/** Icon per ticket status — the design system map `Point.TICKET_STATUS` (DEC-49b). */
export const TICKET_STATUS_ICON: Record<TicketStatus, LucideIcon> = {
  received: CarFront,
  parking: CircleParking,
  parked: SquareParking,
  requested: BellRing,
  assigned: UserCheck,
  assigned_waiting: Bookmark,
  retrieving: Navigation,
  ready: CircleCheck,
  delivered: CheckCheck,
  reparking: RotateCcw,
  voided: CircleX,
};

/** Icon per driver state — `Point.DRIVER_STATE` (DEC-49b). */
export const DRIVER_STATE_ICON: Record<DriverState, LucideIcon> = {
  available: CircleCheck,
  intake_parking: CircleParking,
  retrieving: Navigation,
  busy_with_next: Layers,
  on_break: Coffee,
  off_duty: Power,
};

export const CONNECTION_ICON: Record<ConnectionState, LucideIcon> = {
  online: Wifi,
  uncertain: Wifi,
  offline: WifiOff,
};

/** Token suffix: `assigned_waiting` → `assigned-waiting` (--pt-status-assigned-waiting-bg). */
export const tokenKey = (value: string) => value.replace(/_/g, '-');
