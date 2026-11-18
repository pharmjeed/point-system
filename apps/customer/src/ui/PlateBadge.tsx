/**
 * `PlateBadge` of 03 §3.7 for the customer app (V2-UX, DEC-578): a Saudi plate drawn as the design system's chip —
 * the digits (IBM Plex Mono) and the three letters in two boxes inside one dark frame, left to right as on the
 * plate, never mirrored. A plate that is not «digits letters» is shown whole. The chip is one text for screen
 * readers (the plate as written).
 */
import { StyleSheet, View } from 'react-native';
import { plateParts } from '../features/ux';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

export function PlateBadge({ plate, size = 'md' }: { plate: string; size?: 'md' | 'lg' }) {
  const parts = plateParts(plate.replace(/[⁦-⁩]/g, ''));
  const big = size === 'lg';
  return (
    <View
      style={[styles.frame, big && styles.frameLg]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={plate}
    >
      {parts ? (
        <>
          <View style={[styles.half, big && styles.halfLg]}>
            <AppText style={[styles.digits, big && styles.digitsLg]}>{parts.digits}</AppText>
          </View>
          <View style={styles.rule} />
          <View style={[styles.half, big && styles.halfLg]}>
            <AppText style={[styles.letters, big && styles.lettersLg]}>{parts.letters}</AppText>
          </View>
        </>
      ) : (
        <View style={[styles.half, big && styles.halfLg]}>
          <AppText style={[styles.digits, big && styles.digitsLg]}>{plate}</AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexDirection: 'row',
    direction: 'ltr',
    alignSelf: 'flex-start',
    alignItems: 'stretch',
    borderWidth: 2,
    borderColor: color.text,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  frameLg: { borderRadius: radius.md },
  half: { paddingHorizontal: space[2], paddingVertical: space[0.5], justifyContent: 'center' },
  halfLg: { paddingHorizontal: space[3], paddingVertical: space[1] },
  rule: { width: 2, backgroundColor: color.text },
  digits: { fontFamily: font.monoSemibold, ...fontSize.base, color: color.text, textAlign: 'center' },
  digitsLg: { ...fontSize.xl },
  letters: { fontFamily: font.bold, ...fontSize.base, color: color.text, textAlign: 'center' },
  lettersLg: { ...fontSize.xl },
});
