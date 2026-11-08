/**
 * `TextField` of 03 §3.10: label above, 48 high, 16px text, error below in `danger-text`. `ltr` isolates values
 * that read left to right (phone, plate digits) inside the RTL layout (03 §2.9).
 */
import type { ReactNode } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { textStart } from './textStart';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null;
  hint?: string;
  ltr?: boolean;
  /** Rendered before the input on the reading side (e.g. the `+966` prefix). */
  prefix?: ReactNode;
}

export function Field({ label, error, hint, ltr, prefix, ...input }: FieldProps) {
  return (
    <View style={styles.wrap}>
      <AppText variant="label">{label}</AppText>
      <View style={[styles.box, ltr && styles.ltr, !!error && styles.boxError]}>
        {prefix}
        <TextInput
          {...input}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={color.textMuted}
          style={[styles.input, ltr && styles.inputLtr]}
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
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[3],
    gap: space[2],
  },
  ltr: { direction: 'ltr' },
  boxError: { borderColor: color.danger },
  input: {
    flex: 1,
    ...fontSize.base,
    fontFamily: font.regular,
    color: color.text,
    paddingVertical: space[2],
    textAlign: textStart,
  },
  inputLtr: { fontFamily: font.mono, writingDirection: 'ltr' },
});
