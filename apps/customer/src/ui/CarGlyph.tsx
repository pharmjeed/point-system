/**
 * The customer's car as a small side-view drawing in its own type and colour (DEC-642), next to its Saudi plate: the
 * body painted with the colour chosen on C-05, light glass, dark wheels, and an outline so a white or silver car keeps
 * its shape. A colour typed as free text, or none, draws the neutral body. The shapes and paints are shared with the
 * staff PWA (`@point/shared` vehicle-art). Decoration: the plate and the words next to it say the same.
 */
import {
  CAR_ART,
  CAR_VIEWBOX,
  carPaint,
  carShape,
  paintIsDark,
  type CustomerVehicleType,
} from '@point/shared/customer';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { color } from '../theme/tokens';
import { isRTL } from './direction';

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
  const art = CAR_ART[carShape(type)];
  const paint = carPaint(colorKey);
  const body = paint ?? color.surface2;
  const dark = paint ? paintIsDark(paint) : false;
  const glass = dark ? color.borderStrong : color.primarySubtle;
  const ink = color.text;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      // the car faces the reading end
      style={isRTL() ? { transform: [{ scaleX: -1 }] } : undefined}
    >
      <Svg width={width} height={width / 2} viewBox={CAR_VIEWBOX}>
        <Path d={art.body} fill={body} stroke={ink} strokeWidth={1.4} strokeLinejoin="round" />
        {art.windows.map((d) => (
          <Path key={d} d={d} fill={glass} stroke={ink} strokeWidth={0.9} strokeLinejoin="round" />
        ))}
        {art.lines.map((d) => (
          <Path key={d} d={d} stroke={ink} strokeWidth={1.1} strokeLinecap="round" />
        ))}
        {art.wheels.map((x) => (
          <Circle key={x} cx={x} cy={24} r={5.2} fill={ink} />
        ))}
        {art.wheels.map((x) => (
          <Circle key={`hub-${x}`} cx={x} cy={24} r={2} fill={color.borderStrong} />
        ))}
      </Svg>
    </View>
  );
}
