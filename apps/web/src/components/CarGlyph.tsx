import { CAR_ART, CAR_VIEWBOX, carPaint, carShape, paintIsDark } from '@/lib/vehicleArt';

export interface CarValue {
  /** `vehicle_type` (sedan, suv, pickup, van, other) */
  type?: string | null;
  /** the colour key of 02 §8.4 (`white`), or the typed text of «أخرى» */
  color?: string | null;
}

/**
 * The customer's car as a small side view in its own type and colour, next to its plate (DEC-642): the driver
 * recognises it at the gate and in the lot. A typed colour or none draws the neutral body. Decoration: the words and
 * the plate beside it say the same, so it is hidden from screen readers. Faces the reading end (mirrored in RTL).
 */
export function CarGlyph({ type, color, width = 56 }: CarValue & { width?: number }) {
  const art = CAR_ART[carShape(type)];
  const paint = carPaint(color);
  const dark = paint ? paintIsDark(paint) : false;
  return (
    <svg
      className="pt-car"
      width={width}
      height={width / 2}
      viewBox={CAR_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      style={paint ? ({ '--pt-car-paint': paint } as React.CSSProperties) : undefined}
      data-dark={dark ? '' : undefined}
    >
      <path className="pt-car__body" d={art.body} />
      {art.windows.map((d) => (
        <path key={d} className="pt-car__glass" d={d} />
      ))}
      {art.lines.map((d) => (
        <path key={d} className="pt-car__line" d={d} />
      ))}
      {art.wheels.map((x) => (
        <g key={x}>
          <circle className="pt-car__wheel" cx={x} cy={24} r={5.2} />
          <circle className="pt-car__hub" cx={x} cy={24} r={2} />
        </g>
      ))}
    </svg>
  );
}
