import { useId } from 'react';
import { CAR_ART, CAR_PARTS, CAR_VIEWBOX, carColors, carShape } from '@/lib/vehicleArt';

export interface CarValue {
  /** `vehicle_type` (sedan, suv, pickup, van, other) */
  type?: string | null;
  /** the colour key of 02 §8.4 (`white`), or the typed text of «أخرى» */
  color?: string | null;
}

const SPOKES = [0, 72, 144, 216, 288].map((deg) => (deg * Math.PI) / 180);

/**
 * The customer's car as a side view in its own type and colour (DEC-642), drawn in the rendered style of DEC-643:
 * shaded paint, tinted glass with a reflection, lamps, mirror, handles, silver rims and a soft shadow; the driver
 * recognises it at the gate and in the lot. A typed colour or none draws the neutral grey car. Decoration: the words
 * and the plate beside it say the same, so it is hidden from screen readers. Faces the reading end (mirrored in RTL).
 * Each drawing has its own gradient ids (`useId`): a `url(#id)` resolving to a gradient in a hidden part of the page
 * would paint nothing.
 */
export function CarGlyph({ type, color, width = 56 }: CarValue & { width?: number }) {
  const shape = carShape(type);
  const art = CAR_ART[shape];
  const c = carColors(color);
  const id = `pt-car-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const r = art.tyre;
  return (
    <svg
      className="pt-car"
      width={width}
      height={width * 0.45}
      viewBox={CAR_VIEWBOX}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-paint`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.top} />
          <stop offset="0.55" stopColor={c.mid} />
          <stop offset="1" stopColor={c.low} />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={CAR_PARTS.glassTop} />
          <stop offset="0.42" stopColor={CAR_PARTS.glassLow} />
          <stop offset="0.5" stopColor={CAR_PARTS.glassShine} />
          <stop offset="0.58" stopColor={CAR_PARTS.glassLow} />
          <stop offset="1" stopColor={CAR_PARTS.glassLow} />
        </linearGradient>
      </defs>
      <ellipse cx={101} cy={83} rx={90} ry={4.5} fill={CAR_PARTS.shadow} opacity={0.16} />
      <path d={art.body} fill={`url(#${id}-paint)`} stroke={c.edge} strokeWidth={1} strokeLinejoin="round" />
      {art.windows.map((d) => (
        <path
          key={d}
          d={d}
          fill={`url(#${id}-glass)`}
          stroke={CAR_PARTS.trim}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      ))}
      {art.lines.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={c.edge}
          strokeOpacity={0.5}
          strokeWidth={1}
          strokeLinecap="round"
        />
      ))}
      {art.handles.map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x - 4.5}
          y={y - 1.2}
          width={9}
          height={2.4}
          rx={1.2}
          fill={c.edge}
          opacity={0.6}
        />
      ))}
      <path d={art.mirror} fill={c.low} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
      <path d={art.head} fill={CAR_PARTS.head} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
      <path d={art.tail} fill={CAR_PARTS.tail} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
      {art.wheels.map((x) => (
        <g key={x}>
          <circle cx={x} cy={70} r={r} fill={CAR_PARTS.tyre} />
          <circle cx={x} cy={70} r={r * 0.66} fill={CAR_PARTS.rimOuter} />
          <circle cx={x} cy={70} r={r * 0.58} fill={CAR_PARTS.hub} />
          {SPOKES.map((t) => (
            <line
              key={t}
              x1={x}
              y1={70}
              x2={x + Math.cos(t) * r * 0.58}
              y2={70 + Math.sin(t) * r * 0.58}
              stroke={CAR_PARTS.rimInner}
              strokeWidth={r * 0.16}
              strokeLinecap="round"
            />
          ))}
          <circle cx={x} cy={70} r={r * 0.18} fill={CAR_PARTS.rimOuter} />
        </g>
      ))}
    </svg>
  );
}

/**
 * «بطاقة السيارة» (owner's option 2 for the large places, DEC-643): the car drawn big on a soft tint of its own paint,
 * the plate under it (`children`: the page's own `PlateBadge` and chips) and one line (make · colour). Used where the
 * car is the subject (the offer, the current task, the vehicle, handover, parking and retrieval pages); lists and the
 * next task keep the compact `CarGlyph` beside the plate. The tint is the paint mixed into the surface, so it reads in
 * both themes.
 */
export function CarCard({
  type,
  color,
  caption,
  width = 168,
  children,
}: CarValue & { caption?: React.ReactNode; width?: number; children?: React.ReactNode }) {
  return (
    <div className="pt-carcard" style={{ '--pt-car-paint': carColors(color).mid } as React.CSSProperties}>
      <CarGlyph type={type} color={color} width={width} />
      {children ? <div className="pt-carcard__plate">{children}</div> : null}
      {caption ? <span className="pt-carcard__caption">{caption}</span> : null}
    </div>
  );
}
