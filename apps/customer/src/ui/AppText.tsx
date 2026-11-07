/**
 * Text with the type scale of 03 §2.3 and IBM Plex (brand §5). Each weight is its own font family (no
 * `fontWeight` with custom fonts on Android). `textAlign: 'left'` means «start»: React Native swaps it in RTL.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { color, font, fontSize } from '../theme/tokens';

export type TextVariant =
  'display' | 'title' | 'cardTitle' | 'body' | 'bodyStrong' | 'small' | 'label' | 'mono';

const variants: Record<TextVariant, TextStyle> = {
  display: { ...fontSize['3xl'], fontFamily: font.bold },
  title: { ...fontSize['2xl'], fontFamily: font.bold },
  cardTitle: { ...fontSize.xl, fontFamily: font.semibold },
  body: { ...fontSize.base, fontFamily: font.regular },
  bodyStrong: { ...fontSize.base, fontFamily: font.semibold },
  small: { ...fontSize.sm, fontFamily: font.regular },
  label: { ...fontSize.base, fontFamily: font.semibold },
  mono: { ...fontSize.base, fontFamily: font.mono },
};

export interface AppTextProps {
  children: ReactNode;
  variant?: TextVariant;
  tone?: 'default' | 'muted' | 'primary' | 'danger' | 'success' | 'inverse';
  center?: boolean;
  style?: StyleProp<TextStyle>;
  accessibilityRole?: 'header' | 'text' | 'alert';
  numberOfLines?: number;
}

const tones = {
  default: color.text,
  muted: color.textMuted,
  primary: color.primaryText,
  danger: color.dangerText,
  success: color.successText,
  inverse: color.textInverse,
} as const;

export function AppText({
  children,
  variant = 'body',
  tone = 'default',
  center,
  style,
  ...rest
}: AppTextProps) {
  return (
    <Text
      {...rest}
      style={[styles.base, variants[variant], { color: tones[tone] }, center && styles.center, style]}
      maxFontSizeMultiplier={1.6}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: { textAlign: 'left', writingDirection: 'auto' },
  center: { textAlign: 'center' },
});
