import { ROLE_PERMISSIONS, DRIVE_PERMISSIONS, type Permission, type Role } from '@point/shared';
import { AppError } from '../errors/app-error.js';

export interface DutyContext {
  id: string;
  venueId: string;
  poolId: string;
  shiftId: string;
  status: 'on_duty' | 'on_break';
  version: number;
}

/**
 * Who is calling (09 §8.3). Loaded fresh on every request (never cached) so transfers, disabling and scope
 * changes take effect immediately. Re-checked inside the command transaction after the locks (TOCTOU, 09 §8.4).
 */
export interface ActorContext {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
  canDrive: boolean;
  employeeCode: string;
  fullName: string;
  /** venues the actor may act on: org scope → every venue of the org; supervisor → role_scopes; driver → active assignment */
  venueIds: Set<string>;
  orgScope: boolean;
  /** the driver's single active assignment (canon §4) */
  assignment: { id: string; venueId: string } | null;
  /** open duty session (not ended) */
  duty: DutyContext | null;
  /** restricted session: only auth.self routes (07 §1.2) */
  mustChangeSecret: boolean;
  secretKind: 'pin' | 'password';
  mfaSetupRequired: boolean;
  /** 'venue_id' of the active assignment for drivers, else the first scoped venue (logging only) */
  venueId: string | null;
}

const ROLE_SETS = new Map<Role, Set<Permission>>(
  (Object.keys(ROLE_PERMISSIONS) as Role[]).map((r) => [r, new Set(ROLE_PERMISSIONS[r])]),
);
const DRIVE_SET = new Set<Permission>(DRIVE_PERMISSIONS);

/** Role matrix (canon §10) + D* for a supervisor with can_drive (duty is checked later by the policies). */
export function hasPermission(a: Pick<ActorContext, 'role' | 'canDrive'>, p: Permission): boolean {
  if (ROLE_SETS.get(a.role)?.has(p)) return true;
  return a.role === 'supervisor' && a.canDrive && DRIVE_SET.has(p);
}

export function effectivePermissions(a: Pick<ActorContext, 'role' | 'canDrive'>): Permission[] {
  const s = new Set(ROLE_SETS.get(a.role) ?? []);
  if (a.role === 'supervisor' && a.canDrive) for (const p of DRIVE_SET) s.add(p);
  return [...s].sort();
}

export function assertPermission(a: ActorContext, p: Permission): void {
  if (!hasPermission(a, p)) throw new AppError('PERMISSION_DENIED', { permission: p });
}

/** True when the actor is (or acts as) a driver: role driver, or a supervisor with can_drive. */
export function isDriving(a: ActorContext): boolean {
  return a.role === 'driver' || (a.role === 'supervisor' && a.canDrive);
}

/**
 * Venue scope for a venue the caller named explicitly ({venueId} in the path or venue_id in the query/body):
 * SCOPE_VENUE_DENIED (or ASSIGNMENT_REQUIRED for a driver without an active assignment).
 */
export function assertExplicitVenue(a: ActorContext, venueId: string): void {
  if (a.role === 'driver' && !a.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
  if (!a.venueIds.has(venueId)) throw new AppError('SCOPE_VENUE_DENIED', { venue_id: venueId });
}

/**
 * Venue scope for a resource addressed by its id (ticket, task, offer, cycle…): out of scope is reported as
 * the resource's own not-found code so nothing leaks (08 §1.3 rule 4).
 */
export function assertResourceVenue(
  a: ActorContext,
  venueId: string | null | undefined,
  notFound: 'TICKET_NOT_FOUND' | 'OFFER_NOT_FOUND' | 'RESOURCE_NOT_FOUND' = 'RESOURCE_NOT_FOUND',
  resource?: string,
): void {
  if (!venueId || !a.venueIds.has(venueId)) {
    throw new AppError(notFound, notFound === 'RESOURCE_NOT_FOUND' && resource ? { resource } : {});
  }
}

/** Driver operational commands need an active assignment then an open duty (07 §1.10 steps 4–5). */
export function requireDuty(a: ActorContext, poolId?: string): DutyContext {
  if (a.role === 'driver' && !a.assignment) throw new AppError('ASSIGNMENT_REQUIRED');
  if (!a.duty) throw new AppError('DUTY_REQUIRED');
  if (a.duty.status === 'on_break') throw new AppError('DRIVER_ON_BREAK');
  if (poolId && a.duty.poolId !== poolId) throw new AppError('DUTY_REQUIRED');
  return a.duty;
}
