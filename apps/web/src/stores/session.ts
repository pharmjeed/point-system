import { create } from 'zustand';
import type { RevokedReason } from '@/api/types';

/**
 * Session-flow state, in memory only (no persist middleware): the MFA step token and why a session
 * ended. The session itself is the httpOnly cookie (09 §9.3); the user record is React Query's `['me']`.
 * Nothing here is ever written to browser storage (PNT-022 acceptance 2).
 */
export type StaffStep = 'credentials' | 'mfa' | 'password' | 'mfa-setup';

export interface SessionEnd {
  reason: RevokedReason | 'unauthenticated';
  /** New venue name on transfer (02 §9.3 item 14). */
  venueName?: string | null;
}

interface SessionState {
  /** S-01 step 2: `mfa_token` from LoginResult (5 minutes, single use, 07 §1.2). */
  mfaToken: string | null;
  /** Step requested by D-01 or a guard when handing over to S-01. */
  staffStep: StaffStep | null;
  ended: SessionEnd | null;
  /** Message carried back to S-01 step 1 (e.g. «انتهت خطوة التحقق…» when the mfa_token expired). */
  staffNotice: string | null;
  beginMfa: (token: string) => void;
  goToStaffStep: (step: StaffStep | null) => void;
  clearMfa: () => void;
  /** Drop the MFA step and return to phone + password with a message (AUTH_MFA_REQUIRED, 08 §4.1). */
  restartStaffLogin: (notice: string) => void;
  clearStaffNotice: () => void;
  endSession: (end: SessionEnd) => void;
  clearEnded: () => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  mfaToken: null,
  staffStep: null,
  ended: null,
  staffNotice: null,
  beginMfa: (token) => set({ mfaToken: token, staffStep: 'mfa', staffNotice: null }),
  goToStaffStep: (step) => set({ staffStep: step }),
  clearMfa: () => set({ mfaToken: null }),
  restartStaffLogin: (notice) => set({ mfaToken: null, staffStep: 'credentials', staffNotice: notice }),
  clearStaffNotice: () => set({ staffNotice: null }),
  endSession: (ended) => set({ ended, mfaToken: null, staffStep: null }),
  clearEnded: () => set({ ended: null }),
  reset: () => set({ mfaToken: null, staffStep: null, ended: null, staffNotice: null }),
}));
