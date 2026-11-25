/**
 * `PlateBadge` of 03 §3.7 for the customer app, drawn as the Saudi plate it is (DEC-642, the compact form of C-05's
 * `SaudiPlate`): digits on the left and letters on the right, the Arabic row above the Latin one, and the «KSA» band
 * on the right edge; left to right, never mirrored. The Arabic row shows the plate's own Arabic-Indic digits (a
 * picture of the physical plate, as on C-05); each digit is its own item so the layout never reverses them. A plate
 * that is not «digits letters» is shown whole. One text for screen readers (the plate as written).
 */
import { StyleSheet, View } from 'react-native';
import { latinLetters } from '../features/vehicle';
import { plateParts } from '../features/ux';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

const toArabicIndic = (d: string) => String.fromCharCode(0x0660 + Number(d));

export function PlateBadge({ plate, size = 'md' }: { plate: string; size?: 'md' | 'lg' }) {
  const clean = plate.replace(/[⁦-⁩]/g, '');
  const parts = plateParts(clean);
  const big = size === 'lg';
  const text = [styles.text, big && styles.textLg];
  if (!parts) {
    return (
      <View
        style={[styles.frame, big && styles.frameLg]}
        accessible
        accessibilityRole="text"
        accessibilityLabel={clean}
      >
        <View style={[styles.half, styles.whole]}>
          <AppText style={text}>{clean}</AppText>
        </View>
      </View>
    );
  }
  const letters = parts.letters.split(/\s+/).filter(Boolean);
  return (
    <View
      style={[styles.frame, big && styles.frameLg]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={clean}
    >
      <View style={styles.half}>
        <View style={[styles.cell, styles.row]}>
          {[...parts.digits].map((d, i) => (
            <AppText key={i} style={[...text, styles.ar]}>
              {toArabicIndic(d)}
            </AppText>
          ))}
        </View>
        <View style={[styles.cell, styles.below]}>
          <AppText style={[...text, styles.en]}>{parts.digits}</AppText>
        </View>
      </View>
      <View style={[styles.half, styles.next]}>
        <View style={styles.cell}>
          <AppText style={[...text, styles.ar, styles.rtl]}>{letters.join(' ')}</AppText>
        </View>
        <View style={[styles.cell, styles.below]}>
          <AppText style={[...text, styles.en]}>{latinLetters(letters)}</AppText>
        </View>
      </View>
      <View style={[styles.band, styles.next, big && styles.bandLg]}>
        <AppText style={styles.ksa}>{'K\nS\nA'}</AppText>
      </View>
    </View>
  );
}

const LINE = 2;

const styles = StyleSheet.create({
  frame: {
    flexDirection: 'row',
    direction: 'ltr',
    alignSelf: 'flex-start',
    alignItems: 'stretch',
    borderWidth: LINE,
    borderColor: color.text,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  frameLg: { borderRadius: radius.md },
  half: { minWidth: 52 },
  whole: { justifyContent: 'center', paddingHorizontal: space[2], paddingVertical: space[1] },
  next: { borderLeftWidth: LINE, borderLeftColor: color.text },
  cell: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2] },
  row: { flexDirection: 'row', direction: 'ltr', gap: space[1] },
  below: { borderTopWidth: LINE, borderTopColor: color.text },
  text: { fontFamily: font.bold, ...fontSize.sm, color: color.text, textAlign: 'center' },
  textLg: { ...fontSize.lg },
  ar: { fontFamily: font.bold },
  rtl: { writingDirection: 'rtl' },
  en: { fontFamily: font.monoSemibold, letterSpacing: 1 },
  band: { width: 16, alignItems: 'center', justifyContent: 'center' },
  bandLg: { width: 20 },
  ksa: { fontFamily: font.monoSemibold, fontSize: 8, lineHeight: 9, color: color.text, textAlign: 'center' },
});
