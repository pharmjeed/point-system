/**
 * The car drawing shown with a plate in both apps (DEC-642, DEC-643): a side view per `vehicle_type`, painted in the
 * colour chosen from the 02 §8.4 list, drawn in the polished "rendered" style of ride-hailing apps — shaded paint
 * (light on top, deeper at the sills), tinted glass with a reflection, lights, a mirror, door seams, silver rims and a
 * soft shadow — so the driver and the customer see the same car. These are Point's own drawings. One source for the
 * shapes and the colours; each app draws them with its own SVG (react-native-svg in the customer app, the DOM in the
 * staff PWA, which keeps a checked copy).
 *
 * The paints are pictures of car colours, content like a photo, not interface colours, so they are not brand tokens
 * (DEC-638). A colour typed as free text («أخرى») or none draws the neutral grey car. viewBox 0 0 200 90; the car
 * faces right (the apps mirror it to face the reading end).
 */

export const CAR_VIEWBOX = '0 0 200 90';

export type CarShape = 'sedan' | 'suv' | 'pickup' | 'van';

export interface CarArt {
  /** the body, filled with the shaded paint */
  body: string;
  /** the glass, tinted */
  windows: readonly string[];
  /** seams and rails over the body */
  lines: readonly string[];
  /** the head lamp (front, right) and the tail lamp (rear, left) */
  head: string;
  tail: string;
  mirror: string;
  /** door handles: [x, y] of each */
  handles: readonly (readonly [number, number])[];
  /** wheel centres (x) on y = 70, and the tyre radius */
  wheels: readonly [number, number];
  tyre: number;
}

