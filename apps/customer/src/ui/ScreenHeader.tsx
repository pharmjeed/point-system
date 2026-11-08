/**
 * The title row of a sub-screen (C-07, C-08, C-15, C-19, C-20): a back action on the reading side and the screen
 * title as the header (03 §5: one header per screen, back reachable with a 44+ target). The arrow follows the
 * layout direction (React Native mirrors `row` in RTL, so «→» reads as «back» in Arabic and «←» in English).
 */
import { I18nManager, Pressable, StyleSheet, View } from 'react-native';
import { color, font, fontSize, layout, space } from '../theme/tokens';
import { AppText } from './AppText';

export function ScreenHeader({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        hitSlop={8}
        style={({ pressed }) => [styles.back, pressed && { backgroundColor: color.primarySubtle }]}
      >
        <AppText style={styles.arrow}>{I18nManager.isRTL ? '→' : '←'}</AppText>
      </Pressable>
      <AppText variant="title" accessibilityRole="header" style={styles.title} numberOfLines={2}>
        {title}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  back: {
    minWidth: layout.touchMin,
    minHeight: layout.touchMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: layout.touchMin / 2,
  },
  arrow: { fontFamily: font.bold, ...fontSize.xl, color: color.primaryText },
  title: { flex: 1 },
});
