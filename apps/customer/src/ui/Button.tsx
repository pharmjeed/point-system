/**
 * `Button` of 03 §3.1 for the customer app: `primary` (one per screen), `secondary` (border), `ghost`; `lg` = 56
 * for the main action, `md` = 48. `loading` shows «جارٍ…» with a spinner and blocks double presses.
 */
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { color, font, fontSize, layout, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading = false,
  loadingLabel,
  disabled = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' ? color.onPrimary : color.primaryText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { minHeight: size === 'lg' ? layout.buttonLg : 48 },
        variant === 'primary' && { backgroundColor: pressed ? color.primaryPressed : color.primary },
        variant === 'secondary' && styles.secondary,
        variant === 'secondary' && pressed && { backgroundColor: color.primarySubtle },
        variant === 'ghost' && pressed && { backgroundColor: color.primarySubtle },
        disabled && !loading && styles.disabled,
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={fg} /> : null}
        <AppText
          style={[
            size === 'lg' ? styles.lgText : styles.mdText,
            { color: disabled && !loading ? color.textDisabled : fg },
          ]}
        >
          {loading ? (loadingLabel ?? label) : label}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    paddingHorizontal: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  secondary: { borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface },
  disabled: { backgroundColor: color.surface2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  lgText: { ...fontSize.lg, fontFamily: font.bold },
  mdText: { ...fontSize.base, fontFamily: font.semibold },
});
