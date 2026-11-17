/**
 * Hold to request the car (V2-UX option A «زر واحد», DEC-621 … DEC-623): the state machine of the gesture, pure and
 * unit tested. The screen (`src/ui/HoldCircle.tsx`) feeds it the finger's press and release and a tick every few
 * milliseconds from the device clock, and only draws what it says.
 *
 * - `idle` → press → `holding` (the ring fills over `HOLD_MS`, the countdown says 3 · 2 · 1);
 * - released or cancelled before the end → `idle` again with nothing requested (a release shows the hint);
 * - the end reached (by a tick, or by a release that comes late) → `sending`, and `fired` grows by exactly one: the
 *   command runs once per completed hold, however many ticks or releases follow;
 * - `confirm` (the dialog of screen readers and the keyboard, DEC-622) goes straight to `sending` the same way;
 * - `settled` (the server answered, either way) → `idle`.
 */

/** How long the circle is held before the car is requested. */
export const HOLD_MS = 3000;

/** The countdown's steps: 3 · 2 · 1 (one per second). */
export const HOLD_STEPS = 3;

export type HoldPhase = 'idle' | 'holding' | 'sending';

export interface HoldState {
  phase: HoldPhase;
  /** when the current hold started (device clock, ms), while holding */
  startedAt: number | null;
  /** whole seconds left while holding: 3, 2, 1 */
  count: number;
  /** completed holds and confirmations: the command runs each time this grows (once per hold) */
  fired: number;
  /** a hold was let go before the end: «اضغط مطولًا 3 ثوانٍ لطلب سيارتك» shows */
  hint: boolean;
}

export type HoldEvent =
  | { type: 'press'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'release'; at: number }
  /** the system took the touch away (a scroll, the finger slid off): no request, no hint */
  | { type: 'cancel' }
  /** the confirmation dialog's «نعم، اطلبها» */
  | { type: 'confirm' }
  /** the command settled (requested, refused or offline) */
  | { type: 'settled' }
  | { type: 'hideHint' };

export const initialHold: HoldState = {
  phase: 'idle',
  startedAt: null,
  count: HOLD_STEPS,
  fired: 0,
  hint: false,
};

/** The share of the hold done at `at`, 0 … 1. */
export function holdProgress(state: Pick<HoldState, 'phase' | 'startedAt'>, at: number): number {
  if (state.phase === 'sending') return 1;
  if (state.phase !== 'holding' || state.startedAt === null) return 0;
  return Math.min(1, Math.max(0, (at - state.startedAt) / HOLD_MS));
}

/** The countdown for a progress: 3 at the start, 2 after one second, 1 after two (never 0 while held). */
export function holdCount(progress: number): number {
  return Math.max(1, Math.min(HOLD_STEPS, Math.ceil(HOLD_STEPS * (1 - progress) - 1e-9)));
}

const complete = (s: HoldState): HoldState => ({
  ...s,
  phase: 'sending',
  startedAt: null,
  count: 0,
  fired: s.fired + 1,
  hint: false,
});

export function holdReducer(s: HoldState, e: HoldEvent): HoldState {
  switch (e.type) {
    case 'press':
      if (s.phase !== 'idle') return s;
      return { ...s, phase: 'holding', startedAt: e.at, count: HOLD_STEPS, hint: false };
    case 'tick': {
      if (s.phase !== 'holding') return s;
      const p = holdProgress(s, e.at);
      if (p >= 1) return complete(s);
      const count = holdCount(p);
      // the same state when nothing visible changed: React skips the render
      return count === s.count ? s : { ...s, count };
    }
    case 'release':
      if (s.phase !== 'holding') return s;
      // a late tick: the end was reached before the finger lifted
      if (holdProgress(s, e.at) >= 1) return complete(s);
      return { ...s, phase: 'idle', startedAt: null, count: HOLD_STEPS, hint: true };
    case 'cancel':
      if (s.phase !== 'holding') return s;
      return { ...s, phase: 'idle', startedAt: null, count: HOLD_STEPS, hint: false };
    case 'confirm':
      if (s.phase === 'sending') return s;
      return complete(s);
    case 'settled':
      if (s.phase !== 'sending') return s;
      return { ...initialHold, fired: s.fired };
    case 'hideHint':
      return s.hint ? { ...s, hint: false } : s;
  }
}

/**
 * What moves, for the device's reduce-motion setting (03 §2.7, DEC-623). With it on: no rotating light, no breathing
 * rings, no glow, no burst and no press scale — but the ring still fills linearly over the hold, the one piece of
 * feedback that says how long is left; a release and every change of state snap.
 */
export interface HoldMotion {
  /** the light that travels around the ring with its head */
  comet: boolean;
  /** the soft glow that grows behind the circle while it is held */
  glow: boolean;
  /** the breathing rings at rest (and the green glow pulse when the car is ready) */
  pulses: boolean;
  /** the light burst when the request is accepted */
  burst: boolean;
  /** the circle's scale while pressed */
  pressScale: number;
  /** ms the ring takes to unwind after an early release (0 = at once) */
  unwindMs: (progress: number) => number;
  /** ms of the cross-fade between two states of the circle */
  swapMs: number;
}

export function holdMotion(reduced: boolean): HoldMotion {
  if (reduced)
    return {
      comet: false,
      glow: false,
      pulses: false,
      burst: false,
      pressScale: 1,
      unwindMs: () => 0,
      swapMs: 0,
    };
  return {
    comet: true,
    glow: true,
    pulses: true,
    burst: true,
    pressScale: 0.95,
    // quick, and quicker the less there is to unwind
    unwindMs: (progress) => Math.round(160 + 240 * Math.min(1, Math.max(0, progress))),
    swapMs: 420,
  };
}
