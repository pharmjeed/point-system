/**
 * Text with the type scale of 03 §2.3 and IBM Plex (brand §5). Each weight is its own font family (no
 * `fontWeight` with custom fonts on Android). `textAlign: 'left'` means «start»: React Native swaps it in RTL
 * (`textStart`: unset on the web export, so the browser's start follows the text, DEC-551).
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { color, font, fontSize } from '../theme/tokens';
import { textStart } from './textStart';

export type TextVariant =
  | 'hero'
  | 'display'
  | 'title'
  | 'cardTitle'
  | 'body'
  | 'bodyStrong'
  | 'small'
  | 'smallStrong'
  | 'caption'
  | 'label'
  | 'mono';

const variants: Record<TextVariant, TextStyle> = {
  // V2-UX (DEC-571): the status title of the C-12 hero and the amounts of C-09/C-10
  hero: { ...fontSize['4xl'], fontFamily: font.bold },
  display: { ...fontSize['3xl'], fontFamily: font.bold },
  title: { ...fontSize['2xl'], fontFamily: font.bold },
  cardTitle: { ...fontSize.xl, fontFamily: font.semibold },
  body: { ...fontSize.base, fontFamily: font.regular },
  bodyStrong: { ...fontSize.base, fontFamily: font.semibold },
  small: { ...fontSize.sm, fontFamily: font.regular },
  smallStrong: { ...fontSize.sm, fontFamily: font.semibold },
  // tracker labels and badges only (03 §2.3: non-critical hints)
  caption: { ...fontSize.xs, fontFamily: font.medium },
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
  testID?: string;
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
  base: { textAlign: textStart, writingDirection: 'auto' },
  center: { textAlign: 'center' },
});