export const CAR_ART: Readonly<Record<CarShape, CarArt>> = Object.freeze({
  sedan: {
    body: 'M10 62C10 54 14 50 24 48L52 44C60 34 70 26 84 24H124C136 24 146 30 156 42L176 46C186 48 192 52 192 60V66C192 69 190 70 187 70H162A15 15 0 0 0 132 70H70A15 15 0 0 0 40 70H14C11 70 10 68 10 66Z',
    windows: ['M60 44C67 35 75 29 86 28H103V44Z', 'M107 28H122C132 28 140 33 148 43L107 44Z'],
    lines: ['M58 47H160', 'M105 46V66'],
    head: 'M181 50L190 52.5V57L183 56Z',
    tail: 'M10 52.5L18 50.5V57L10 58Z',
    mirror: 'M146 42L153 40L154 45L147 46Z',
    handles: [
      [88, 52],
      [124, 52],
    ],
    wheels: [55, 147],
    tyre: 13.5,
  },
  suv: {
    body: 'M10 62C10 50 11 44 14 36L21 21C22 19 24 18 27 18H136C142 18 145 20 148 24L161 41L182 44C189 45 192 50 192 58V66C192 69 190 70 187 70H164A16 16 0 0 0 132 70H70A16 16 0 0 0 38 70H14C11 70 10 68 10 66Z',
    windows: ['M25.5 23H50V41H17.5Z', 'M55 23H102V41H55Z', 'M107 23H134C138 23 141 25 143 28L152 41H107Z'],
    lines: ['M30 16.5H132', 'M13 45H166', 'M105 44V66', 'M52.5 44V52'],
    head: 'M182 47L191 50V55L184 54Z',
    tail: 'M11.5 41L16 40V53L10.5 54Z',
    mirror: 'M150 38L157 36L158 42L151 42Z',
    handles: [
      [86, 50],
      [124, 50],
    ],
    wheels: [54, 148],
    tyre: 14.5,
  },
  pickup: {
    body: 'M10 64V46C10 44 11 43 13 43H84V22C84 19 86 18 89 18H132C137 18 140 20 143 24L156 41L178 44C187 45 192 50 192 58V66C192 69 190 70 187 70H164A16 16 0 0 0 132 70H70A16 16 0 0 0 38 70H13C11 70 10 68 10 66Z',
    windows: ['M90 23H130C134 23 137 25 139 28L148 40H90Z'],
    lines: ['M10 43H84', 'M84 44V66', 'M14 47V64', 'M88 45H166'],
    head: 'M182 47L191 50V55L184 54Z',
    tail: 'M10 47L15 46V54L10 55Z',
    mirror: 'M144 38L151 36L152 42L145 42Z',
    handles: [[116, 50]],
    wheels: [54, 148],
    tyre: 14.5,
  },
  van: {
    body: 'M10 66V22C10 17 13 14 18 14H140C146 14 150 16 154 20L176 40L182 42C189 44 192 49 192 57V66C192 69 190 70 187 70H164A16 16 0 0 0 132 70H70A16 16 0 0 0 38 70H13C11 70 10 68 10 66Z',
    windows: ['M18 22H48V38H18Z', 'M54 22H90V38H54Z', 'M96 22H138C142 22 145 24 148 27L160 38H96Z'],
    lines: ['M92 20V66', 'M14 42H170'],
    head: 'M182 46L191 49V54L184 53Z',
    tail: 'M10 44L15 43V54L10 55Z',
    mirror: 'M158 36L165 34L166 40L159 40Z',
    handles: [
      [84, 47],
      [126, 47],
    ],
    wheels: [54, 148],
    tyre: 14.5,
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

/** The neutral car: no paint known (free text, «أخرى», none). */
export const CAR_NEUTRAL_PAINT = '#AEB5C2';

/** The paint for a stored colour, or null (free text, «أخرى», none): the app draws the neutral car then. */
export function carPaint(color: string | null | undefined): string | null {
  return color ? (VEHICLE_COLOR_PAINT[color] ?? null) : null;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** `paint` moved toward white (amount > 0) or black (amount < 0), 0 … 1. */
export function shade(paint: string, amount: number): string {
  const n = Number.parseInt(paint.slice(1), 16);
  const target = amount >= 0 ? 255 : 0;
  const k = Math.abs(amount);
  const mix = (c: number) => c + (target - c) * k;
  return `#${hex2(mix((n >> 16) & 255))}${hex2(mix((n >> 8) & 255))}${hex2(mix(n & 255))}`;
}

const luminance = (paint: string) => {
  const n = Number.parseInt(paint.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

/** Dark paints (black, navy, red, brown …): a softer top light and card tint. */
export function paintIsDark(paint: string): boolean {
  return luminance(paint) < 110;
}

export interface CarColors {
  /** the body gradient, top → middle → sills */
  top: string;
  mid: string;
  low: string;
  /** the body outline: deeper than the paint, lighter only for the near-black ones */
  edge: string;
  /** the soft background of the car card (DEC-643) */
  tint: string;
  /** the paint without «#» (a stable key per colour) */
  key: string;
}

/** Every colour the drawing needs for a stored colour key. */
export function carColors(color: string | null | undefined): CarColors {
  const paint = carPaint(color) ?? CAR_NEUTRAL_PAINT;
  const dark = paintIsDark(paint);
  const white = paint === '#FFFFFF';
  return {
    top: shade(paint, dark ? 0.32 : 0.45),
    mid: white ? '#F4F5F7' : paint,
    low: shade(paint, white ? -0.22 : -0.35),
    edge: luminance(paint) < 40 ? shade(paint, 0.3) : shade(paint, -0.5),
    tint: white ? '#EEF1F5' : shade(paint, dark ? 0.9 : 0.86),
    key: paint.slice(1),
  };
}

/** The fixed parts of the drawing: tinted glass, tyres, rims, lamps, shadow. */
export const CAR_PARTS = Object.freeze({
  glassTop: '#55698F',
  glassLow: '#1E2A40',
  glassShine: '#41547A',
  tyre: '#1B212C',
  rimOuter: '#E3E6EB',
  rimInner: '#9AA1AD',
  hub: '#4A515E',
  head: '#FFF4C2',
  tail: '#D61F2C',
  trim: '#2A303B',
  shadow: '#031435',
});
