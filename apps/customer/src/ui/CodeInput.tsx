/**
 * Six-digit sign-in code (C-03), after `CodeInput` of 03 §3.11: IBM Plex Mono 600 / 24px boxes, numeric keypad,
 * paste supported, left to right. One hidden field holds the value; the boxes only show it. No automatic submit.
 */
import { useRef, type ComponentRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { CUSTOMER_OTP_LENGTH } from '@point/shared/customer';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';

export function CodeInput({
  value,
  onChange,
  label,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const cells = Array.from({ length: CUSTOMER_OTP_LENGTH }, (_, i) => value[i] ?? '');
  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false}>
      <View style={styles.row}>
        {cells.map((digit, i) => (
          <View
            key={i}
            style={[
              styles.cell,
              i === value.length && !disabled && styles.cellActive,
              invalid && styles.cellInvalid,
              disabled && styles.cellDisabled,
            ]}
          >
            <AppText style={styles.digit}>{digit}</AppText>
          </View>
        ))}
      </View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoFocus
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CUSTOMER_OTP_LENGTH + 4}
        accessibilityLabel={label}
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', direction: 'ltr', gap: space[2], justifyContent: 'center' },
  cell: {
    width: 48,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellActive: { borderColor: color.focus, borderWidth: 3 },
  cellInvalid: { borderColor: color.danger },
  cellDisabled: { backgroundColor: color.surface2 },
  digit: { fontFamily: font.monoSemibold, ...fontSize['2xl'], color: color.text, textAlign: 'center' },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
});
