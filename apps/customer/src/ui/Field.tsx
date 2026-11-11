/**
 * `TextField` of 03 §3.10: label above, 48 high, 16px text, error below in `danger-text`. `ltr` isolates values
 * that read left to right (phone, plate digits) inside the RTL layout (03 §2.9).
 */
import { useState, type ReactNode } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { isRTL } from './direction';
import { Icon, type IconName } from './Icon';
import { textStart } from './textStart';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null;
  hint?: string;
  ltr?: boolean;
  /** Rendered before the input on the reading side (e.g. the `+966` prefix). */
  prefix?: ReactNode;
  /** V2-UX: a leading icon (the search field of C-07) */
  icon?: IconName;
  /** V2-UX: the large field of C-02 (the phone number) */
  large?: boolean;
}

export function Field({
  label,
  error,
  hint,
  ltr,
  prefix,
  icon,
  large,
  onFocus,
  onBlur,
  ...input
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <AppText variant="label">{label}</AppText>
      <View
        style={[
          styles.box,
          large && styles.boxLarge,
          ltr && styles.ltr,
          focused && styles.boxFocus,
          !!error && styles.boxError,
        ]}
      >
        {icon ? <Icon name={icon} size={20} tint={color.textMuted} /> : null}
        {prefix}
        <TextInput
          {...input}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={color.textMuted}
          style={[
            styles.input,
            // the web export: an empty browser input reads its placeholder left to right (`dir="auto"`); an Arabic
            // field starts on the right like its label (native already does)
            Platform.OS === 'web' && !ltr && isRTL() && styles.inputRtlWeb,
            ltr && styles.inputLtr,
            large && styles.inputLarge,
          ]}
        />
      </View>
      {error ? (
        <AppText variant="small" tone="danger" accessibilityRole="alert">
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="small" tone="muted">
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[1] },
  box: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[3],
    gap: space[2],
  },
  boxLarge: { minHeight: 64, borderRadius: radius.lg, paddingHorizontal: space[4] },
  boxFocus: { borderColor: color.focus, borderWidth: 2 },
  ltr: { direction: 'ltr' },
  boxError: { borderColor: color.danger },
  input: {
    flex: 1,
    // a browser input keeps an intrinsic width (its `size`): let the row decide (the web export at 360 px)
    minWidth: 0,
    // the box draws the focus (2 px `focus` border), not the browser's own outline (a `solid` 0 width: the browser's
    // `auto` focus style ignores a width)
    outlineStyle: 'solid',
    outlineWidth: 0,
    ...fontSize.base,
    fontFamily: font.regular,
    color: color.text,
    paddingVertical: space[2],
    textAlign: textStart,
  },
  inputRtlWeb: { textAlign: 'right' },
  inputLtr: { fontFamily: font.mono, writingDirection: 'ltr' },
  inputLarge: { ...fontSize['2xl'], letterSpacing: 1 },
});
