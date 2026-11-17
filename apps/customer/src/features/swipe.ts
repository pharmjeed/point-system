/**
 * The slide-to-confirm control that requests the car (V2-UX, DEC-583): the arithmetic of the drag, pure and unit
 * tested. The knob moves from the start edge of its track to the end edge — right to left in Arabic, left to right in
 * English — and a release past `SWIPE_CONFIRM_AT` of the way confirms; anything shorter springs back. The screen
 * (`src/ui/SwipeToConfirm.tsx`) only draws what these return.
 */

/** How far the knob must travel before a release confirms (85 % of the track). */
export const SWIPE_CONFIRM_AT = 0.85;

/** The share of the travel over which the label fades out completely. */
export const SWIPE_LABEL_FADE = 0.6;

export interface SwipeGeometry {
  /** the track's measured width */
  track: number;
  /** the knob's width */
  knob: number;
  /** the gap between the knob and the track's edge, on both sides */
  inset: number;
}

/** How far the knob can move, in px (never negative: a track not measured yet has none). */
export function swipeTravel(g: SwipeGeometry): number {
  return Math.max(0, g.track - g.knob - 2 * g.inset);
}

/**
 * The knob's offset from its start, 0 … travel, for a finger moved `dx` px on screen (positive = to the right). In
 * a right-to-left layout the start is the right edge, so moving left is forward; moving backwards past the start
 * leaves the knob at the start.
 */
export function swipeOffset(dx: number, travel: number, rtl: boolean): number {
  const forward = rtl ? -dx : dx;
  return Math.min(Math.max(forward, 0), Math.max(travel, 0));
}

/** The on-screen translation of the knob for an offset: negative (to the left) in a right-to-left layout. */
export function swipeTranslate(offset: number, rtl: boolean): number {
  return rtl ? -offset : offset;
}

/** Released here: confirm (go to the end, then request) or spring back. A track not measured never confirms. */
export function swipeOutcome(offset: number, travel: number): 'confirm' | 'reset' {
  if (travel <= 0) return 'reset';
  return offset / travel >= SWIPE_CONFIRM_AT ? 'confirm' : 'reset';
}

/** The label's opacity: 1 at rest, 0 once the knob is `SWIPE_LABEL_FADE` of the way. */
export function swipeLabelOpacity(offset: number, travel: number): number {
  if (travel <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - offset / (travel * SWIPE_LABEL_FADE)));
}

/**
 * Whether a drag is a swipe the control takes (and the scroll view does not): mostly horizontal, past a few px.
 */
export function isHorizontalDrag(dx: number, dy: number, slop = 4): boolean {
  return Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy);
}
