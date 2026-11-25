/**
 * The customer's car as a side-view drawing in its own type and colour (DEC-642), drawn in the rendered style of
 * DEC-643: shaded paint (light on top, deeper at the sills), tinted glass with a reflection, lamps, a mirror, door
 * handles, silver rims and a soft shadow. A colour typed as free text, or none, draws the neutral grey car. The shapes
 * and colours are shared with the staff PWA (`@point/shared` vehicle-art). Decoration: the plate and the words next to
 * it say the same. Faces the reading end (mirrored in RTL).
 *
 * Each drawing has its own gradient ids (`useId`): in the web build every screen of the stack stays in one document,
 * and a `url(#id)` that resolved to a gradient inside a hidden screen would paint nothing.
 */
import {
  CAR_ART,
  CAR_PARTS,
  CAR_VIEWBOX,
  carColors,
  carShape,
  type CustomerVehicleType,
} from '@point/shared/customer';
import { useId } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { isRTL } from './direction';

const SPOKES = [0, 72, 144, 216, 288].map((deg) => (deg * Math.PI) / 180);

export function CarGlyph({
  type,
  paint: colorKey,
  width = 64,
}: {
  type: CustomerVehicleType | string | null | undefined;
  /** the colour key of 02 §8.4 (`white`), or free text */
  paint: string | null | undefined;
  width?: number;
}) {
  const shape = carShape(type);
  const art = CAR_ART[shape];
  const c = carColors(colorKey);
  const id = `car-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const r = art.tyre;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={isRTL() ? { transform: [{ scaleX: -1 }] } : undefined}
    >
      <Svg width={width} height={width * 0.45} viewBox={CAR_VIEWBOX}>
        <Defs>
          <LinearGradient id={`${id}-paint`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.top} />
            <Stop offset="0.55" stopColor={c.mid} />
            <Stop offset="1" stopColor={c.low} />
          </LinearGradient>
          <LinearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={CAR_PARTS.glassTop} />
            <Stop offset="0.42" stopColor={CAR_PARTS.glassLow} />
            <Stop offset="0.5" stopColor={CAR_PARTS.glassShine} />
            <Stop offset="0.58" stopColor={CAR_PARTS.glassLow} />
            <Stop offset="1" stopColor={CAR_PARTS.glassLow} />
          </LinearGradient>
        </Defs>
        <Ellipse cx={101} cy={83} rx={90} ry={4.5} fill={CAR_PARTS.shadow} opacity={0.16} />
        <Path
          d={art.body}
          fill={`url(#${id}-paint)`}
          stroke={c.edge}
          strokeWidth={1}
          strokeLinejoin="round"
        />
        {art.windows.map((d) => (
          <Path
            key={d}
            d={d}
            fill={`url(#${id}-glass)`}
            stroke={CAR_PARTS.trim}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        ))}
        {art.lines.map((d) => (
          <Path
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
          <Rect
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
        <Path d={art.mirror} fill={c.low} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
        <Path d={art.head} fill={CAR_PARTS.head} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
        <Path d={art.tail} fill={CAR_PARTS.tail} stroke={c.edge} strokeWidth={0.8} strokeLinejoin="round" />
        {art.wheels.map((x) => (
          <Wheel key={x} x={x} r={r} />
        ))}
      </Svg>
    </View>
  );
}

function Wheel({ x, r }: { x: number; r: number }) {
  return (
    <>
      <Circle cx={x} cy={70} r={r} fill={CAR_PARTS.tyre} />
      <Circle cx={x} cy={70} r={r * 0.66} fill={CAR_PARTS.rimOuter} />
      <Circle cx={x} cy={70} r={r * 0.58} fill={CAR_PARTS.hub} />
      {SPOKES.map((t) => (
        <Line
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
      <Circle cx={x} cy={70} r={r * 0.18} fill={CAR_PARTS.rimOuter} />
    </>
  );
}
