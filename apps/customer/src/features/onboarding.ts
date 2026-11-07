/**
 * Where journey R1 continues (01 §1): C-01 once, C-02/C-03 to sign in, C-04 until the server says the profile is
 * complete (name + terms + privacy at the current version), C-05 offered once and skippable, then C-06.
 * The server's `profile_complete` decides, never a local flag (CLAUDE.md §3 item 1).
 */
import type { CustomerMe } from '@point/shared/customer';

export type Destination = '/welcome' | '/phone' | '/profile' | '/vehicle' | '/home';

export interface OnboardingState {
  /** C-01 was seen on this device («يظهر مرة واحدة»). */
  welcomeSeen: boolean;
  /** The signed-in account, or null when signed out. */
  me: CustomerMe | null;
  /** C-05 was saved or skipped on this device for this account. */
  vehiclePromptDone: boolean;
}

export function nextDestination(s: OnboardingState): Destination {
  if (!s.me) return s.welcomeSeen ? '/phone' : '/welcome';
  if (!s.me.profile_complete) return '/profile';
  if (s.me.vehicles_count === 0 && !s.vehiclePromptDone) return '/vehicle';
  return '/home';
}
