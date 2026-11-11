/**
 * `Button` of 03 §3.1 for the customer app: `primary` (one per screen), `secondary` (border), `ghost`; `lg` = 56
 * for the main action, `md` = 48 (V2-UX, DEC-575: no customer target under 48). `loading` shows «جارٍ…» with a
 * spinner and blocks double presses. V2-UX (DEC-572 … DEC-574): an optional leading icon, the pressed scale of
 * `Touchable`, a soft shadow under the primary action, and a light haptic tap on primary presses.
 */
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { color, font, fontSize, layout, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { Touchable } from './Touchable';

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
  icon?: IconName;
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
  icon,
}: ButtonProps) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' ? color.onPrimary : color.primaryText;
  const tint = disabled && !loading ? color.textDisabled : fg;
  return (
    <Touchable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      feedback={variant === 'primary' ? 'tap' : 'none'}
      pressScale={inactive ? 1 : 0.98}
      style={({ pressed }) => [
        styles.base,
        { minHeight: size === 'lg' ? layout.buttonLg : space[12] },
        variant === 'primary' && [
          styles.primary,
          { backgroundColor: pressed ? color.primaryPressed : color.primary },
        ],
        variant === 'secondary' && styles.secondary,
        variant === 'secondary' && pressed && { backgroundColor: color.primarySubtle },
        variant === 'ghost' && pressed && { backgroundColor: color.primarySubtle },
        disabled && !loading && styles.disabled,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : icon ? (
          <Icon name={icon} size={20} tint={tint} />
        ) : null}
        <AppText style={[size === 'lg' ? styles.lgText : styles.mdText, { color: tint }]}>
          {loading ? (loadingLabel ?? label) : label}
        </AppText>
      </View>
    </Touchable>
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
  primary: { boxShadow: shadow.md },
  secondary: { borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface },
  disabled: { backgroundColor: color.surface2, boxShadow: 'none', borderColor: color.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  lgText: { ...fontSize.lg, fontFamily: font.bold },
  mdText: { ...fontSize.base, fontFamily: font.semibold },
});
