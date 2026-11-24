/**
 * The Saudi plate of C-05 as it looks on the car (owner's option 3, DEC-638): digits on the left and letters on the
 * right, the Arabic row above the Latin one, and the side band «السعودية · K S A» on the right edge. It fills as the
 * customer types in the two fields under it; an empty place shows a dash. Always drawn left to right, never
 * mirrored. The Arabic row shows the plate's own Arabic-Indic digits: it is a picture of the physical plate, the one
 * place the app shows them (every field and text stays in Western digits, DEC-17). One text for screen readers.
 */
import { StyleSheet, View } from 'react-native';
import { latinLetters } from '../features/vehicle';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

const toArabicIndic = (digits: string): string =>
  digits.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));

/**
 * Isolated left to right (U+2066 … U+2069): the Arabic-Indic digits are no strong direction of their own, and
 * the app's text follows the Arabic layout, so without it «١ ٢ ٣ ٤» would be drawn reversed.
 */
const ltr = (s: string): string => `\u2066${s}\u2069`;

const LINE = 3;
const EMPTY = '—';

export function SaudiPlate({
  digits,
  letters,
  country,
  label,
}: {
  digits: string;
  letters: readonly string[];
  /** «السعودية» */
  country: string;
  /** the plate as read aloud */
  label: string;
}) {
  const latin = latinLetters(letters);
  return (
    <View style={styles.plate} accessible accessibilityRole="text" accessibilityLabel={label}>
      <View style={styles.half}>
        <View style={styles.cell}>
          <AppText style={[styles.ar, !digits && styles.empty]}>
            {digits ? ltr(toArabicIndic(digits).split('').join(' ')) : EMPTY}
          </AppText>
        </View>
        <View style={[styles.cell, styles.below]}>
          <AppText style={[styles.en, !digits && styles.empty]}>{digits || EMPTY}</AppText>
        </View>
      </View>
      <View style={[styles.half, styles.next]}>
        <View style={styles.cell}>
          {/* the Arabic letters read right to left, as on the plate */}
          <AppText style={[styles.ar, styles.rtl, !letters.length && styles.empty]}>
            {letters.length ? letters.join(' ') : EMPTY}
          </AppText>
        </View>
        <View style={[styles.cell, styles.below]}>
          <AppText style={[styles.en, !latin && styles.empty]}>{latin || EMPTY}</AppText>
        </View>
      </View>
      <View style={[styles.band, styles.next]}>
        <AppText style={styles.country}>{country}</AppText>
        <AppText style={styles.ksa}>{'K\nS\nA'}</AppText>
        <View style={styles.dot} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: {
    flexDirection: 'row',
    direction: 'ltr',
    height: 132,
    borderWidth: LINE,
    borderColor: color.text,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  half: { flex: 1 },
  next: { borderLeftWidth: LINE, borderLeftColor: color.text },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  below: { borderTopWidth: LINE, borderTopColor: color.text },
  ar: { fontFamily: font.bold, ...fontSize['2xl'], color: color.text, textAlign: 'center' },
  rtl: { writingDirection: 'rtl' },
  en: {
    fontFamily: font.monoSemibold,
    ...fontSize['2xl'],
    color: color.text,
    letterSpacing: 3,
    textAlign: 'center',
  },
  empty: { color: color.textDisabled },
  band: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[2],
  },
  country: { fontFamily: font.bold, fontSize: 9, lineHeight: 12, color: color.text },
  ksa: {
    fontFamily: font.monoSemibold,
    fontSize: 13,
    lineHeight: 15,
    color: color.text,
    textAlign: 'center',
  },
  dot: { width: 9, height: 9, borderRadius: radius.full, backgroundColor: color.text },
});
