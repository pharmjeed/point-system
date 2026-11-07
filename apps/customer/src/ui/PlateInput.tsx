/**
 * Saudi plate entry (03 §3.7 `PlateInput` + `LetterPad`): a numeric field for up to 4 digits and a pad of the 17
 * plate letters with their Latin equivalent; the chosen letters show as on the plate. `PlateBadge` look: 2px frame,
 * digits and letters left to right inside `direction: ltr`.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import { PLATE_LETTER_PAD } from '../features/vehicle';
import { color, font, fontSize, layout, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Field } from './Field';

export interface PlateInputText {
  plate: string;
  digits: string;
  digitsPlaceholder: string;
  letters: string;
  lettersHint: string;
  clearLetters: string;
  digitsError: string | null;
  lettersError: string | null;
}

export function PlateInput({
  digits,
  letters,
  onDigits,
  onLetter,
  onBackspace,
  text,
}: {
  digits: string;
  letters: readonly string[];
  onDigits: (next: string) => void;
  onLetter: (letter: string) => void;
  onBackspace: () => void;
  text: PlateInputText;
}) {
  return (
    <View style={styles.wrap}>
      <AppText variant="label">{text.plate}</AppText>
      <View style={styles.badge} accessibilityLabel={`${digits} ${letters.join(' ')}`}>
        <AppText style={styles.badgeDigits}>{digits || '—'}</AppText>
        <View style={styles.divider} />
        <AppText style={styles.badgeLetters}>{letters.length ? letters.join(' ') : '— — —'}</AppText>
      </View>
      <Field
        label={text.digits}
        value={digits}
        onChangeText={onDigits}
        keyboardType="number-pad"
        placeholder={text.digitsPlaceholder}
        maxLength={8}
        error={text.digitsError}
        ltr
      />
      <AppText variant="label">{text.letters}</AppText>
      <AppText variant="small" tone={text.lettersError ? 'danger' : 'muted'}>
        {text.lettersError ?? text.lettersHint}
      </AppText>
      <View style={styles.pad}>
        {PLATE_LETTER_PAD.map((l) => (
          <Pressable
            key={l.ar}
            accessibilityRole="button"
            accessibilityLabel={`${l.ar} ${l.en}`}
            disabled={letters.length >= 3}
            onPress={() => onLetter(l.ar)}
            style={({ pressed }) => [
              styles.key,
              pressed && styles.keyPressed,
              letters.length >= 3 && styles.keyOff,
            ]}
          >
            <AppText style={styles.keyAr}>{l.ar}</AppText>
            <AppText style={styles.keyEn}>{l.en}</AppText>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.clearLetters}
          onPress={onBackspace}
          disabled={letters.length === 0}
          style={({ pressed }) => [styles.key, styles.keyWide, pressed && styles.keyPressed]}
        >
          <AppText style={styles.keyAr}>⌫</AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[2] },
  badge: {
    flexDirection: 'row',
    direction: 'ltr',
    alignSelf: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: color.text,
    borderRadius: radius.sm,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    gap: space[3],
    backgroundColor: color.surface,
  },
  badgeDigits: { fontFamily: font.monoSemibold, ...fontSize['2xl'] },
  badgeLetters: { fontFamily: font.bold, ...fontSize['2xl'] },
  divider: { width: 2, alignSelf: 'stretch', backgroundColor: color.text },
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], justifyContent: 'center' },
  key: {
    width: 52,
    minHeight: layout.touchMin + 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyWide: { width: 108 },
  keyPressed: { backgroundColor: color.primarySubtle },
  keyOff: { backgroundColor: color.surface2 },
  keyAr: { fontFamily: font.bold, ...fontSize.lg, textAlign: 'center' },
  keyEn: { fontFamily: font.mono, ...fontSize.xs, color: color.textMuted, textAlign: 'center' },
});
