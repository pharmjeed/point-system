/**
 * The car drawing shown next to a plate in both apps (DEC-642): a side view per `vehicle_type` painted in the
 * colour chosen from the 02 §8.4 list, so the driver and the customer see the same car. One source for the shapes and
 * the paints; each app draws them with its own SVG (react-native-svg in the customer app, the DOM in the staff PWA).
 *
 * The paints are pictures of car colours, content like a photo, not interface colours, so they are not brand tokens
 * (DEC-638). A colour typed as free text («أخرى») or none has no paint: the drawing is the neutral body.
 * viewBox 0 0 64 32; the car faces the reading end and the apps mirror it in RTL if they wish.
 */

export const CAR_VIEWBOX = '0 0 64 32';

export type CarShape = 'sedan' | 'suv' | 'pickup' | 'van';

export interface CarArt {
  /** the body, filled with the paint */
  body: string;
  /** the glass, light on any paint */
  windows: readonly string[];
  /** extra lines over the body (the pickup's bed) */
  lines: readonly string[];
  /** wheel centres (x) on the ground line y = 24 */
  wheels: readonly [number, number];
}

export const CAR_ART: Readonly<Record<CarShape, CarArt>> = Object.freeze({
  sedan: {
    body: 'M4 24V19.5C4 17.8 5 16.8 6.6 16.5L16 15L23.2 8.6C24 7.9 25 7.5 26.1 7.5H39.8C40.9 7.5 41.9 7.9 42.7 8.6L49.5 15L57.6 16.3C59.3 16.6 60 17.6 60 19.2V24Z',
    windows: ['M25 9.6L19.6 14.6H31.4V9.6Z', 'M33.4 9.6V14.6H46.2L41 9.6Z'],
    lines: [],
    wheels: [16, 48],
  },
  suv: {
    body: 'M4 24V15.5C4 14.1 5 13 6.5 13H12.5L17.4 6.4C17.9 5.8 18.6 5.5 19.4 5.5H46C46.8 5.5 47.5 5.8 48 6.3L54.5 13H57.5C59 13 60 14.1 60 15.5V24Z',
    windows: ['M19.8 7.6L15.6 13H30.6V7.6Z', 'M32.6 7.6V13H51.4L46.2 7.6Z'],
    lines: [],
    wheels: [16, 48],
  },
  pickup: {
    body: 'M4 24V15.5C4 14.1 5 13 6.5 13H12.5L17.4 6.4C17.9 5.8 18.6 5.5 19.4 5.5H32.5V14H57.5C59 14 60 15 60 16.5V24Z',
    windows: ['M19.8 7.6L15.6 13H30.4V7.6Z'],
    lines: ['M34.5 14V24', 'M36 16.5H58'],
    wheels: [15, 48],
  },
  van: {
    body: 'M4 24V7.5C4 6.4 4.9 5.5 6 5.5H44.2C45 5.5 45.7 5.8 46.3 6.3L56.2 14C58.8 14.8 60 16.2 60 18.2V24Z',
    windows: ['M8 8V13H20V8Z', 'M23 8V13H35V8Z', 'M38 8V13H53L45.4 8Z'],
    lines: [],
    wheels: [15, 49],
  },
});

/** The shape for a `vehicle_type` (`other` and unknown draw the sedan). */
export function carShape(type: string | null | undefined): CarShape {
  return type === 'suv' || type === 'pickup' || type === 'van' ? type : 'sedan';
}

/** The paint of each colour key of 02 §8.4 («other» has none). */
export const VEHICLE_COLOR_PAINT: Readonly<Record<string, string>> = Object.freeze({
  white: '#FFFFFF',
  black: '#141414',
  silver: '#C3C7CE',
  gray: '#7B8088',
  red: '#C8102E',
  blue: '#1E4FD8',
  navy: '#0D2150',
  green: '#1F7A3A',
  beige: '#D8C6A2',
  brown: '#6B4226',
  gold: '#C9A227',
  yellow: '#F2C200',
  orange: '#F26B1D',
});

/** The paint for a stored colour, or null (free text, «أخرى», none): the app draws its neutral body then. */
export function carPaint(color: string | null | undefined): string | null {
  return color ? (VEHICLE_COLOR_PAINT[color] ?? null) : null;
}

/** Dark paints take light glass edges; light ones dark (so a white or silver car keeps its outline). */
export function paintIsDark(paint: string): boolean {
  const n = Number.parseInt(paint.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}
