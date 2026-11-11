/**
 * `CountdownRing` of 03 §3.5 for the customer app (V2-UX, DEC-578): the time left of the C-11 code as a ring that
 * empties towards the next code, with the seconds inside (IBM Plex Mono). Driven by the code's own clock
 * (`secondsLeft` of features/pass.ts), redrawn every second — no local timer of its own. Decorative for screen
 * readers: the sentence «يتغير الرمز بعد … ث» next to it says the same.
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { color, font, fontSize } from '../theme/tokens';
import { AppText } from './AppText';

export function CountdownRing({ left, total, size = 44 }: { left: number; total: number; size?: number }) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const share = Math.max(0, Math.min(1, left / total));
  return (
    <View
      style={{ width: size, height: size }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} style={styles.svg}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color.surface2} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={left <= 5 ? color.warning : color.primary}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - share)}
          // start at twelve o'clock
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <AppText style={styles.value}>{String(left)}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  svg: { position: 'absolute' },
  center: { alignItems: 'center', justifyContent: 'center' },
  value: { fontFamily: font.monoSemibold, ...fontSize.sm, color: color.text, textAlign: 'center' },
});
